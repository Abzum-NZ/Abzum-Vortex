import type { CSSProperties, ReactElement } from "react";
import {
  componentSemanticEventKindSchema,
  flowEffectKindSchema,
  type ComponentSemanticEventKind,
  type FlowEffectKind,
} from "@vortex/contracts";
import {
  DefinitionRenderError,
  validatePlacementTree,
  type Breakpoint,
  type DefinitionRenderErrorLocation,
} from "./definition-error";
import {
  PageLayoutRenderer,
  resolveRootPlacementSlot,
  type MaterialisedApplicationCompositionV2,
  type PlacementSlotV2,
} from "./layout-renderer";
import type { PlatformComponentRegistry, RuntimeInputsByPlacement } from "./registry";
import {
  CONTROL_EVENT_NAMES,
  type ControlSemanticEventName,
} from "./controls/projected-data";
import {
  DISPLAY_EVENT_NAMES,
  type DisplaySemanticEventName,
} from "./display/projected-data";
import type { ThemeMode } from "./theme";

/**
 * Browser side of the exact-draft Application preview (#597).
 *
 * This hook renders the artifact the Definition service emits through the shared #580
 * `PageLayoutRenderer`. It is deliberately inert: the only callbacks it wires are labelled
 * simulations that perform no work, so a preview interaction can never commit a record, change
 * access or start durable work. Unknown releases, illegal children or a missing accessible name
 * are surfaced as a truthful preview outcome instead of falling back to arbitrary output.
 */

export const applicationPreviewBreakpoints = ["desktop", "tablet", "phone"] as const;
export type ApplicationPreviewBreakpoint = (typeof applicationPreviewBreakpoints)[number];

const applicationPreviewSimulatedEffects = [
  "read",
  "change",
  "background_start",
  "form_interaction",
] as const;
export type ApplicationPreviewSimulatedEffect = (typeof applicationPreviewSimulatedEffects)[number];

export type ApplicationPreviewFlowNodeSimulation = Readonly<{
  nodeId: string;
  nodeKind: string;
  targetKind?: string;
  simulatedEffect: ApplicationPreviewSimulatedEffect;
  label: string;
}>;

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
  composition: MaterialisedApplicationCompositionV2;
  interactions: readonly ApplicationPreviewInteraction[];
  displaySampleDataByPlacement: Readonly<Record<string, unknown>>;
  controlSampleDataByPlacement: Readonly<Record<string, unknown>>;
  outcomes: readonly ApplicationPreviewOutcome[];
  suppressedEffects: readonly FlowEffectKind[];
}>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (message: string, location: DefinitionRenderErrorLocation = {}): never => {
  throw new DefinitionRenderError("INVALID_COMPOSITION", message, location);
};

const requireString = (value: unknown, message: string): string =>
  typeof value === "string" && value.length > 0 ? value : fail(message);

const requireRevision = (value: unknown, message: string): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail(message);

const requireArray = (value: unknown, message: string): readonly unknown[] =>
  Array.isArray(value) ? value : fail(message);

const requireObject = (value: unknown, message: string): Record<string, unknown> =>
  isPlainObject(value) ? value : fail(message);

const requireSimulatedEffect = (value: unknown): ApplicationPreviewSimulatedEffect =>
  applicationPreviewSimulatedEffects.find((effect) => effect === value) ??
  fail("A preview flow-node simulation requires a known simulated effect");

const requireEvent = (value: unknown): ComponentSemanticEventKind => {
  const parsed = componentSemanticEventKindSchema.safeParse(value);
  return parsed.success ? parsed.data : fail("A preview interaction requires a known event");
};

const requireEffect = (value: unknown, message: string): FlowEffectKind => {
  const parsed = flowEffectKindSchema.safeParse(value);
  return parsed.success ? parsed.data : fail(message);
};

