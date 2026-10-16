import "server-only";

import {
  applicationContentSchema,
  applicationRootIdSchema,
  compiledItemTree,
  compiledPageShellId,
  compiledPageZones,
  type CompiledItem,
  flowTaskChildLists,
  flowTaskRegistry,
  revisionSchema,
  type ApplicationContent,
  type ComponentFlowBinding,
  type ComponentSemanticEventKind,
  type FlowDefinition,
  type FlowEffectKind,
  type FlowTask,
  type SessionContext,
} from "../schema";
import { z } from "zod";
import type { ApplicationDraftCompilation } from "./definition-publication";
import type { DefinitionPublicationFailureCode } from "./definition-publication-contracts";
import { DefinitionCompilationError } from "./compilation-error";
import { DefinitionError } from "./definition-error";

/** Compiles an exact Application draft into an inert preview artifact. */

export const applicationPreviewBreakpoints = ["desktop", "tablet", "phone"] as const;
export type ApplicationPreviewBreakpoint = (typeof applicationPreviewBreakpoints)[number];

export const applicationPreviewDataSurfaces = ["display", "control"] as const;

const previewDataEntrySchema = z
  .object({
    placementId: z.string().min(1).max(200),
    surface: z.enum(applicationPreviewDataSurfaces),
    value: z.unknown(),
  })
  .strict();

/**
 * Selects one Application root and one exact draft revision. A page and guided step may be named;
 * when they are absent the application home page and its first ordered step are used. Sample data
 * is only ever a labelled preview value, never installed application authority.
 */
export const applicationPreviewRequestSchema = z
  .object({
    kind: z.literal("application"),
    rootId: applicationRootIdSchema,
    draftRevision: revisionSchema,
    pageId: z.string().min(1).max(200).optional(),
    activeStepId: z.string().min(1).max(200).optional(),
    breakpoint: z.enum(applicationPreviewBreakpoints).default("desktop"),
    sampleData: z.array(previewDataEntrySchema).max(512).default([]),
  })
  .strict();

export type ApplicationPreviewRequest = z.infer<typeof applicationPreviewRequestSchema>;

/** The exact compiled draft the preview renders. It is distinct from any installed release. */
export type ApplicationPreviewDraft = Readonly<{
  rootId: string;
  draftRevision: number;
  /** The compiled canonical content, exactly as Definition compilation produced it. */
  content: ApplicationContent;
  /** The root's current published release revision, echoed only to label what preview ignores. */
  currentReleaseRevision: number | null;
}>;

type ApplicationPreviewPage = Readonly<{
  pageId: string;
  composition: ApplicationContent["pages"][number]["composition"];
  steps?: readonly Readonly<{ id: string; name: string; summary: boolean }>[];
}>;

/** The requested compiled draft page and its shells for the preview renderer. */
export type ApplicationPreviewComposition = Readonly<{
  platformBlockDependencies: ApplicationContent["platformBlockDependencies"];
  shells: ApplicationContent["shells"];
  pages: readonly ApplicationPreviewPage[];
  theme: ApplicationContent["theme"];
}>;

/** The simulated effect a substituted flow task would have performed in live rendering. */
export type ApplicationPreviewSimulatedEffect =
  "read" | "change" | "background_start" | "form_interaction";

/**
 * One simulated step of a flow. Each registered task that reads, changes, starts background work
 * or shows a form is one step: `nodeId` is its task id, `nodeKind` is always `task` and
 * `targetKind` is its registered task type, for example `record.save`. The wire shape is the one
 * the browser hook already decodes, so a flow's tasks reach it without a second contract.
 */
export type ApplicationPreviewFlowNodeSimulation = Readonly<{
  nodeId: string;
  nodeKind: "task";
  targetKind: string;
  simulatedEffect: ApplicationPreviewSimulatedEffect;
  label: string;
}>;

/** One component flow binding with every effectful task replaced by explicit simulations. */
export type ApplicationPreviewInteraction = Readonly<{
  bindingId: string;
  controlId: string;
  eventId: string;
  event: ComponentSemanticEventKind;
  flowKind: "application_owned";
  flowId: string;
  declaredEffects: readonly FlowEffectKind[];
  simulatedNodes: readonly ApplicationPreviewFlowNodeSimulation[];
  simulated: true;
}>;

