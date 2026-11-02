"use client";
import { WebMcpStatus, type ApplicationWebMcpRuntime } from "@vortex/ui";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  applicationSourceDocumentSchema,
  canonicalJson,
  describeFailure,
  moduleFieldTypeLabels,
  sourceApplicationBodySchema,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import {
  describeStudioCompositionAddTargets,
  describeStudioCompositionRemoval,
  describeStudioCompositionSettings,
  projectStudioSemanticOutline,
  type StudioCompositionOutcome,
  type StudioBorrowedChoices,
  type StudioQueryChoice,
  type StudioCompositionCommand,
  type StudioCompositionSettings,
  type StudioCompositionContext,
  type StudioCompositionDestination,
  type StudioSemanticOutlineNode,
  type StudioSemanticSelection,
  studioPlacementReferenceSentence,
} from "@vortex/ui/studio";
import { z } from "zod";
import { WebMcpAdapter, type WebMcpToolDescriptor } from "../../_components/webmcp-adapter";
import { applyStudioItemLabels } from "@vortex/ui/studio";
import { previewStudioApplication } from "../preview-actions";
import { reviewStudioApplicationAuthoring } from "../application-authoring-actions";
import {
  applicationAuthoringTools,
  type ApplicationAuthoringToolName,
} from "../_lib/application-authoring-tools";
import { previewProblem } from "./studio-refusal-messages";
import { studioActionTokens, type StudioActionToken } from "../../_lib/studio-action-tokens";
import type { StudioDraft } from "./use-studio-draft";

/** The saved draft a preview runs; null while edits or requests are pending. */
export type SavedDraftContext = Readonly<{
  organizationId: string;
  rootId: string;
  draftRevision: number;
  source: ApplicationSourceDocument;
}>;

type ToolName =
  | ApplicationAuthoringToolName
  | "list_module_fields"
  | "read_application_draft"
  | "rename_application_item"
  | "add_placement"
  | "change_placement_settings"
  | "remove_placement"
  | "preview_saved_application"
  | "start_application_action";
type StudioApplicationTool = WebMcpToolDescriptor & Readonly<{ name: ToolName; input: z.ZodType }>;

const alias = (what: string) => applicationSourceDocumentSchema.shape.root_alias.describe(what);
/**
 * One typed setting value as read_application_draft shows it: `{ kind, ... }` of the setting's
 * declared kind (a text is `{ kind: "text", value }`, a field reference `{ kind: "field_reference",
 * field: "<module>:<record>.<field>" }`, a list `{ kind: "list", items: [...] }`, a group
 * `{ kind: "group", properties: {...} }`). The composition command judges it against the declaration.
 */
const settingValue = z.object({ kind: z.string().min(1) }).passthrough();

const inputSchema = (schema: z.ZodType) => {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  const variants = (json.oneOf ?? json.anyOf ?? []).filter(
    (variant) => typeof variant === "object",
  );
  // A recursive input (a JSON value) is advertised through references; its definitions travel with it.
  const definitions = json.$defs === undefined ? {} : { $defs: json.$defs };
  if (json.properties !== undefined || variants.length === 0)
    return {
      type: "object",
      properties: json.properties ?? {},
      required: json.required ?? [],
      additionalProperties: false,
      ...definitions,
    };
  // A discriminated union has no top-level properties: advertise the union of its variants' properties, the
  // discriminator as an enum, and as required only what every variant requires (zod still validates each variant).
  const properties: Record<string, unknown> = {};
  for (const variant of variants)
    for (const [key, value] of Object.entries(variant.properties ?? {})) {
      const known = properties[key] as { const?: unknown; enum?: unknown[] } | undefined;
      const incoming = value as { const?: unknown };
      properties[key] =
        known?.const !== undefined && incoming.const !== undefined
          ? { type: "string", enum: [known.const, incoming.const] }
          : known?.enum !== undefined && incoming.const !== undefined
            ? { ...known, enum: [...known.enum, incoming.const] }
            : value;
    }
  const required = Object.keys(properties).filter((key) =>
    variants.every((variant) => variant.required?.includes(key)),
  );
  return { type: "object", properties, required, additionalProperties: false, ...definitions };
};
const tool = (
  name: ToolName,
  description: string,
  input: z.ZodType,
  readOnly: boolean,
): StudioApplicationTool => ({
  name,
  description,
  input,
  readOnly,
  inputSchema: inputSchema(input),
});

