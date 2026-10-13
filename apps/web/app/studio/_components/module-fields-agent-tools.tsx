"use client";
import { WebMcpStatus, type ApplicationWebMcpRuntime } from "@vortex/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeFailure, sameId, storedModuleDefinitionDraftSchema, type DefinitionValidationResult } from "@vortex/platform/schema";
import type { StoredModuleDefinitionDraft } from "@web/platform-server";
import { z } from "zod";
import { WebMcpAdapter, type WebMcpToolDescriptor } from "../../_components/webmcp-adapter";
import { offeredFieldTypes, type OfferedFieldType } from "../../_lib/studio-module-field-shape";
import { reopenModuleFields, saveModuleFieldChange } from "../modules/[organizationId]/[moduleRootId]/fields/actions";

type ToolName = "list_module_fields" | "add_module_field" | "change_module_field";
type StudioFieldTool = WebMcpToolDescriptor & Readonly<{ name: ToolName; input: z.ZodType }>;

/** The tools take their field types from the same schema probe the editor's type list comes from. */
const studioFieldTools = (offered: readonly OfferedFieldType[]): readonly StudioFieldTool[] => {
  const types = offered.map((item) => item.type);
  const typeSchema = types.length === 0 ? z.string() : z.enum(types as [string, ...string[]]);
  const withLength = offered.filter((item) => item.needsMaxLength).map((item) => item.type);
  const lengthNote = withLength.length === 0 ? "" : ` Types that need maxLength (the longest value, in characters): ${withLength.join(", ")}.`;
  const recordAlias = z.string().min(1).describe("The recordAlias from list_module_fields.");
  const inputSchema = (schema: z.ZodType) => {
    const json = z.toJSONSchema(schema, { io: "input" });
    return { type: "object", properties: json.properties ?? {}, required: json.required ?? [], additionalProperties: false };
  };
  const tool = (name: ToolName, description: string, input: z.ZodType, readOnly: boolean): StudioFieldTool =>
    ({ name, description, input, readOnly, inputSchema: inputSchema(input) });
  return [
    tool("list_module_fields", "Reload the saved Module draft and list its record types and fields (aliases, keys, labels, types, required flags), the field types this Module accepts, and the draft revision. Call it first, and again after a stale-draft refusal.", z.object({}).strict(), true),
    tool("add_module_field", `Add a field to a record type of the Module draft. It is saved into the draft at once; nothing is published. The stable key is made from the label.${lengthNote}`,
      z.object({
        recordAlias, label: z.string().describe("Label shown to people filling in the form."),
        type: typeSchema, required: z.boolean(), maxLength: z.number().int().optional(),
      }).strict(), false),
    tool("change_module_field", `Change the label, type or required flag of an existing field. Fields you leave out stay as they are. Changing the type replaces the field's type settings and removes its default value.${lengthNote}`,
      z.object({
        recordAlias, fieldAlias: z.string().min(1).describe("The fieldAlias from list_module_fields."),
        label: z.string().optional(), type: typeSchema.optional(), required: z.boolean().optional(), maxLength: z.number().int().optional(),
      }).strict().refine((value) => value.label !== undefined || value.type !== undefined || value.required !== undefined,
        { message: "Give at least one of label, type or required to change." }), false),
  ];
};

const locatedErrors = (validation: DefinitionValidationResult) => validation.errors.map((error) => ({
  code: error.code, message: error.message, guidance: error.guidance,
  location: error.location?.segments.map((segment) => `${segment.kind}:${segment.key}`).join(" / "),
}));

const describeDraft = (draft: StoredModuleDefinitionDraft) => ({
  draftRevision: draft.draftRevision,
  offeredFieldTypes: offeredFieldTypes(draft.source),
  recordTypes: draft.source.body.record_types.map((record) => ({
    recordAlias: record.id, key: record.key, name: record.name,
    fields: record.fields.map((field) => ({ fieldAlias: field.id, key: field.key, label: field.label, type: field.type, required: field.required })),
  })),
});