/** A truthful preview outcome: what resolved, and what the preview could not show. */
export type ApplicationPreviewOutcome =
  | Readonly<{ kind: "preview_available"; placementId: string; source: "labelled_sample" }>
  | Readonly<{ kind: "sample_data_unresolved"; placementId: string }>
  | Readonly<{ kind: "flow_unavailable"; controlId: string; flowId: string }>;

export type ApplicationPreviewArtifact = Readonly<{
  kind: "application_preview";
  rootId: string;
  draftRevision: number;
  currentReleaseRevision: number | null;
  pageId: string;
  activeStepId?: string;
  breakpoint: ApplicationPreviewBreakpoint;
  interactionMode: "simulation";
  composition: ApplicationPreviewComposition;
  interactions: readonly ApplicationPreviewInteraction[];
  displaySampleDataByPlacement: Readonly<Record<string, unknown>>;
  controlSampleDataByPlacement: Readonly<Record<string, unknown>>;
  outcomes: readonly ApplicationPreviewOutcome[];
  suppressedEffects: readonly FlowEffectKind[];
}>;

export const applicationPreviewRefusalReasons = [
  "invalid_request",
  "context_refused",
  "draft_stale_or_missing",
  "dependency_unavailable",
  "compilation_refused",
  "content_invalid",
  "page_not_found",
  "step_not_found",
] as const;
export type ApplicationPreviewRefusalReason = (typeof applicationPreviewRefusalReasons)[number];

export type ApplicationPreviewRefusal = Readonly<{
  reason: ApplicationPreviewRefusalReason;
  detail: string;
  rootId?: string;
  draftRevision?: number;
}>;

export type ApplicationPreviewResult =
  | Readonly<{ status: "ok"; artifact: ApplicationPreviewArtifact }>
  | Readonly<{ status: "refused"; refusal: ApplicationPreviewRefusal }>;

/**
 * The effect a registered task would perform, or nothing for a task that reads, changes and starts
 * nothing. Showing a form is the one interface task that is simulated; the rest only present.
 */
const simulatedEffectOf = (task: FlowTask): ApplicationPreviewSimulatedEffect | undefined => {
  const definition = Object.hasOwn(flowTaskRegistry, task.type)
    ? flowTaskRegistry[task.type as keyof typeof flowTaskRegistry]
    : undefined;
  if (definition === undefined) return undefined;
  if (task.type === "interface.show_form") return "form_interaction";
  return definition.effect === "read" ||
    definition.effect === "change" ||
    definition.effect === "background_start"
    ? definition.effect
    : undefined;
};

/** Flows a Run flow task may reach, and the flows already followed for one binding. */
type FlowReach = Readonly<{
  flowsById: ReadonlyMap<string, FlowDefinition>;
  followed: Set<string>;
}>;

/** Simulates one flow's tasks once, however many Run flow tasks reach it. */
const simulateFlow = (
  flow: FlowDefinition,
  into: ApplicationPreviewFlowNodeSimulation[],
  reach: FlowReach,
): void => {
  if (reach.followed.has(String(flow.id))) return;
  reach.followed.add(String(flow.id));
  simulateTasks(flow.tasks, into, reach);
  simulateTasks(flow.errors, into, reach);
  simulateTasks(flow.finally, into, reach);
};

const simulateTasks = (
  tasks: readonly FlowTask[],
  into: ApplicationPreviewFlowNodeSimulation[],
  reach: FlowReach,
): void => {
  for (const task of tasks) {
    // A Run flow task performs whatever the flow it runs performs.
    if (task.type === "run_flow") {
      const target = reach.flowsById.get(
        String((task as Extract<FlowTask, { type: "run_flow" }>).flowId),
      );
      if (target !== undefined) simulateFlow(target, into, reach);
    }
    const simulatedEffect = simulatedEffectOf(task);
    if (simulatedEffect !== undefined)
      into.push({
        nodeId: task.id,
        nodeKind: "task",
        targetKind: task.type,
        simulatedEffect,
        label: task.id,
      });
    for (const child of flowTaskChildLists(task)) simulateTasks(child.tasks, into, reach);
  }
};

