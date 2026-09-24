import {
  applicationContentV2Schema,
  applicationRootIdSchema,
  revisionSchema,
  type ApplicationCompilationOutputV2,
  type ApplicationContentV2,
  type ComponentFlowBinding,
  type ComponentSemanticEventKind,
  type CurrentUserFlow,
  type CurrentUserFlowNode,
  type FlowEffectKind,
  type FrontendFlowNodeTarget,
} from "@vortex/contracts";
import { z } from "zod";

/**
 * Exact-draft Application preview.
 *
 * Preview renders one exact application draft revision through the shared #580 renderer. It never
 * adopts or installs a release and never treats the installation as authority: the caller supplies
 * the draft compilation that belongs to the addressed root and revision, and the materialiser
 * proves the request, the draft identity and the rendered page agree before it emits an artifact.
 *
 * The emitted artifact is deliberately inert. Every effectful flow node (a read, a change, a form
 * continuation or a durable workflow start) is replaced by an explicit, labelled simulation, and
 * the artifact carries no executor, permission or installation state. The browser hook that
 * consumes the artifact therefore has nothing that can commit a record, change access or start
 * durable work. Unavailable application-owned flows and unbound sample values are reported as
 * preview outcomes instead of being silently substituted.
 */

export const applicationPreviewBreakpoints = ["desktop", "tablet", "phone"] as const;
export type ApplicationPreviewBreakpoint = (typeof applicationPreviewBreakpoints)[number];

export const applicationPreviewDataOrigins = ["labelled_sample", "authorized_read"] as const;
export type ApplicationPreviewDataOrigin = (typeof applicationPreviewDataOrigins)[number];

export const applicationPreviewDataSurfaces = ["display", "control"] as const;
export type ApplicationPreviewDataSurface = (typeof applicationPreviewDataSurfaces)[number];

const previewDataEntrySchema = z
  .object({
    placementId: z.string().min(1).max(200),
    surface: z.enum(applicationPreviewDataSurfaces),
    origin: z.enum(applicationPreviewDataOrigins),
    value: z.unknown(),
  })
  .strict();

/**
 * Selects one permitted application root and one exact draft revision. A page and guided step may
 * be named; when they are absent the application home page and its first ordered step are used.
 * Sample data is only ever labelled preview data, never installed authority.
 */
