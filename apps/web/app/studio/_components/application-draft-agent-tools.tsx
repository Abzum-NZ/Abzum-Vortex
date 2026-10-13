"use client";
import { WebMcpStatus, type ApplicationWebMcpRuntime } from "@vortex/ui";
import { useCallback, useMemo, useRef, useState } from "react";
import { applicationSourceDocumentSchema, describeFailure, type ImmutablePlatformBlockCatalogue } from "@vortex/platform/schema";
import {
  describeStudioCompositionPalette,
  describeStudioCompositionRemoval,
  describeStudioCompositionScalarSettings,
  describeStudioCompositionSettings,
  projectStudioSemanticOutline,
  type StudioApplicationDraftHistoryController,
  type StudioApplicationDraftSaveOutcome,
  type StudioCompositionCommand,
  type StudioCompositionCommandResult,
  type StudioCompositionContext,
  type StudioSemanticOutlineNode,
  type StudioSemanticSelection,
} from "@vortex/ui/studio";
import { z } from "zod";
import { WebMcpAdapter, type WebMcpToolDescriptor } from "../../_components/webmcp-adapter";
import { applyStudioItemLabels } from "../_lib/application-item-labels";
import { conflictMessage, refusalMessage } from "./studio-refusal-messages";

type ToolName = "read_application_draft" | "rename_application_item" | "add_placement" | "change_placement_settings"
  | "remove_placement" | "save_application_draft";
type StudioApplicationTool = WebMcpToolDescriptor & Readonly<{ name: ToolName; input: z.ZodType }>;

const alias = (what: string) => applicationSourceDocumentSchema.shape.root_alias.describe(what);
const textValue = z.object({ kind: z.literal("text"), value: z.string() }).strict();
const booleanValue = z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict();
const choiceValue = z.object({ kind: z.literal("choice"), value: z.string() }).strict();
const addSettingValue = z.discriminatedUnion("kind", [textValue, booleanValue, choiceValue]);
const settingValue = z.discriminatedUnion("kind", [textValue, booleanValue, choiceValue,
  z.object({ kind: z.literal("number"), value: z.number() }).strict()]);

const inputSchema = (schema: z.ZodType) => {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  const variants = (json.oneOf ?? json.anyOf ?? []).filter((variant) => typeof variant === "object");
  if (json.properties !== undefined || variants.length === 0)
    return { type: "object", properties: json.properties ?? {}, required: json.required ?? [], additionalProperties: false };
  // A discriminated union has no top-level properties: advertise the union of its variants' properties, the
  // discriminator as an enum, and as required only what every variant requires (zod still validates each variant).
  const properties: Record<string, unknown> = {};
  for (const variant of variants) for (const [key, value] of Object.entries(variant.properties ?? {})) {
    const known = properties[key] as { const?: unknown; enum?: unknown[] } | undefined;
    const incoming = value as { const?: unknown };
    properties[key] = known?.const !== undefined && incoming.const !== undefined
      ? { type: "string", enum: [known.const, incoming.const] }
      : known?.enum !== undefined && incoming.const !== undefined ? { ...known, enum: [...known.enum, incoming.const] } : value;
  }
  const required = Object.keys(properties).filter((key) => variants.every((variant) => variant.required?.includes(key)));
  return { type: "object", properties, required, additionalProperties: false };
};
const tool = (name: ToolName, description: string, input: z.ZodType, readOnly: boolean): StudioApplicationTool =>
  ({ name, description, input, readOnly, inputSchema: inputSchema(input) });