const parseFlowNodeSimulation = (value: unknown): ApplicationPreviewFlowNodeSimulation => {
  const record = requireObject(value, "A preview flow-node simulation must be an object");
  return {
    nodeId: requireString(record.nodeId, "A preview flow-node simulation requires a node identity"),
    nodeKind: requireString(record.nodeKind, "A preview flow-node simulation requires a node kind"),
    ...(record.targetKind === undefined
      ? {}
      : { targetKind: requireString(record.targetKind, "A preview flow-node target kind is invalid") }),
    simulatedEffect: requireSimulatedEffect(record.simulatedEffect),
    label: requireString(record.label, "A preview flow-node simulation requires a label"),
  };
};

const parseInteraction = (value: unknown): ApplicationPreviewInteraction => {
  const record = requireObject(value, "A preview interaction must be an object");
  if (record.simulated !== true) fail("A preview interaction must be explicitly simulated");
  const flowKind = record.flowKind;
  if (flowKind !== "application_owned")
    fail("A preview interaction requires a known flow kind");
  return {
    bindingId: requireString(record.bindingId, "A preview interaction requires a binding identity"),
    controlId: requireString(record.controlId, "A preview interaction requires a control identity"),
    eventId: requireString(record.eventId, "A preview interaction requires an event identity"),
    event: requireEvent(record.event),
    flowKind,
    flowId: requireString(record.flowId, "A preview interaction requires a flow identity"),
    declaredEffects: requireArray(
      record.declaredEffects,
      "A preview interaction requires declared effects",
    ).map((effect) => requireEffect(effect, "A preview interaction effect is invalid")),
    simulatedNodes: requireArray(
      record.simulatedNodes,
      "A preview interaction requires simulated nodes",
    ).map(parseFlowNodeSimulation),
    simulated: true,
  };
};

const parseOutcome = (value: unknown): ApplicationPreviewOutcome => {
  const record = requireObject(value, "A preview outcome must be an object");
  switch (record.kind) {
    case "preview_available":
      if (record.source !== "labelled_sample")
        fail("A preview availability outcome must be a labelled sample");
      return {
        kind: "preview_available",
        placementId: requireString(record.placementId, "A preview outcome requires a placement"),
        source: "labelled_sample",
      };
    case "sample_data_unresolved":
      return {
        kind: "sample_data_unresolved",
        placementId: requireString(record.placementId, "A preview outcome requires a placement"),
      };
    case "flow_unavailable":
      return {
        kind: "flow_unavailable",
        controlId: requireString(record.controlId, "A preview outcome requires a control identity"),
        flowId: requireString(record.flowId, "A preview outcome requires a flow identity"),
      };
    default:
      return fail(`Unknown preview outcome kind '${String(record.kind)}'`);
  }
};

const parsePlacementDataMap = (value: unknown, message: string): Readonly<Record<string, unknown>> => {
  const record = requireObject(value, message);
  return Object.freeze({ ...record });
};

/**
 * Validates one preview artifact from the Definition service and returns its frozen shape. It
 * fails closed on any malformed field; a preview never renders a guessed structure.
 */