export const applicationPreviewRequestSchema = z
  .object({
    kind: z.literal("application"),
    rootId: applicationRootIdSchema,
    draftRevision: revisionSchema.max(Number.MAX_SAFE_INTEGER),
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
  content: ApplicationContentV2;
  /** The root's installed release revision, echoed only to show preview ignores it. */
  installedReleaseRevision: number | null;
}>;

type ApplicationPreviewPage = Readonly<{
  pageId: string;
  composition: ApplicationContentV2["pages"][number]["composition"];
  steps?: readonly Readonly<{ id: string; name: string; summary: boolean }>[];
}>;

/** The renderer input for #580, built from the compiled draft content. */
export type ApplicationPreviewComposition = Readonly<{
  platformBlockDependencies: ApplicationContentV2["platformBlockDependencies"];
  shells: ApplicationContentV2["shells"];
  pages: readonly ApplicationPreviewPage[];
  theme: ApplicationContentV2["theme"];
}>;

/** The simulated effect a substituted flow node would have performed in live rendering. */
export type ApplicationPreviewSimulatedEffect =
  | "read"
  | "change"
  | "background_start"
  | "form_interaction";

export type ApplicationPreviewFlowTargetKind =
  | FrontendFlowNodeTarget["kind"]
  | "application_action"
  | "application_query";

export type ApplicationPreviewFlowNodeSimulation = Readonly<{
  nodeId: string;
  nodeKind: CurrentUserFlowNode["kind"];
  targetKind?: ApplicationPreviewFlowTargetKind;
  simulatedEffect: ApplicationPreviewSimulatedEffect;
  label: string;
}>;

/** One component flow binding with every effectful node replaced by explicit simulations. */
export type ApplicationPreviewInteraction = Readonly<{
  bindingId: string;
  controlId: string;
  eventId: string;
  event: ComponentSemanticEventKind;
  flowKind: "application_owned" | "platform_managed";
  flowId: string;
  declaredEffects: readonly FlowEffectKind[];
  simulatedNodes: readonly ApplicationPreviewFlowNodeSimulation[];
  simulated: true;
}>;

/** A truthful preview outcome: what resolved, and what the preview could not show. */
export type ApplicationPreviewOutcome =
  | Readonly<{
      kind: "preview_available";
      placementId: string;
      source: "definition" | ApplicationPreviewDataOrigin;
    }>
  | Readonly<{ kind: "sample_data_unresolved"; placementId: string }>
  | Readonly<{ kind: "flow_unavailable"; controlId: string; flowId: string }>;

export type ApplicationPreviewArtifact = Readonly<{
  kind: "application_preview";
  rootId: string;
  draftRevision: number;
  installedReleaseRevision: number | null;
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
  "draft_stale_or_missing",
  "draft_kind_mismatch",
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

const simulateActionTargetEffect = (
  targetKind: ApplicationPreviewFlowTargetKind,
  declaredEffects: readonly FlowEffectKind[],
): ApplicationPreviewSimulatedEffect => {
  if (targetKind === "query" || targetKind === "application_query") return "read";
  if (targetKind === "form_continuation") return "form_interaction";
  if (targetKind === "durable_workflow_start") return "background_start";
  // Protected operations and application actions carry their own effect; read the binding's
  // declared effects rather than guessing. A change is the conservative default.
  if (declaredEffects.includes("background_start")) return "background_start";
  if (declaredEffects.includes("read") && !declaredEffects.includes("change")) return "read";
  return "change";
};

const simulateNode = (
  node: CurrentUserFlowNode,
  declaredEffects: readonly FlowEffectKind[],
): ApplicationPreviewFlowNodeSimulation | undefined => {
  const label = node.label ?? node.key;
  switch (node.kind) {
    case "query":
      return {
        nodeId: String(node.nodeId),
        nodeKind: node.kind,
        targetKind: node.target.kind,
        simulatedEffect: "read",
        label,
      };
    case "action":
      return {
        nodeId: String(node.nodeId),
        nodeKind: node.kind,
        targetKind: node.target.kind,
        simulatedEffect: simulateActionTargetEffect(node.target.kind, declaredEffects),
        label,
      };
    // Start, transform and return nodes perform no read, change or durable start; they are not
    // substituted and are never presented as effectful.
    case "start":
    case "transform":
    case "return":
      return undefined;
  }
};

const buildInteraction = (
  binding: ComponentFlowBinding,
  flow: CurrentUserFlow | undefined,
  outcomes: ApplicationPreviewOutcome[],
): ApplicationPreviewInteraction | undefined => {
  const flowId = String(binding.flow.flowId);
  if (binding.flow.kind === "application_owned" && flow === undefined) {
    outcomes.push({ kind: "flow_unavailable", controlId: String(binding.controlId), flowId });
  }
  const simulatedNodes =
    flow === undefined
      ? []
      : flow.nodes.flatMap((node) => {
          const simulation = simulateNode(node, binding.declaredEffects);
          return simulation === undefined ? [] : [simulation];
        });
  const effectful =
    simulatedNodes.length > 0 || binding.declaredEffects.some((effect) => effect !== "pure");
  if (!effectful) return undefined;
  return {
    bindingId: String(binding.bindingId),
    controlId: String(binding.controlId),
    eventId: String(binding.eventId),
    event: binding.event,
    flowKind: binding.flow.kind,
    flowId,
    declaredEffects: binding.declaredEffects,
    simulatedNodes,
    simulated: true,
  };
};

/**
 * Replaces every effectful flow node with an explicit simulation. An application-owned flow that
 * the draft cannot resolve is reported as a preview outcome instead of being silently replaced.
 */
export const substituteApplicationPreviewInteractions = (
  content: ApplicationContentV2,
): Readonly<{
  interactions: readonly ApplicationPreviewInteraction[];
  outcomes: readonly ApplicationPreviewOutcome[];
  suppressedEffects: readonly FlowEffectKind[];
}> => {
  const flowsById = new Map(content.flows.map((flow) => [String(flow.flowId), flow]));
  const outcomes: ApplicationPreviewOutcome[] = [];
  const interactions: ApplicationPreviewInteraction[] = [];
  for (const binding of content.flowBindings) {
    const flow =
      binding.flow.kind === "application_owned"
        ? flowsById.get(String(binding.flow.flowId))
        : undefined;
    const interaction = buildInteraction(binding, flow, outcomes);
    if (interaction !== undefined) interactions.push(interaction);
  }
  const suppressed = new Set<FlowEffectKind>();
  for (const interaction of interactions)
    for (const effect of interaction.declaredEffects)
      if (effect !== "pure") suppressed.add(effect);
  return {
    interactions,
    outcomes,
    suppressedEffects: [...suppressed].sort(),
  };
};

const collectSlotPlacementIds = (slot: unknown, into: Set<string>): void => {
  if (slot === null || typeof slot !== "object") return;
  const placements = (slot as { placements?: unknown }).placements;
  if (placements === null || typeof placements !== "object") return;
  for (const [placementId, placement] of Object.entries(placements as Record<string, unknown>)) {
    into.add(placementId);
    const slots =
      placement !== null && typeof placement === "object"
        ? (placement as { slots?: unknown }).slots
        : undefined;
    if (slots !== null && typeof slots === "object")
      for (const child of Object.values(slots as Record<string, unknown>))
        collectSlotPlacementIds(child, into);
  }
};

const collectCompositionPlacementIds = (composition: unknown, into: Set<string>): void => {
  if (composition === null || typeof composition !== "object") return;
  const candidate = composition as Record<string, unknown>;
  if ("main" in candidate) collectSlotPlacementIds(candidate.main, into);
  if (candidate.content !== null && typeof candidate.content === "object")
    for (const slot of Object.values(candidate.content as Record<string, unknown>))
      collectSlotPlacementIds(slot, into);
  if (candidate.stepContent !== null && typeof candidate.stepContent === "object")
    for (const entry of Object.values(candidate.stepContent as Record<string, unknown>)) {
      if (entry !== null && typeof entry === "object" && "placements" in entry)
        collectSlotPlacementIds(entry, into);
      else if (entry !== null && typeof entry === "object")
        for (const slot of Object.values(entry as Record<string, unknown>))
          collectSlotPlacementIds(slot, into);
    }
};

/** Every placement identity the compiled application content can render, across all its pages. */
const applicationPlacementIds = (content: ApplicationContentV2): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const shell of content.shells) collectSlotPlacementIds(shell.layout, ids);
  for (const page of content.pages) collectCompositionPlacementIds(page.composition, ids);
  return ids;
};