/** Registers the Studio field tools in the browser agent interface; each one calls the action its editor control calls. */
export function ModuleFieldsAgentTools({ draft, onDraftChange, onWorkingChange }: {
  draft: StoredModuleDefinitionDraft;
  onDraftChange: (draft: StoredModuleDefinitionDraft) => void;
  /** Reports whether an agent call is changing the draft, so the human editors can wait for it. */
  onWorkingChange: (working: boolean) => void;
}) {
  const draftRef = useRef(draft);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  const [runtime, setRuntime] = useState<ApplicationWebMcpRuntime>();
  const offered = useMemo(() => offeredFieldTypes(draft.source), [draft.source]);
  const tools = useMemo(() => studioFieldTools(offered).map(({ name, description, inputSchema, readOnly }) => ({ name, description, inputSchema, readOnly })), [offered]);

  const working = runtime?.working !== undefined;
  useEffect(() => { onWorkingChange(working); }, [onWorkingChange, working]);

  const adopt = useCallback((next: StoredModuleDefinitionDraft) => { draftRef.current = next; onDraftChange(next); }, [onDraftChange]);

  const invoke = useCallback(async (descriptor: WebMcpToolDescriptor, candidate: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (signal?.aborted) return { outcome: "cancelled", message: "The call was cancelled before anything was saved." };
    const current = draftRef.current;
    const tool = studioFieldTools(offeredFieldTypes(current.source)).find((item) => item.name === descriptor.name);
    if (tool === undefined) return { outcome: "refused", reason: "UNKNOWN_TOOL" };
    const parsed = tool.input.safeParse(candidate);
    if (!parsed.success) return { outcome: "invalid_input", issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) };
    try {
      if (tool.name === "list_module_fields") {
        const result = await reopenModuleFields(current.organizationId, current.rootId);
        if (result.kind === "available") {
          adopt(result.draft);
          return { outcome: "read", ...describeDraft(result.draft) };
        }
        if (result.kind === "temporarily_unavailable")
          return { outcome: "unavailable", message: "The saved draft could not be read because of a platform problem, not because of permissions. Try again in a moment." };
        return { outcome: result.kind, reason: "reason" in result ? result.reason : undefined };
      }
      const input = parsed.data as { recordAlias: string; fieldAlias?: string; label?: string; type?: string; required?: boolean; maxLength?: number };
      const existing = input.fieldAlias === undefined ? undefined
        : current.source.body.record_types.find((item) => item.id === input.recordAlias)?.fields.find((item) => item.id === input.fieldAlias);
      if (input.fieldAlias !== undefined && existing === undefined)
        return { outcome: "not_found", message: "That record type or field is not in the current draft. Call list_module_fields." };
      const type = input.type ?? existing?.type ?? "";
      if (existing !== undefined && existing.type === type && input.maxLength !== undefined)
        return { outcome: "invalid_input", issues: [{ path: "maxLength",
          message: "maxLength is only taken with a type change here; the field keeps its type, so nothing was saved. Leave maxLength out." }] };
      const result = await saveModuleFieldChange(current.organizationId, {
        rootId: current.rootId,
        expectedDraftRevision: current.draftRevision,
        expectedSavedSourceFingerprint: current.sourceFingerprint,
        recordAlias: input.recordAlias,
        ...(existing === undefined ? {} : { fieldAlias: existing.id }),
        label: input.label ?? existing?.label ?? "",
        type,
        required: input.required ?? existing?.required ?? false,
        ...(input.maxLength === undefined || existing?.type === type ? {} : { maxLength: input.maxLength }),
      });
      // A server action cannot be aborted once sent: a cancel that arrives now cannot undo the write.
      const cancelledAfterSave = signal?.aborted === true;
      if (result.kind === "available") {
        const saved = storedModuleDefinitionDraftSchema.safeParse(result.draft);
        if (!saved.success || !sameId(saved.data.rootId, current.rootId) || saved.data.draftRevision !== current.draftRevision + 1) {
          if (!saved.success) console.error(`[studio] agent field change answer is not a Module draft: ${describeFailure(saved.error)}`);
          else console.error("[studio] agent field change answer did not match the draft identity or revision");
          return { outcome: "unavailable", message: "The server's answer could not be matched to this draft. Call list_module_fields before continuing." };
        }
        adopt(saved.data);
        if (cancelledAfterSave) console.error("[studio] agent field change was cancelled after the server saved it; the saved draft was adopted");
        return {
          outcome: "saved", ...describeDraft(saved.data),
          ...(cancelledAfterSave ? { message: "The call was cancelled while the change was being saved, but the change WAS saved into the draft." } : {}),
        };
      }
      if (result.kind === "validation_failed") return { outcome: "validation_failed", errors: locatedErrors(result.validation) };
      if (result.kind === "temporarily_unavailable")
        return { outcome: "unavailable", message: "The change could not be saved because of a platform problem, not because of permissions. Nothing was saved; try again in a moment." };
      return {
        outcome: result.kind, reason: result.reason,
        message: result.reason === "DEFINITION_DRAFT_STALE_OR_MISSING"
          ? "The draft changed since it was last read. Nothing was saved; call list_module_fields and repeat the change." : "Nothing was saved.",
      };
    } catch (error) {
      console.error(`[studio] agent field tool failed: ${describeFailure(error)}`);
      return { outcome: "unavailable", message: "The request did not complete, so the outcome is unknown. Call list_module_fields to see the saved draft." };
    }
  }, [adopt]);

  return <>
    <WebMcpAdapter contextKey={`${draft.organizationId}:${draft.rootId}`} tools={tools} onInvoke={invoke} onStatusChange={setRuntime} />
    {runtime === undefined ? null : <div className="mx-auto max-w-3xl px-6 pt-4"><WebMcpStatus runtime={runtime} /></div>}
  </>;
}