const applicationTools: readonly StudioApplicationTool[] = [
  ...Object.entries(applicationAuthoringTools).map(([name, definition]) =>
    tool(
      name as ApplicationAuthoringToolName,
      definition.description,
      definition.input,
      definition.readOnly,
    ),
  ),
  tool(
    "list_module_fields",
    "Read the owned data model, including record and field aliases, current field configurations, queries and setting declarations for each field type. Borrowed modules are edited by their owning application. Call before adding or changing a module field.",
    z.object({}).strict(),
    true,
  ),
  tool(
    "read_application_draft",
    "Read the Application draft as it is in the workspace now: revision, whether an edit is still being saved, the outline of pages, placements, flows and navigation, for each page the places a new block can go with the blocks each admits, the queries a data block can read, and for each placement its declared settings. Call it first and after any refusal.",
    z.object({}).strict(),
    true,
  ),
  tool(
    "rename_application_item",
    "Rename the Application (with its description) or one page, the same edit as the inspector's name fields. Studio saves the change automatically.",
    z.discriminatedUnion("target", [
      z
        .object({
          target: z.literal("application"),
          name: z.string().min(1),
          description: z.string().min(1),
        })
        .strict(),
      z
        .object({
          target: z.literal("page"),
          pageAlias: alias("The page alias from read_application_draft."),
          name: z.string().min(1),
        })
        .strict(),
    ]),
    false,
  ),
  tool(
    "add_placement",
    "Add a new block to one place on a page, the same edit as dropping it from the Blocks palette. Take the place (area and destination) and the block's blockId and releaseVersion from the page's addTargets in read_application_draft. Give its setup settings (each required one without a default, as typed values), and for a block that needs a query, one of the queries listed. Every other setting starts with its default. Studio saves the change automatically.",
    z
      .object({
        pageAlias: alias("The page alias from read_application_draft."),
        area: z.string().min(1),
        destination: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("root") }).strict(),
          z
            .object({
              kind: z.literal("child"),
              parentAlias: z.string().min(1),
              slotKey: z.string().min(1),
            })
            .strict(),
        ]),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Position in the place; omitted adds the block last."),
        blockId: z.string().min(1),
        releaseVersion: z.string().min(1),
        settings: z
          .record(z.string(), settingValue)
          .optional()
          .describe("Setting key to its typed value, of the kind its declaration has."),
        query: z.string().min(1).optional().describe("The query reference a data block reads."),
      })
      .strict(),
    false,
  ),
  tool(
    "change_placement_settings",
    "Set or clear the declared settings of a placement, or choose the query a data block reads, the same edit as the inspector's Settings form. Settings you do not name keep their current values. Studio saves the change automatically.",
    z
      .object({
        placementAlias: alias("The placement alias from read_application_draft."),
        set: z
          .record(z.string(), settingValue)
          .optional()
          .describe(
            "Setting key to its new typed value, as read_application_draft shows the current ones.",
          ),
        clear: z
          .array(z.string())
          .optional()
          .describe("Keys of settings to leave unset again, so their defaults apply."),
        query: z
          .string()
          .min(1)
          .optional()
          .describe("For a data block: one of the queries read_application_draft lists."),
      })
      .strict()
      .refine(
        (value) =>
          value.set !== undefined || value.clear !== undefined || value.query !== undefined,
        { message: "Give set, clear or query." },
      ),
    false,
  ),
  tool(
    "remove_placement",
    "Remove an unreferenced released placement, the same edit as the Remove placement control. Studio saves the change automatically.",
    z
      .object({ placementAlias: alias("The placement alias from read_application_draft.") })
      .strict(),
    false,
  ),
  tool(
    "preview_saved_application",
    "Run the saved draft as an isolated preview of the application, the same action as Preview, and report the address it runs at. Its pages, navigation, forms and flows run on a copy of the organisation's records; nothing it saves reaches the installed application. It replaces this application's previous preview. It first waits for the latest edits to be saved; name the exact draftRevision read_application_draft shows once they are. Nothing is published or installed.",
    z
      .object({
        draftRevision: z
          .number()
          .int()
          .describe("The saved draft revision from read_application_draft."),
      })
      .strict(),
    false,
  ),
  tool(
    "start_application_action",
    "Start one of this application's App Store actions, the same flow its button runs: publish the saved draft, or install or upgrade it. It first waits for the latest edits to be saved, then opens that action's first dialog over the editor (the review, then the confirmation or form). The person completes or cancels it there; nothing is published or installed until they do.",
    z
      .object({
        action: z.enum(studioActionTokens).describe("Which action's flow to start."),
      })
      .strict(),
    false,
  ),
];
const descriptors = applicationTools.map(
  ({ name, description, inputSchema: schema, readOnly }) => ({
    name,
    description,
    inputSchema: schema,
    readOnly,
  }),
);