const buildComposition = (content: ApplicationContentV2): ApplicationPreviewComposition => ({
  platformBlockDependencies: content.platformBlockDependencies,
  shells: content.shells,
  pages: content.pages.map(
    (page): ApplicationPreviewPage => ({
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
    }),
  ),
  theme: content.theme,
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
 * the requested page and step, substitutes every effectful flow node with a simulation and binds
 * the labelled preview data. It reads no installation and performs no write.
 */
export const materialiseApplicationPreview = (
  input: MaterialiseApplicationPreviewInput,
): ApplicationPreviewResult => {
  const { request, draft } = input;
  if (
    String(draft.rootId) !== String(request.rootId) ||
    draft.draftRevision !== request.draftRevision
  )
    return refuse("draft_stale_or_missing", "The supplied draft does not match the requested root and revision", {
      rootId: String(request.rootId),
      draftRevision: request.draftRevision,
    });

  const parsedContent = applicationContentV2Schema.safeParse(draft.content);
  if (!parsedContent.success)
    return refuse("content_invalid", "The supplied draft content is not a valid Application document", {
      rootId: String(request.rootId),
      draftRevision: draft.draftRevision,
    });
  const content = parsedContent.data;

  const requestedPageId = request.pageId ?? String(content.homePageId);
  const pageMatches = content.pages.filter((page) => String(page.pageId) === requestedPageId);
  const page = pageMatches[0];
  if (pageMatches.length !== 1 || page === undefined)
    return refuse("page_not_found", `Page '${requestedPageId}' is not in this application draft`, {
      rootId: String(request.rootId),
      draftRevision: draft.draftRevision,
    });

  let activeStepId: string | undefined;
  if (page.type === "guided_form") {
    const stepIds = page.steps.map((step) => String(step.id));
    if (request.activeStepId === undefined) activeStepId = stepIds[0];
    else if (!stepIds.includes(request.activeStepId))
      return refuse("step_not_found", `Guided step '${request.activeStepId}' is not in this guided form`, {
        rootId: String(request.rootId),
        draftRevision: draft.draftRevision,
      });
    else activeStepId = request.activeStepId;
  } else if (request.activeStepId !== undefined)
    return refuse("invalid_request", "A guided step may only be selected for a guided form page", {
      rootId: String(request.rootId),
      draftRevision: draft.draftRevision,
    });

  const { interactions, outcomes, suppressedEffects } =
    substituteApplicationPreviewInteractions(content);

  const knownPlacements = applicationPlacementIds(content);
  const displaySampleDataByPlacement: Record<string, unknown> = {};
  const controlSampleDataByPlacement: Record<string, unknown> = {};
  const sampleOutcomes: ApplicationPreviewOutcome[] = [];
  for (const entry of request.sampleData) {
    if (!knownPlacements.has(entry.placementId)) {
      sampleOutcomes.push({ kind: "sample_data_unresolved", placementId: entry.placementId });
      continue;
    }
    if (entry.surface === "display") displaySampleDataByPlacement[entry.placementId] = entry.value;
    else controlSampleDataByPlacement[entry.placementId] = entry.value;
    sampleOutcomes.push({
      kind: "preview_available",
      placementId: entry.placementId,
      source: entry.origin,
    });
  }

  return {
    status: "ok",
    artifact: {
      kind: "application_preview",
      rootId: String(draft.rootId),
      draftRevision: draft.draftRevision,
      installedReleaseRevision: draft.installedReleaseRevision,
      pageId: requestedPageId,
      ...(activeStepId === undefined ? {} : { activeStepId }),
      breakpoint: request.breakpoint,
      interactionMode: "simulation",
      composition: buildComposition(content),
      interactions,
      displaySampleDataByPlacement,
      controlSampleDataByPlacement,
      outcomes: [...outcomes, ...sampleOutcomes],
      suppressedEffects,
    },
  };
};

export const parseApplicationPreviewRequest = (
  candidate: unknown,
): ApplicationPreviewRequest | undefined => {
  const parsed = applicationPreviewRequestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
};

/** Reads one exact draft compilation by root and revision. It never reads an installation. */
export type ApplicationPreviewDraftSource = (
  command: Readonly<{ rootId: string; draftRevision: number }>,
) => Promise<ApplicationPreviewDraft | undefined>;

/**
 * Builds the exact preview draft from one Application compilation output. A caller that already
 * holds the draft compilation (for example Definition publication preparation) wraps it here so
 * the preview service never has to re-derive identities or read an installation.
 */
export const applicationPreviewDraftFromCompilation = (
  output: ApplicationCompilationOutputV2,
  installedReleaseRevision: number | null,
): ApplicationPreviewDraft => ({
  rootId: String(output.artifact.rootId),
  draftRevision: output.canonical.envelope.draftRevision,
  content: output.canonical.content,
  installedReleaseRevision,
});

/**
 * The preview service composes an injected exact-draft reader over the pure materialiser. It
 * exposes no install, publish, save or restore operation, so preview can never change an
 * installation or a draft.
 */
export const createApplicationPreviewService = (source: ApplicationPreviewDraftSource) => ({
  async preview(candidate: unknown): Promise<ApplicationPreviewResult> {
    const request = parseApplicationPreviewRequest(candidate);
    if (request === undefined) return refuse("invalid_request", "The preview request is invalid");
    let draft: ApplicationPreviewDraft | undefined;
    try {
      draft = await source({
        rootId: String(request.rootId),
        draftRevision: request.draftRevision,
      });
    } catch {
      return refuse("draft_stale_or_missing", "The addressed draft could not be read", {
        rootId: String(request.rootId),
        draftRevision: request.draftRevision,
      });
    }
    if (draft === undefined)
      return refuse("draft_stale_or_missing", "The addressed draft revision does not exist", {
        rootId: String(request.rootId),
        draftRevision: request.draftRevision,
      });
    return materialiseApplicationPreview({ request, draft });
  },
});