const buildInteraction = (
  binding: ComponentFlowBinding,
  flow: FlowDefinition | undefined,
  flowsById: ReadonlyMap<string, FlowDefinition>,
  outcomes: ApplicationPreviewOutcome[],
): ApplicationPreviewInteraction | undefined => {
  const flowId = String(binding.flow.flowId);
  if (flow === undefined) {
    outcomes.push({ kind: "flow_unavailable", controlId: String(binding.controlId), flowId });
  }
  const simulatedNodes: ApplicationPreviewFlowNodeSimulation[] = [];
  if (flow !== undefined) simulateFlow(flow, simulatedNodes, { flowsById, followed: new Set() });
  if (simulatedNodes.length === 0) return undefined;
  return {
    bindingId: String(binding.bindingId),
    controlId: String(binding.controlId),
    eventId: String(binding.eventId),
    event: binding.event,
    flowKind: "application_owned",
    flowId,
    declaredEffects: [...new Set(simulatedNodes.map((node) => node.simulatedEffect))].sort(),
    simulatedNodes,
    simulated: true,
  };
};

/**
 * Replaces every effectful flow task with an explicit simulation. An application-owned flow that
 * the draft cannot resolve is reported as a preview outcome instead of being silently replaced.
 * When `controlIds` is given, only bindings on those placements are considered.
 */
export const substituteApplicationPreviewInteractions = (
  content: ApplicationContent,
  controlIds?: ReadonlySet<string>,
): Readonly<{
  interactions: readonly ApplicationPreviewInteraction[];
  outcomes: readonly ApplicationPreviewOutcome[];
  suppressedEffects: readonly FlowEffectKind[];
}> => {
  const flowsById = new Map(content.flows.map((flow) => [String(flow.id), flow]));
  const outcomes: ApplicationPreviewOutcome[] = [];
  const interactions: ApplicationPreviewInteraction[] = [];
  for (const binding of content.flowBindings) {
    if (controlIds !== undefined && !controlIds.has(String(binding.controlId))) continue;
    const flow = flowsById.get(String(binding.flow.flowId));
    const interaction = buildInteraction(binding, flow, flowsById, outcomes);
    if (interaction !== undefined) interactions.push(interaction);
  }
  const suppressed = new Set<FlowEffectKind>();
  for (const interaction of interactions)
    for (const effect of interaction.declaredEffects) suppressed.add(effect);
  return {
    interactions,
    outcomes,
    suppressedEffects: [...suppressed].sort(),
  };
};

type ApplicationPage = ApplicationContent["pages"][number];

/**
 * Every placement identity the requested page renders: its application shell's layout, if any,
 * and the page content, or for a guided form only the active step's content.
 */
const pagePlacementIds = (
  content: ApplicationContent,
  page: ApplicationPage,
  activeStepId: string | undefined,
): ReadonlySet<string> => {
  const ids = new Set<string>();
  const addItems = (items: readonly CompiledItem[]): void => {
    for (const item of compiledItemTree(items)) ids.add(item.props.id);
  };
  const composition = page.composition;
  const shellId = compiledPageShellId(composition);
  if (shellId !== null) {
    const shell = content.shells.find((candidate) => String(candidate.shellId) === String(shellId));
    if (shell !== undefined) addItems(shell.layout.content);
  }
  const data =
    "stepContent" in composition
      ? activeStepId === undefined
        ? undefined
        : composition.stepContent[activeStepId]
      : composition;
  if (data !== undefined) for (const [, items] of compiledPageZones(data)) addItems(items);
  return ids;
};

const previewPage = (page: ApplicationPage): ApplicationPreviewPage => ({
  pageId: String(page.pageId),
  composition: page.composition,
  ...(page.type === "guided_form"
    ? {
        steps: page.steps.map((step) => ({
          id: String(step.id),
          name: step.name,
          summary: step.summary,
        })),
      }
    : {}),
});

const refuse = (
  reason: ApplicationPreviewRefusalReason,
  detail: string,
  options: Readonly<{ rootId?: string; draftRevision?: number }> = {},
): ApplicationPreviewResult => ({
  status: "refused",
  refusal: {
    reason,
    detail,
    ...(options.rootId === undefined ? {} : { rootId: options.rootId }),
    ...(options.draftRevision === undefined ? {} : { draftRevision: options.draftRevision }),
  },
});