const collect = (
  node: StudioSemanticOutlineNode,
  kind: StudioSemanticSelection["kind"],
): StudioSemanticSelection[] => [
  ...(node.selection?.kind === kind ? [node.selection] : []),
  ...node.children.flatMap((child) => collect(child, kind)),
];
const trimOutline = (node: StudioSemanticOutlineNode): object => ({
  kind: node.kind,
  label: node.label,
  ...(node.selection === null ? {} : { selection: node.selection }),
  ...(node.children.length === 0 ? {} : { children: node.children.map(trimOutline) }),
});

/** Registers the Application draft tools in the browser agent interface; each one runs the edit its workspace control runs. */
export function ApplicationDraftAgentTools({
  draft,
  command,
  readQueries,
  readSavedDraft,
  startAction,
}: {
  /** The workspace's one draft: the agent edits it through the same envelope as the person. */
  draft: StudioDraft;
  command: (
    expected: StudioCompositionContext,
    expectedSelection: StudioSemanticSelection,
    command: StudioCompositionCommand,
  ) => StudioCompositionOutcome;
  /** The application's queries and the borrowed choices read for this invocation, with their display names. */
  readQueries: (borrowed: StudioBorrowedChoices | null) => readonly StudioQueryChoice[];
  /** The saved draft the preview runs; null while edits or requests are pending. */
  readSavedDraft: () => SavedDraftContext | null;
  /** Saves the latest edits, then opens one App Store action flow over the editor. */
  startAction: (action: StudioActionToken) => Promise<boolean>;
}) {
  const [runtime, setRuntime] = useState<ApplicationWebMcpRuntime>();
  const running = useRef(false);
  const tools = useMemo(() => descriptors, []);
  const { history, organizationId } = draft;
  const latest = useRef(draft);
  latest.current = draft;
  const actions = useRef({
    command,
    readQueries,
    readSavedDraft,
    startAction,
  });
  actions.current = {
    command,
    readQueries,
    readSavedDraft,
    startAction,
  };
  const authoring = useRef<Awaited<ReturnType<StudioDraft["loadAuthoringResources"]>>>(null);
  const readLifetime = useCallback(() => latest.current.lifetime, []);
  const blockedReason = useCallback(() => latest.current.blockedReason(), []);
  const select = useCallback((next: StudioSemanticSelection) => latest.current.select(next), []);

  const contextNow = useCallback((): StudioCompositionContext => {
    const state = history.getState();
    return {
      organizationId,
      rootId: state.rootId,
      key: state.source.key,
      draftRevision: state.draftRevision,
      localLifetime: readLifetime(),
      catalogue: authoring.current?.catalogue ?? latest.current.view.catalogue,
      source: state.source,
      borrowed: authoring.current?.borrowedChoices ?? latest.current.view.borrowedChoices,
    };
  }, [history, organizationId, readLifetime]);

  const describeNow = useCallback(() => {
    const state = history.getState();
    const context = contextNow();
    const outline = projectStudioSemanticOutline({
      rootId: state.rootId,
      source: applicationSourceDocumentSchema.parse(state.source),
      catalogue: context.catalogue,
    });
    return {
      draftRevision: state.draftRevision,
      source: state.source,
      savingEdits: state.isDirty || state.isSaving,
      application: { name: state.source.body.name, description: state.source.body.description },
      outline: trimOutline(outline),
      pages: collect(outline, "page").flatMap((page) => {
        const places =
          page.kind === "page"
            ? describeStudioCompositionAddTargets(context, {
                kind: "page",
                pageAlias: page.pageAlias,
              })
            : ({ kind: "invalid" } as const);
        return [
          {
            page,
            addTargets:
              places.kind === "available"
                ? places.targets.map((target) => ({
                    area: target.area,
                    destination: target.destination,
                    label: target.label,
                    blocks: target.choices.map((choice) => ({
                      blockId: choice.blockId,
                      releaseVersion: choice.releaseVersion,
                      key: choice.key,
                      name: choice.name,
                      description: choice.description,
                      group: choice.groupLabel,
                      needsQuery: choice.needsQuery,
                      setup: choice.setup,
                      ...(choice.unavailable === undefined
                        ? {}
                        : { unavailable: choice.unavailable }),
                    })),
                  }))
                : places.kind,
          },
        ];
      }),
      queries: actions.current.readQueries(authoring.current?.borrowedChoices ?? null),
      placements: collect(outline, "placement").map((placement) => {
        const settings = describeStudioCompositionSettings(context, placement);
        const removal = describeStudioCompositionRemoval(context, placement);
        return {
          placement,
          settings:
            settings.kind === "available"
              ? {
                  declared: settings.properties,
                  current: settings.settings,
                  readsQuery: settings.readsQuery,
                  query: settings.query,
                }
              : settings.kind,
          removable:
            removal.kind === "available"
              ? true
              : removal.kind === "invalid"
                ? false
                : `${removal.kind}: ${removal.reason}`,
        };
      }),
    };
  }, [history, contextNow]);

  const applyCommand = useCallback(
    (target: StudioSemanticSelection, what: StudioCompositionCommand): StudioCompositionOutcome => {
      if (!select(target)) return { kind: "invalid" };
      return actions.current.command(contextNow(), target, what);
    },
    [select, contextNow],
  );

  const commandOutcome = useCallback(
    (result: StudioCompositionOutcome, operation: string, invalidHint: string) => {
      const kind = result.kind;
      if (kind === "applied")
        return {
          outcome: "applied",
          message: "Applied to the workspace draft. Studio saves it automatically.",
          ...describeNow(),
        };
      console.error(
        `[studio] agent ${operation} refused: STUDIO_AGENT_COMPOSITION_${kind.toUpperCase()}`,
      );
      return {
        outcome: kind,
        message:
          kind === "stale"
            ? "The draft or selection changed while the edit was checked. Nothing changed; call read_application_draft and retry."
            : kind === "unsupported"
              ? "This release or region is unsupported for this edit. Nothing changed."
              : (result.reason ?? invalidHint),
      };
    },
    [describeNow],
  );

  const invoke = useCallback(
    async (
      descriptor: WebMcpToolDescriptor,
      candidate: unknown,
      signal?: AbortSignal,
    ): Promise<unknown> => {
      if (signal?.aborted)
        return { outcome: "cancelled", message: "The call was cancelled before anything changed." };
      const found = applicationTools.find((item) => item.name === descriptor.name);
      if (found === undefined) return { outcome: "refused", reason: "UNKNOWN_TOOL" };
      const parsed = found.input.safeParse(candidate);
      if (!parsed.success)
        return {
          outcome: "invalid_input",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        };
      if (running.current)
        return {
          outcome: "busy",
          message: "Another agent call is still running. Wait for it to finish.",
        };
      running.current = true;
      try {
        if (
          [
            "read_application_draft",
            "list_module_fields",
            "rename_application_item",
            "add_placement",
            "remove_placement",
            "change_placement_settings",
          ].includes(found.name)
        ) {
          authoring.current = await latest.current.loadAuthoringResources();
          if (signal?.aborted)
            return {
              outcome: "cancelled",
              message: "The call was cancelled before anything changed.",
            };
          if (authoring.current === null)
            return {
              outcome: "unavailable",
              message: "The current draft's authoring choices could not be loaded. Try again.",
            };
        }
        if (found.name === "read_application_draft") return { outcome: "read", ...describeNow() };
        if (found.name === "list_module_fields")
          return {
            outcome: "read",
            draftRevision: history.getState().draftRevision,
            savingEdits: history.getState().isDirty || history.getState().isSaving,
            modules: history.getState().source.body.modules,
            fieldTypes: moduleFieldTypeLabels,
            modulesSchema: z.toJSONSchema(sourceApplicationBodySchema.shape.modules, {
              io: "input",
              unrepresentable: "any",
            }),
          };
        const blocked = blockedReason();
        if (blocked !== undefined) return { outcome: "blocked", message: blocked };
        if (Object.hasOwn(applicationAuthoringTools, found.name)) {
          if (!(await latest.current.flush()))
            return {
              outcome: "blocked",
              message: "Save the pending edits before authoring. Call read_application_draft.",
            };
          const saved = latest.current.readSaved();
          const input = parsed.data as { draftRevision: number };
          if (input.draftRevision !== saved.draftRevision)
            return {
              outcome: "conflict",
              message:
                "The saved revision changed. Call read_application_draft before editing again.",
            };
          const lifetime = latest.current.lifetime;
          const expected = history.getState().source;
          if (signal?.aborted) return { outcome: "cancelled" };
          const reviewed = await reviewStudioApplicationAuthoring(organizationId, {
            rootId: saved.rootId,
            expectedSavedSourceFingerprint: saved.sourceFingerprint,
            tool: found.name,
            input: parsed.data,
          });
          if (signal?.aborted)
            return {
              outcome: "cancelled",
              message: "Cancelled before the reviewed edit was applied.",
            };
          if (reviewed.kind !== "available") return { ...reviewed, outcome: reviewed.kind };
          if (
            latest.current.lifetime !== lifetime ||
            !latest.current.isActive() ||
            latest.current.readSaved().draftRevision !== saved.draftRevision ||
            canonicalJson(history.getState().source) !== canonicalJson(expected)
          )
            return {
              outcome: "conflict",
              message:
                "The workspace changed during review. Nothing was applied. Call read_application_draft.",
            };
          const edited = latest.current.run(
            () => ({ kind: "edit", source: reviewed.source, result: true }),
            { expected },
          );
          if (edited.kind !== "done") return { outcome: "blocked", message: edited.message };
          const savedEdit = await latest.current.flush();
          return {
            outcome: savedEdit ? "saved" : "not_saved",
            message: savedEdit
              ? "Saved into the application draft."
              : "Applied to the workspace, but saving was not confirmed. Read the draft and resolve its save status before continuing.",
            ...describeNow(),
          };
        }
        if (found.name === "start_application_action") {
          const input = parsed.data as { action: StudioActionToken };
          const started = await actions.current.startAction(input.action);
          return started
            ? {
                outcome: "started",
                message: `The ${input.action} action is open over the editor. The person confirms or cancels it there; nothing has changed yet.`,
              }
            : {
                outcome: "blocked",
                message:
                  "The action was not started: the latest edits are not saved, or the App Store could not be read. Call read_application_draft.",
              };
        }
        if (found.name === "preview_saved_application") {
          const input = parsed.data as { draftRevision: number };
          const context = (await latest.current.flush()) ? actions.current.readSavedDraft() : null;
          if (context === null)
            return {
              outcome: "blocked",
              message:
                "Preview needs the saved draft, and the latest edits are not saved. Call read_application_draft.",
            };
          if (input.draftRevision !== context.draftRevision) {
            console.error("[studio] agent preview refused: STUDIO_AGENT_PREVIEW_STALE_REVISION");
            return {
              outcome: "conflict",
              message: `The saved draft is at revision ${context.draftRevision}, not ${input.draftRevision}. Nothing was previewed. Call read_application_draft.`,
            };
          }
          const result = await previewStudioApplication(organizationId, {
            rootId: context.rootId,
            draftRevision: context.draftRevision,
          });
          // The preview runs the saved draft it was started for: read the workspace draft again, and
          // never report it for a draft that moved while the request ran.
          const current = actions.current.readSavedDraft();
          if (result.kind !== "provisioned") {
            const reason = result.kind === "refused" ? result.reason : undefined;
            console.error(
              `[studio] agent preview unavailable: STUDIO_AGENT_PREVIEW_${result.kind.toUpperCase()}${reason === undefined ? "" : `:${reason}`}`,
            );
            return {
              outcome: result.kind === "conflict" ? "conflict" : "unavailable",
              ...(reason === undefined ? {} : { reason }),
              message: previewProblem(result),
            };
          }
          if (
            current === null ||
            current.rootId !== context.rootId ||
            current.draftRevision !== context.draftRevision
          ) {
            console.error("[studio] agent preview refused: STUDIO_AGENT_PREVIEW_DRAFT_CHANGED");
            return {
              outcome: "conflict",
              message:
                "The workspace draft changed while the preview was being prepared, so the preview shows the earlier draft. Call read_application_draft and retry.",
            };
          }
          return {
            outcome: "previewed",
            draftRevision: result.draftRevision,
            address: result.href,
            expiresAt: result.expiresAt,
            message: `The saved draft runs as a preview at ${result.href} until ${result.expiresAt}. Nothing was published or installed.`,
          };
        }
        if (found.name === "rename_application_item") {
          const input = parsed.data as {
            target: "application" | "page";
            pageAlias?: string;
            name: string;
            description?: string;
          };
          const target: StudioSemanticSelection =
            input.target === "application"
              ? { kind: "application", applicationRootId: history.getState().rootId }
              : { kind: "page", pageAlias: input.pageAlias ?? "" };
          if (
            input.target === "page" &&
            !history.getState().source.body.pages.some((page) => page.id === input.pageAlias)
          )
            return {
              outcome: "not_found",
              message: "That page is not in the current draft. Call read_application_draft.",
            };
          const result = applyStudioItemLabels(
            history.getState().source,
            target,
            input.name,
            input.description ?? history.getState().source.body.description,
          );
          if (result.kind === "not_found")
            return {
              outcome: "not_found",
              message: "That item is not in the current draft. Call read_application_draft.",
            };
          if (result.kind === "invalid")
            return {
              outcome: "validation_failed",
              issues: result.issues,
              message: "Enter a valid non-empty label and description within their limits.",
            };
          const edited = select(target)
            ? latest.current.run(() => ({ kind: "edit", source: result.source, result: true }))
            : null;
          if (edited?.kind !== "done") {
            console.error("[studio] agent rename was not accepted by the draft history");
            return {
              outcome: "invalid",
              message: edited?.message ?? "That item cannot be selected, so nothing was changed.",
            };
          }
          return {
            outcome: "applied",
            message: "Applied to the workspace draft. Studio saves it automatically.",
            ...describeNow(),
          };
        }
        if (found.name === "add_placement") {
          const input = parsed.data as {
            pageAlias: string;
            area: string;
            destination: StudioCompositionDestination;
            index?: number;
            blockId: string;
            releaseVersion: string;
            settings?: StudioCompositionSettings;
            query?: string;
          };
          if (!history.getState().source.body.pages.some((page) => page.id === input.pageAlias))
            return {
              outcome: "not_found",
              message: "That page is not in the current draft. Call read_application_draft.",
            };
          const outcome = applyCommand(
            { kind: "page", pageAlias: input.pageAlias },
            {
              kind: "add",
              owner: { kind: "page", pageAlias: input.pageAlias },
              area: input.area,
              destination: input.destination,
              index: input.index ?? Number.MAX_SAFE_INTEGER,
              blockId: input.blockId,
              releaseVersion: input.releaseVersion,
              settings: input.settings ?? {},
              query: input.query ?? null,
            },
          );
          return commandOutcome(
            outcome,
            "add_placement",
            "No block was added. Use a place and block listed in read_application_draft, with its setup settings and, for a data block, one of the listed queries.",
          );
        }
        const input = parsed.data as {
          placementAlias: string;
          set?: Record<string, unknown>;
          clear?: string[];
          query?: string;
        };
        const placement: StudioSemanticSelection = {
          kind: "placement",
          placementAlias: input.placementAlias,
        };
        if (
          !collect(
            projectStudioSemanticOutline({
              rootId: history.getState().rootId,
              source: applicationSourceDocumentSchema.parse(history.getState().source),
              catalogue: contextNow().catalogue,
            }),
            "placement",
          ).some(
            (item) => item.kind === "placement" && item.placementAlias === input.placementAlias,
          )
        )
          return {
            outcome: "not_found",
            message: "That placement is not in the current draft. Call read_application_draft.",
          };
        if (found.name === "remove_placement") {
          const removal = describeStudioCompositionRemoval(contextNow(), placement);
          if (removal.kind === "blocked")
            return {
              outcome: "blocked",
              reason: removal.reason,
              message:
                removal.reason === "required_slot"
                  ? "This slot requires its remaining placement."
                  : removal.reason === "content_outlet"
                    ? "This placement holds a content outlet of its layout. Retarget the outlet first."
                    : removal.reason === "unresolved_target"
                      ? "A declared placement target cannot be resolved safely. Removal is unavailable."
                      : `${studioPlacementReferenceSentence(removal)} Removal is unavailable.`,
            };
          return commandOutcome(
            applyCommand(placement, { kind: "remove" }),
            "remove_placement",
            "Removal is available only for supported presentation placements in a layout or in private list, detail or dashboard main regions. Nothing changed.",
          );
        }
        // change_placement_settings: the Settings form sends the complete set, so merge onto the current one.
        const set = input.set ?? {};
        const clear = new Set(input.clear ?? []);
        const context = contextNow();
        const current = describeStudioCompositionSettings(context, placement);
        if (current.kind !== "available")
          return commandOutcome(
            { kind: current.kind },
            "change_placement_settings",
            "This placement's settings can't be read. Nothing changed.",
          );
        const declared = new Set(current.properties.map((property) => property.key));
        const unknown = [...Object.keys(set), ...clear].filter((key) => !declared.has(key));
        if (unknown.length > 0)
          return {
            outcome: "validation_failed",
            issues: unknown.map((key) => ({
              path: key,
              message: "This placement declares no such setting.",
            })),
          };
        if (input.query !== undefined && !current.readsQuery)
          return {
            outcome: "validation_failed",
            issues: [{ path: "query", message: "This placement reads no query." }],
          };
        const settings = Object.fromEntries(
          Object.entries({ ...current.settings, ...set }).filter(([key]) => !clear.has(key)),
        );
        return commandOutcome(
          applyCommand(placement, {
            kind: "settings",
            settings: settings as StudioCompositionSettings,
            query: input.query ?? current.query,
          }),
          "change_placement_settings",
          "No change was applied. Supply valid declared values within their limits and every required setting.",
        );
      } catch (error) {
        console.error(`[studio] agent application tool failed: ${describeFailure(error)}`);
        return {
          outcome: "unavailable",
          message:
            "The request did not complete, so the outcome is unknown. Call read_application_draft to see the workspace draft.",
        };
      } finally {
        authoring.current = null;
        running.current = false;
      }
    },
    [
      applyCommand,
      blockedReason,
      commandOutcome,
      contextNow,
      describeNow,
      history,
      organizationId,
      select,
    ],
  );

  return (
    <>
      <WebMcpAdapter
        contextKey={`${organizationId}:${history.getState().rootId}`}
        tools={tools}
        onInvoke={invoke}
        onStatusChange={setRuntime}
      />
      {runtime === undefined ? null : <WebMcpStatus runtime={runtime} />}
    </>
  );
}