export const parseApplicationPreviewArtifact = (value: unknown): ApplicationPreviewArtifact => {
  const record = requireObject(value, "A preview artifact must be an object");
  if (record.kind !== "application_preview")
    fail("A preview artifact must declare its application-preview kind");
  if (record.interactionMode !== "simulation")
    fail("A preview artifact must be in simulation interaction mode");
  const breakpoint = record.breakpoint;
  if (breakpoint !== "desktop" && breakpoint !== "tablet" && breakpoint !== "phone")
    fail("A preview artifact requires a known breakpoint");
  const currentReleaseRevision = record.currentReleaseRevision;
  if (currentReleaseRevision !== null && typeof currentReleaseRevision !== "number")
    fail("A preview artifact requires its current release revision or null");
  const composition = requireObject(record.composition, "A preview artifact requires a composition");
  requireArray(composition.pages, "A preview composition requires its pages");
  requireArray(composition.shells, "A preview composition requires its shells");
  requireArray(
    composition.platformBlockDependencies,
    "A preview composition requires its platform-block dependencies",
  );
  requireObject(composition.theme, "A preview composition requires its theme");
  const activeStepId = record.activeStepId;
  return Object.freeze({
    kind: "application_preview",
    rootId: requireString(record.rootId, "A preview artifact requires an application root"),
    draftRevision: requireRevision(record.draftRevision, "A preview artifact requires a draft revision"),
    currentReleaseRevision:
      currentReleaseRevision === null
        ? null
        : requireRevision(currentReleaseRevision, "A current release revision is invalid"),
    pageId: requireString(record.pageId, "A preview artifact requires a page identity"),
    ...(activeStepId === undefined
      ? {}
      : { activeStepId: requireString(activeStepId, "A preview active step identity is invalid") }),
    breakpoint,
    interactionMode: "simulation",
    composition: composition as unknown as MaterialisedApplicationCompositionV2,
    interactions: Object.freeze(
      requireArray(record.interactions, "A preview artifact requires its interactions").map(parseInteraction),
    ),
    displaySampleDataByPlacement: parsePlacementDataMap(
      record.displaySampleDataByPlacement,
      "Preview display sample data must be keyed by placement identity",
    ),
    controlSampleDataByPlacement: parsePlacementDataMap(
      record.controlSampleDataByPlacement,
      "Preview control sample data must be keyed by placement identity",
    ),
    outcomes: Object.freeze(
      requireArray(record.outcomes, "A preview artifact requires its outcomes").map(parseOutcome),
    ),
    suppressedEffects: Object.freeze(
      requireArray(record.suppressedEffects, "A preview artifact requires its suppressed effects").map(
        (effect) => requireEffect(effect, "A suppressed preview effect is invalid"),
      ),
    ),
  });
};

const collectPlacementIds = (slot: PlacementSlotV2, into: Set<string>): void => {
  for (const [placementId, placement] of Object.entries(slot.placements)) {
    into.add(placementId);
    for (const child of Object.values(placement.slots)) collectPlacementIds(child, into);
  }
};

/**
 * Checks, before rendering, what the shared renderer would otherwise refuse while rendering: every
 * placement must use the exact release its dependency manifest pins, and a draft preview carries
 * no permission-projected availability. A refusal is then shown as a preview outcome.
 */