export type MaterialiseApplicationPreviewInput = Readonly<{
  request: ApplicationPreviewRequest;
  draft: ApplicationPreviewDraft;
}>;

/**
 * Pure exact-draft materialisation. It proves the request and the supplied draft agree, chooses
 * the requested page and step, substitutes every effectful flow node on that page with a
 * simulation and binds the labelled preview data. It reads no installation and performs no write.
 */
export const materialiseApplicationPreview = (
  input: MaterialiseApplicationPreviewInput,
): ApplicationPreviewResult => {
  const { request, draft } = input;
  const addressed = { rootId: String(request.rootId), draftRevision: request.draftRevision };
  if (
    String(draft.rootId) !== String(request.rootId) ||
    draft.draftRevision !== request.draftRevision
  )
    return refuse(
      "draft_stale_or_missing",
      "The supplied draft does not match the requested root and revision",
      addressed,
    );

  const parsedContent = applicationContentSchema.safeParse(draft.content);
  if (!parsedContent.success)
    return refuse(
      "content_invalid",
      "The supplied draft content is not a valid Application document",
      addressed,
    );
  const content = parsedContent.data;

  const requestedPageId = request.pageId ?? String(content.homePageId);
  const pageMatches = content.pages.filter((page) => String(page.pageId) === requestedPageId);
  const page = pageMatches[0];
  if (pageMatches.length !== 1 || page === undefined)
    return refuse(
      "page_not_found",
      "The requested page is not in this application draft",
      addressed,
    );

  let activeStepId: string | undefined;
  if (page.type === "guided_form") {
    const stepIds = page.steps.map((step) => String(step.id));
    if (request.activeStepId === undefined) activeStepId = stepIds[0];
    else if (!stepIds.includes(request.activeStepId))
      return refuse(
        "step_not_found",
        "The requested guided step is not in this guided form",
        addressed,
      );
    else activeStepId = request.activeStepId;
  } else if (request.activeStepId !== undefined)
    return refuse(
      "invalid_request",
      "A guided step may only be selected for a guided form page",
      addressed,
    );

  const renderedPlacements = pagePlacementIds(content, page, activeStepId);
  const { interactions, outcomes, suppressedEffects } = substituteApplicationPreviewInteractions(
    content,
    renderedPlacements,
  );

  const displaySampleDataByPlacement: Record<string, unknown> = {};
  const controlSampleDataByPlacement: Record<string, unknown> = {};
  const sampleOutcomes: ApplicationPreviewOutcome[] = [];
  const boundSamples = new Set<string>();
  for (const entry of request.sampleData) {
    const sampleKey = `${entry.surface}\0${entry.placementId}`;
    if (boundSamples.has(sampleKey))
      return refuse(
        "invalid_request",
        "Each placement may receive at most one sample value per surface",
        addressed,
      );
    boundSamples.add(sampleKey);
    if (!renderedPlacements.has(entry.placementId)) {
      sampleOutcomes.push({ kind: "sample_data_unresolved", placementId: entry.placementId });
      continue;
    }
    // Own data properties only, so a "__proto__" placement key stays an ordinary key.
    const target =
      entry.surface === "display" ? displaySampleDataByPlacement : controlSampleDataByPlacement;
    Object.defineProperty(target, entry.placementId, {
      value: entry.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    sampleOutcomes.push({
      kind: "preview_available",
      placementId: entry.placementId,
      source: "labelled_sample",
    });
  }

  return {
    status: "ok",
    artifact: {
      kind: "application_preview",
      rootId: String(draft.rootId),
      draftRevision: draft.draftRevision,
      currentReleaseRevision: draft.currentReleaseRevision,
      pageId: requestedPageId,
      ...(activeStepId === undefined ? {} : { activeStepId }),
      breakpoint: request.breakpoint,
      interactionMode: "simulation",
      composition: {
        platformBlockDependencies: content.platformBlockDependencies,
        shells: content.shells,
        pages: [previewPage(page)],
        theme: content.theme,
      },
      interactions,
      displaySampleDataByPlacement,
      controlSampleDataByPlacement,
      outcomes: [...outcomes, ...sampleOutcomes],
      suppressedEffects,
    },
  };
};

/**
 * Builds the exact preview draft from one compiled current draft. Identities come from the
 * compilation itself, never from the preview request.
 */
export const applicationPreviewDraftFromCompilation = (
  compiled: ApplicationDraftCompilation,
): ApplicationPreviewDraft => ({
  rootId: String(compiled.compilation.artifact.rootId),
  draftRevision: compiled.compilation.canonical.envelope.draftRevision,
  content: compiled.compilation.canonical.content,
  currentReleaseRevision: compiled.currentReleaseRevision,
});

/** The Definition read the preview service needs: one organisation-scoped exact-draft compile. */
export type ApplicationPreviewDraftCompiler = Readonly<{
  compileApplicationDraft(
    context: SessionContext,
    command: Readonly<{ rootId: string; expectedDraftRevision: number }>,
  ): Promise<ApplicationDraftCompilation>;
}>;

/** Publication refusals preview reports; every other publication code is a fault and rethrown. */
const refusalByPublicationCode: Readonly<
  Partial<Record<DefinitionPublicationFailureCode, ApplicationPreviewRefusalReason>>
> = {
  INVALID_DEFINITION_PUBLICATION_COMMAND: "invalid_request",
  DEFINITION_DRAFT_STALE_OR_MISSING: "draft_stale_or_missing",
  DEFINITION_SOURCE_EVIDENCE_MISMATCH: "draft_stale_or_missing",
  DEFINITION_ORGANIZATION_MISMATCH: "context_refused",
  DEFINITION_DEPENDENCY_MISSING: "dependency_unavailable",
  DEFINITION_DEPENDENCY_PRERELEASE_ONLY: "dependency_unavailable",
  DEFINITION_DEPENDENCY_INCOMPATIBLE: "dependency_unavailable",
  DEFINITION_DEPENDENCY_AMBIGUOUS: "dependency_unavailable",
  DEFINITION_DEPENDENCY_SUBSTITUTED: "dependency_unavailable",
  DEFINITION_DEPENDENCY_CYCLE: "dependency_unavailable",
  DEFINITION_COMPILATION_REFUSED: "compilation_refused",
};

const refusalDetail: Readonly<Record<ApplicationPreviewRefusalReason, string>> = {
  invalid_request: "The preview request is invalid",
  context_refused: "The preview request is not permitted in this context",
  draft_stale_or_missing: "The addressed draft revision is not the current Application draft",
  dependency_unavailable: "A dependency of this draft is unavailable",
  compilation_refused: "This draft does not compile",
  content_invalid: "The draft content is not a valid Application document",
  page_not_found: "The requested page is not in this application draft",
  step_not_found: "The requested guided step is not in this guided form",
};

export type ApplicationPreviewCompilationResult =
  | Readonly<{
      status: "ok";
      compiled: ApplicationDraftCompilation;
      draft: ApplicationPreviewDraft;
    }>
  | Readonly<{ status: "refused"; refusal: ApplicationPreviewRefusal }>;

/** Compiles one exact current draft for callers that need the full ephemeral candidate. */
export const compileApplicationPreviewDraft = async (
  drafts: ApplicationPreviewDraftCompiler,
  context: SessionContext,
  request: ApplicationPreviewRequest,
): Promise<ApplicationPreviewCompilationResult> => {
  const addressed = { rootId: String(request.rootId), draftRevision: request.draftRevision };
  let compiled: ApplicationDraftCompilation;
  try {
    compiled = await drafts.compileApplicationDraft(context, {
      rootId: String(request.rootId),
      expectedDraftRevision: request.draftRevision,
    });
  } catch (error) {
    const reason =
      error instanceof DefinitionCompilationError
        ? "compilation_refused"
        : error instanceof DefinitionError
          ? refusalByPublicationCode[error.code as DefinitionPublicationFailureCode]
          : undefined;
    if (reason === undefined) throw error;
    return {
      status: "refused",
      refusal: {
        reason,
        detail: refusalDetail[reason],
        ...addressed,
      },
    };
  }
  return {
    status: "ok",
    compiled,
    draft: applicationPreviewDraftFromCompilation(compiled),
  };
};