const applicationTools: readonly StudioApplicationTool[] = [
  tool("read_application_draft", "Read the Application draft as it is in the workspace now: revision, unsaved state, the outline of pages, placements, flows and navigation, and for each page the released components that can be added and for each placement its declared settings. Call it first and after any refusal.", z.object({}).strict(), true),
  tool("rename_application_item", "Rename the Application (with its description) or one page, the same edit as the inspector's Apply labels. It changes the workspace draft; call save_application_draft to persist it.",
    z.discriminatedUnion("target", [
      z.object({ target: z.literal("application"), name: z.string().min(1), description: z.string().min(1) }).strict(),
      z.object({ target: z.literal("page"), pageAlias: alias("The page alias from read_application_draft."), name: z.string().min(1) }).strict(),
    ]), false),
  tool("add_placement", "Add a released component to a page's main region, the same edit as the palette's Add component. Take blockId and releaseVersion from the page's components in read_application_draft; give only settings the component declares. It changes the workspace draft; call save_application_draft to persist it.",
    z.object({
      pageAlias: alias("The page alias from read_application_draft."), blockId: z.string().min(1), releaseVersion: z.string().min(1),
      placementAlias: alias("A new, unique alias for the placement."), settings: z.record(z.string(), addSettingValue).optional(),
    }).strict(), false),
  tool("change_placement_settings", "Set or clear the declared settings of a placement, the same edit as the placement's text and declared settings forms. Settings you do not name keep their current values. It changes the workspace draft; call save_application_draft to persist it.",
    z.object({
      placementAlias: alias("The placement alias from read_application_draft."),
      set: z.record(z.string(), settingValue).optional().describe("Setting key to its new value; text settings use kind text, the others kind boolean, choice or number."),
      clear: z.array(z.string()).optional().describe("Keys of optional settings to omit again."),
    }).strict().refine((value) => value.set !== undefined || value.clear !== undefined, { message: "Give set or clear." }), false),
  tool("remove_placement", "Remove an unreferenced released placement, the same edit as the Remove placement control. It changes the workspace draft; call save_application_draft to persist it.",
    z.object({ placementAlias: alias("The placement alias from read_application_draft.") }).strict(), false),
  tool("save_application_draft", "Save the workspace draft into the saved Application draft, the same action as Save draft. Nothing is published.", z.object({}).strict(), false),
];
const descriptors = applicationTools.map(({ name, description, inputSchema: schema, readOnly }) => ({ name, description, inputSchema: schema, readOnly }));

const collect = (node: StudioSemanticOutlineNode, kind: StudioSemanticSelection["kind"]): StudioSemanticSelection[] =>
  [...(node.selection?.kind === kind ? [node.selection] : []), ...node.children.flatMap((child) => collect(child, kind))];
const trimOutline = (node: StudioSemanticOutlineNode): object => ({
  kind: node.kind, label: node.label,
  ...(node.selection === null ? {} : { selection: node.selection }),
  ...(node.children.length === 0 ? {} : { children: node.children.map(trimOutline) }),
});

const saveMessage = (outcome: StudioApplicationDraftSaveOutcome): string =>
  outcome.kind === "conflict" ? `${conflictMessage(outcome.reason, "Nothing was saved.")} Call read_application_draft.`
    : outcome.kind === "refused" ? refusalMessage(outcome.reason, "Nothing was saved.")
      : outcome.kind === "busy" ? "A save is already in progress."
        : "The save could not be verified, so nothing is known to be saved. Call read_application_draft.";