const validatePreviewPlacements = (
  slot: PlacementSlotV2,
  dependencies: MaterialisedApplicationCompositionV2["platformBlockDependencies"],
  location: DefinitionRenderErrorLocation,
): void => {
  const releases = new Map(
    dependencies.map((dependency) => [dependency.blockId, dependency.releaseVersion]),
  );
  for (const [placementId, placement] of Object.entries(slot.placements)) {
    const placementLocation = {
      ...location,
      placementId,
      blockId: placement.block.blockId,
      releaseVersion: placement.block.releaseVersion,
    };
    if (releases.get(placement.block.blockId) !== placement.block.releaseVersion)
      throw new DefinitionRenderError(
        "MISMATCHED_RELEASE",
        `Placement '${placementId}' does not match the draft's platform-block dependency manifest`,
        placementLocation,
      );
    if ("availability" in placement || "unavailableReason" in placement)
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Placement '${placementId}' carries permission-projected availability in a draft preview`,
        placementLocation,
      );
    for (const [slotKey, child] of Object.entries(placement.slots))
      validatePreviewPlacements(child, dependencies, { ...placementLocation, slotKey });
  }
};

/**
 * Runs each supplied placement's runtime inputs through that placement's own registration before
 * rendering, so sample data or a simulation the block would refuse is shown as a preview outcome
 * rather than failing the render.
 */
const validatePreviewRuntimeInputs = (
  slot: PlacementSlotV2,
  registry: PlatformComponentRegistry,
  runtimeInputs: RuntimeInputsByPlacement,
  location: DefinitionRenderErrorLocation,
): void => {
  for (const [placementId, placement] of Object.entries(slot.placements)) {
    const placementLocation = {
      ...location,
      placementId,
      blockId: placement.block.blockId,
      releaseVersion: placement.block.releaseVersion,
    };
    if (Object.hasOwn(runtimeInputs, placementId))
      registry
        .get(placement.block.blockId, placement.block.releaseVersion)
        ?.parsePayload(runtimeInputs[placementId], placementLocation);
    for (const [slotKey, child] of Object.entries(placement.slots))
      validatePreviewRuntimeInputs(child, registry, runtimeInputs, {
        ...placementLocation,
        slotKey,
      });
  }
};

const onlyKnownPlacements = (
  values: Readonly<Record<string, unknown>>,
  placementIds: ReadonlySet<string>,
): Readonly<Record<string, unknown>> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(values).filter(([placementId]) => placementIds.has(placementId)),
    ),
  );

export type ApplicationPreviewProps = Readonly<{
  artifact: ApplicationPreviewArtifact;
  registry: PlatformComponentRegistry;
  breakpoint?: Breakpoint;
  themeMode?: ThemeMode;
  locale?: string;
  timeZone?: string;
  className?: string;
  style?: CSSProperties;
  /** Called whenever a preview interaction is triggered; the callback performs no business work. */
  onSimulation?: (interaction: ApplicationPreviewInteraction) => void;
}>;

const outcomeLabel = (outcome: ApplicationPreviewOutcome): string => {
  switch (outcome.kind) {
    case "preview_available":
      return `Placement ${outcome.placementId} preview data: ${outcome.source}`;
    case "sample_data_unresolved":
      return `Sample data for placement ${outcome.placementId} was not bound`;
    case "flow_unavailable":
      return `Flow ${outcome.flowId} for control ${outcome.controlId} is unavailable`;
  }
};

/**
 * Renders one exact draft preview through the shared renderer. Every interaction is a labelled
 * simulation; unavailable releases, content and sample data are shown as outcomes, never silently
 * substituted with arbitrary output.
 */
export function ApplicationPreview({
  artifact,
  registry,
  breakpoint = artifact.breakpoint,
  themeMode,
  locale,
  timeZone,
  className,
  style,
  onSimulation,
}: ApplicationPreviewProps): ReactElement {
  const location: DefinitionRenderErrorLocation = {
    pageId: artifact.pageId,
    ...(artifact.activeStepId === undefined ? {} : { stepId: artifact.activeStepId }),
    breakpoint,
  };
  const composition = artifact.composition;

  let resolvedSlot: PlacementSlotV2 | undefined;
  let renderFailure: DefinitionRenderError | undefined;
  try {
    resolvedSlot = resolveRootPlacementSlot({
      composition,
      registry,
      pageId: artifact.pageId,
      ...(artifact.activeStepId === undefined ? {} : { activeStepId: artifact.activeStepId }),
    });
    validatePreviewPlacements(resolvedSlot, composition.platformBlockDependencies, location);
    validatePlacementTree(resolvedSlot, registry, location, { allowEmptyRequiredSlots: false });
  } catch (error) {
    resolvedSlot = undefined;
    renderFailure =
      error instanceof DefinitionRenderError
        ? error
        : new DefinitionRenderError(
            "INVALID_COMPOSITION",
            "The preview composition could not be rendered",
            location,
          );
  }

  const availablePlacementIds = new Set<string>();
  if (resolvedSlot !== undefined) collectPlacementIds(resolvedSlot, availablePlacementIds);

  // One generic runtime-input map per placement. The renderer hands each entry to the placement's
  // own registration, which is the only thing that decides what that block accepts. A placement
  // supplied the same input twice, such as both display and control sample data, is refused.
  const runtimeInputs: Record<string, Readonly<Record<string, unknown>>> = {};
  const supply = (placementId: string, name: string, value: unknown): void => {
    if (value === undefined) return;
    const current: Readonly<Record<string, unknown>> = runtimeInputs[placementId] ?? {};
    if (Object.hasOwn(current, name))
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Placement '${placementId}' is supplied more than one preview '${name}' input`,
        { ...location, placementId },
      );
    runtimeInputs[placementId] = Object.freeze({ ...current, [name]: value });
  };

  // Only local simulations are wired: each callback reports the interaction and does nothing else.
  const displayHandlers = new Map<string, Partial<Record<DisplaySemanticEventName, () => void>>>();
  const controlHandlers = new Map<string, Partial<Record<ControlSemanticEventName, () => void>>>();
  for (const interaction of artifact.interactions) {
    if (!availablePlacementIds.has(interaction.controlId)) continue;
    const handler = () => onSimulation?.(interaction);
    if (DISPLAY_EVENT_NAMES.includes(interaction.event as DisplaySemanticEventName))
      displayHandlers.set(interaction.controlId, {
        ...displayHandlers.get(interaction.controlId),
        [interaction.event as DisplaySemanticEventName]: handler,
      });
    if (CONTROL_EVENT_NAMES.includes(interaction.event as ControlSemanticEventName))
      controlHandlers.set(interaction.controlId, {
        ...controlHandlers.get(interaction.controlId),
        [interaction.event as ControlSemanticEventName]: handler,
      });
  }

  try {
    for (const [placementId, data] of Object.entries(
      onlyKnownPlacements(artifact.displaySampleDataByPlacement, availablePlacementIds),
    ))
      supply(placementId, "data", data);
    for (const [placementId, data] of Object.entries(
      onlyKnownPlacements(artifact.controlSampleDataByPlacement, availablePlacementIds),
    ))
      supply(placementId, "data", data);
    for (const [placementId, events] of displayHandlers) supply(placementId, "events", events);
    for (const [placementId, events] of controlHandlers) supply(placementId, "events", events);
    if (resolvedSlot !== undefined)
      validatePreviewRuntimeInputs(resolvedSlot, registry, runtimeInputs, location);
  } catch (error) {
    renderFailure ??=
      error instanceof DefinitionRenderError
        ? error
        : new DefinitionRenderError(
            "INVALID_COMPOSITION",
            "The preview sample data could not be read",
            location,
          );
  }

  return (
    <div
      data-vortex-preview-mode={artifact.interactionMode}
      data-vortex-preview-root={artifact.rootId}
      data-vortex-preview-draft-revision={artifact.draftRevision}
      className={className}
      style={style}
    >
      <div data-vortex-preview-banner="">
        <strong>Draft preview (simulated)</strong>
        <span>
          Revision {artifact.draftRevision}
          {artifact.currentReleaseRevision === null
            ? "; not yet published"
            : `; current release revision ${artifact.currentReleaseRevision} is not shown`}
        </span>
        {artifact.interactions.length === 0 ? null : (
          <span>{artifact.interactions.length} interaction(s) are simulated</span>
        )}
        {artifact.outcomes.length === 0 ? null : (
          <ul data-vortex-preview-outcomes="">
            {artifact.outcomes.map((outcome, index) => (
              <li key={`${outcome.kind}:${index}`}>{outcomeLabel(outcome)}</li>
            ))}
          </ul>
        )}
      </div>
      {renderFailure === undefined && resolvedSlot !== undefined ? (
        <PageLayoutRenderer
          composition={composition}
          registry={registry}
          pageId={artifact.pageId}
          {...(artifact.activeStepId === undefined ? {} : { activeStepId: artifact.activeStepId })}
          breakpoint={breakpoint}
          themeMode={themeMode}
          locale={locale}
          timeZone={timeZone}
          runtimeInputs={runtimeInputs}
        />
      ) : (
        <div data-vortex-preview-unavailable="">
          <p>This draft cannot be previewed as requested.</p>
          {renderFailure === undefined ? null : (
            <p>
              {renderFailure.code}: {renderFailure.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