/** Registers the Application draft tools in the browser agent interface; each one runs the edit its workspace control runs. */
export function ApplicationDraftAgentTools({ organizationId, history, catalogue, readLifetime, blockedReason, select, command, save }: {
  organizationId: string;
  history: StudioApplicationDraftHistoryController;
  catalogue: ImmutablePlatformBlockCatalogue;
  readLifetime: () => number;
  /** Why a person's unapplied edit or a running request stops the agent from changing the draft, if it does. */
  blockedReason: () => string | undefined;
  select: (next: StudioSemanticSelection | null) => boolean;
  command: (expected: StudioCompositionContext, expectedSelection: StudioSemanticSelection,
    command: StudioCompositionCommand) => StudioCompositionCommandResult["kind"];
  save: () => Promise<StudioApplicationDraftSaveOutcome | undefined>;
}) {
  const [runtime, setRuntime] = useState<ApplicationWebMcpRuntime>();
  const running = useRef(false);
  const tools = useMemo(() => descriptors, []);

  const contextNow = useCallback((): StudioCompositionContext => {
    const state = history.getState();
    return { organizationId, rootId: state.rootId, key: state.source.key, draftRevision: state.draftRevision,
      localLifetime: readLifetime(), catalogue, source: state.source };
  }, [history, organizationId, readLifetime, catalogue]);

  const describeNow = useCallback(() => {
    const state = history.getState();
    const context = contextNow();
    const outline = projectStudioSemanticOutline({ rootId: state.rootId, source: applicationSourceDocumentSchema.parse(state.source) });
    return {
      draftRevision: state.draftRevision, unsavedChanges: state.isDirty,
      application: { name: state.source.body.name, description: state.source.body.description },
      outline: trimOutline(outline),
      pages: collect(outline, "page").flatMap((page) => {
        const palette = describeStudioCompositionPalette(context, page);
        return [{ page, addableComponents: palette.kind === "available"
          ? palette.choices.map((choice) => ({ blockId: choice.blockId, releaseVersion: choice.releaseVersion, key: choice.key,
            name: choice.name, slots: choice.slots, settings: choice.properties })) : palette.kind }];
      }),
      placements: collect(outline, "placement").map((placement) => {
        const text = describeStudioCompositionSettings(context, placement);
        const scalar = describeStudioCompositionScalarSettings(context, placement);
        const removal = describeStudioCompositionRemoval(context, placement);
        return { placement,
          textSettings: text.kind === "available" ? { declared: text.properties, current: text.settings } : text.kind,
          declaredSettings: scalar.kind === "available" ? { declared: scalar.properties, current: scalar.settings } : scalar.kind,
          removable: removal.kind === "available" ? true : removal.kind === "blocked" ? `blocked: ${removal.reason}` : false };
      }),
    };
  }, [history, contextNow]);

  const applyCommand = useCallback((target: StudioSemanticSelection, what: StudioCompositionCommand): StudioCompositionCommandResult["kind"] => {
    if (!select(target)) return "invalid";
    return command(contextNow(), target, what);
  }, [select, command, contextNow]);

  const commandOutcome = useCallback((kind: StudioCompositionCommandResult["kind"], operation: string, invalidHint: string) => {
    if (kind === "applied") return { outcome: "applied", message: "Applied to the workspace draft. It is not saved until you call save_application_draft.", ...describeNow() };
    console.error(`[studio] agent ${operation} refused: STUDIO_AGENT_COMPOSITION_${kind.toUpperCase()}`);
    return { outcome: kind, message: kind === "stale" ? "The draft or selection changed while the edit was checked. Nothing changed; call read_application_draft and retry."
      : kind === "unsupported" ? "This release or region is unsupported for this edit. Nothing changed." : invalidHint };
  }, [describeNow]);

  const invoke = useCallback(async (descriptor: WebMcpToolDescriptor, candidate: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (signal?.aborted) return { outcome: "cancelled", message: "The call was cancelled before anything changed." };
    const found = applicationTools.find((item) => item.name === descriptor.name);
    if (found === undefined) return { outcome: "refused", reason: "UNKNOWN_TOOL" };
    const parsed = found.input.safeParse(candidate);
    if (!parsed.success) return { outcome: "invalid_input", issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) };
    if (running.current) return { outcome: "busy", message: "Another agent call is still running. Wait for it to finish." };
    running.current = true;
    try {
      if (found.name === "read_application_draft") return { outcome: "read", ...describeNow() };
      const blocked = blockedReason();
      if (blocked !== undefined) return { outcome: "blocked", message: blocked };
      if (found.name === "save_application_draft") {
        const outcome = await save();
        if (outcome === undefined) return { outcome: "blocked", message: "The workspace could not save right now. Nothing was saved; call read_application_draft." };
        if (outcome.kind !== "saved") {
          console.error(`[studio] agent save refused: STUDIO_AGENT_SAVE_${outcome.kind.toUpperCase()}${"reason" in outcome && outcome.reason !== undefined ? `:${outcome.reason}` : ""}`);
          return { outcome: outcome.kind, ...("reason" in outcome && outcome.reason !== undefined ? { reason: outcome.reason } : {}), message: saveMessage(outcome) };
        }
        return { outcome: "saved", ...describeNow() };
      }
      if (found.name === "rename_application_item") {
        const input = parsed.data as { target: "application" | "page"; pageAlias?: string; name: string; description?: string };
        const target: StudioSemanticSelection = input.target === "application"
          ? { kind: "application", applicationRootId: history.getState().rootId } : { kind: "page", pageAlias: input.pageAlias ?? "" };
        if (input.target === "page" && !history.getState().source.body.pages.some((page) => page.id === input.pageAlias))
          return { outcome: "not_found", message: "That page is not in the current draft. Call read_application_draft." };
        const result = applyStudioItemLabels(history.getState().source, target, input.name,
          input.description ?? history.getState().source.body.description);
        if (result.kind === "not_found") return { outcome: "not_found", message: "That item is not in the current draft. Call read_application_draft." };
        if (result.kind === "invalid") return { outcome: "validation_failed", issues: result.issues, message: "Enter a valid non-empty label and description within their limits." };
        if (!select(target) || !history.edit(result.source)) {
          console.error("[studio] agent rename was not accepted by the draft history");
          return { outcome: "invalid", message: "The draft history did not accept this change, so nothing was changed." };
        }
        return { outcome: "applied", message: "Applied to the workspace draft. It is not saved until you call save_application_draft.", ...describeNow() };
      }
      if (found.name === "add_placement") {
        const input = parsed.data as { pageAlias: string; blockId: string; releaseVersion: string; placementAlias: string;
          settings?: Record<string, { kind: "text" | "boolean" | "choice"; value: string | boolean }> };
        if (!history.getState().source.body.pages.some((page) => page.id === input.pageAlias))
          return { outcome: "not_found", message: "That page is not in the current draft. Call read_application_draft." };
        const kind = applyCommand({ kind: "page", pageAlias: input.pageAlias }, { kind: "add", blockId: input.blockId,
          releaseVersion: input.releaseVersion, alias: input.placementAlias, settings: (input.settings ?? {}) as never });
        return commandOutcome(kind, "add_placement", "No component was added. Use a unique alias and valid declared settings of a release listed in read_application_draft.");
      }
      const input = parsed.data as { placementAlias: string; set?: Record<string, z.infer<typeof settingValue>>; clear?: string[] };
      const placement: StudioSemanticSelection = { kind: "placement", placementAlias: input.placementAlias };
      if (!collect(projectStudioSemanticOutline({ rootId: history.getState().rootId,
        source: applicationSourceDocumentSchema.parse(history.getState().source) }), "placement")
        .some((item) => item.kind === "placement" && item.placementAlias === input.placementAlias))
        return { outcome: "not_found", message: "That placement is not in the current draft. Call read_application_draft." };
      if (found.name === "remove_placement") {
        const removal = describeStudioCompositionRemoval(contextNow(), placement);
        if (removal.kind === "blocked") return { outcome: "blocked", reason: removal.reason, message: removal.reason === "required_slot"
          ? "This slot requires its remaining placement." : removal.reason === "unresolved_target"
            ? "A declared placement target cannot be resolved safely. Removal is unavailable." : "A Flow still refers to this placement. Removal is unavailable." };
        return commandOutcome(applyCommand(placement, { kind: "remove" }), "remove_placement",
          "Removal is available only for supported presentation placements in private list, detail or dashboard main regions. Nothing changed.");
      }
      // change_placement_settings: the forms send the complete supplied set, so merge onto the current one.
      const set = input.set ?? {};
      const clear = new Set(input.clear ?? []);
      const context = contextNow();
      const text = describeStudioCompositionSettings(context, placement);
      const scalar = describeStudioCompositionScalarSettings(context, placement);
      const textKeys = new Set(text.kind === "available" ? text.properties.map((property) => property.key) : []);
      const scalarKeys = new Set(scalar.kind === "available" ? scalar.properties.map((property) => property.key) : []);
      const unknown = [...Object.keys(set), ...clear].filter((key) => !textKeys.has(key) && !scalarKeys.has(key));
      if (unknown.length > 0) return { outcome: "validation_failed", issues: unknown.map((key) => ({ path: key, message: "This placement declares no such setting." })) };
      const mismatched = Object.entries(set).filter(([key, value]) => textKeys.has(key) ? value.kind !== "text" : value.kind === "text");
      if (mismatched.length > 0) return { outcome: "validation_failed", issues: mismatched.map(([key]) => ({ path: key, message: "The value kind does not match the declared setting." })) };
      let last: StudioCompositionCommandResult["kind"] = "applied";
      if (text.kind === "available" && [...textKeys].some((key) => key in set || clear.has(key))) {
        const settings = Object.fromEntries(Object.entries({ ...text.settings, ...set }).filter(([key]) => textKeys.has(key) && !clear.has(key)));
        last = applyCommand(placement, { kind: "settings", settings: settings as never });
      }
      if (last === "applied" && scalar.kind === "available" && [...scalarKeys].some((key) => key in set || clear.has(key))) {
        const settings = Object.fromEntries(Object.entries({ ...scalar.settings, ...set }).filter(([key]) => scalarKeys.has(key) && !clear.has(key)));
        last = applyCommand(placement, { kind: "scalar_settings", settings: settings as never });
      }
      return commandOutcome(last, "change_placement_settings",
        "No change was applied. Supply valid declared values within their limits and every required setting.");
    } catch (error) {
      console.error(`[studio] agent application tool failed: ${describeFailure(error)}`);
      return { outcome: "unavailable", message: "The request did not complete, so the outcome is unknown. Call read_application_draft to see the workspace draft." };
    } finally {
      running.current = false;
    }
  }, [applyCommand, blockedReason, commandOutcome, contextNow, describeNow, history, save, select]);

  return <>
    <WebMcpAdapter contextKey={`${organizationId}:${history.getState().rootId}`} tools={tools} onInvoke={invoke} onStatusChange={setRuntime} />
    {runtime === undefined ? null : <WebMcpStatus runtime={runtime} />}
  </>;
}
