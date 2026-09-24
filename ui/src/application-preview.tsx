import type { CSSProperties, ReactElement } from "react";
import type { ComponentSemanticEventKind, FlowEffectKind } from "@vortex/contracts";
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
import type { PlatformComponentRegistry } from "./registry";
import {
  parseProjectedDataByPlacement,
  type DisplayEventHandlers,
  type DisplayEventsByPlacement,
  type DisplaySemanticEventName,
  type ProjectedDataByPlacement,
} from "./display/projected-data";
import {
  CONTROL_EVENT_NAMES,
  parseProjectedControlDataByPlacement,
  type ControlEventHandlers,
  type ControlEventsByPlacement,
  type ControlSemanticEventName,
  type ProjectedControlDataByPlacement,
} from "./controls/projected-data";
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

export type ApplicationPreviewDataOrigin = "labelled_sample" | "authorized_read";

export type ApplicationPreviewSimulatedEffect =
  | "read"
  | "change"
  | "background_start"
  | "form_interaction";

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
  flowKind: "application_owned" | "platform_managed";
  flowId: string;
  declaredEffects: readonly FlowEffectKind[];
  simulatedNodes: readonly ApplicationPreviewFlowNodeSimulation[];
  simulated: true;
}>;

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
  composition: MaterialisedApplicationCompositionV2;
  interactions: readonly ApplicationPreviewInteraction[];
  displaySampleDataByPlacement: Readonly<Record<string, unknown>>;
  controlSampleDataByPlacement: Readonly<Record<string, unknown>>;
  outcomes: readonly ApplicationPreviewOutcome[];
  suppressedEffects: readonly FlowEffectKind[];
}>;

const DISPLAY_EVENT_NAMES: readonly DisplaySemanticEventName[] = Object.freeze([
  "refresh",
  "row_action",
  "selection_changed",
  "sort_changed",
  "page_changed",
]);

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

const parseFlowNodeSimulation = (value: unknown): ApplicationPreviewFlowNodeSimulation => {
  const record = requireObject(value, "A preview flow-node simulation must be an object");
  return {
    nodeId: requireString(record.nodeId, "A preview flow-node simulation requires a node identity"),
    nodeKind: requireString(record.nodeKind, "A preview flow-node simulation requires a node kind"),
    ...(record.targetKind === undefined
      ? {}
      : { targetKind: requireString(record.targetKind, "A preview flow-node target kind is invalid") }),
    simulatedEffect: requireString(
      record.simulatedEffect,
      "A preview flow-node simulation requires a simulated effect",
    ) as ApplicationPreviewSimulatedEffect,
    label: requireString(record.label, "A preview flow-node simulation requires a label"),
  };
};

const parseInteraction = (value: unknown): ApplicationPreviewInteraction => {
  const record = requireObject(value, "A preview interaction must be an object");
  if (record.simulated !== true) fail("A preview interaction must be explicitly simulated");
  const flowKind = record.flowKind;
  if (flowKind !== "application_owned" && flowKind !== "platform_managed")
    fail("A preview interaction requires a known flow kind");
  return {
    bindingId: requireString(record.bindingId, "A preview interaction requires a binding identity"),
    controlId: requireString(record.controlId, "A preview interaction requires a control identity"),
    eventId: requireString(record.eventId, "A preview interaction requires an event identity"),
    event: requireString(record.event, "A preview interaction requires an event name") as ComponentSemanticEventKind,
    flowKind,
    flowId: requireString(record.flowId, "A preview interaction requires a flow identity"),
    declaredEffects: requireArray(
      record.declaredEffects,
      "A preview interaction requires declared effects",
    ).map((effect) => requireString(effect, "A preview interaction effect is invalid")) as readonly FlowEffectKind[],
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
    case "preview_available": {
      const source = record.source;
      if (source !== "definition" && source !== "labelled_sample" && source !== "authorized_read")
        fail("A preview availability outcome requires a known data source");
      return {
        kind: "preview_available",
        placementId: requireString(record.placementId, "A preview outcome requires a placement"),
        source,
      };
    }
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
  const installedReleaseRevision = record.installedReleaseRevision;
  if (installedReleaseRevision !== null && typeof installedReleaseRevision !== "number")
    fail("A preview artifact requires its installed release revision or null");
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
    installedReleaseRevision:
      installedReleaseRevision === null ? null : requireRevision(installedReleaseRevision, "An installed release revision is invalid"),
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
        (effect) => requireString(effect, "A suppressed preview effect is invalid"),
      ) as readonly FlowEffectKind[],
    ),
  });
};

const collectPlacementIds = (slot: PlacementSlotV2, into: Set<string>): void => {
  for (const [placementId, placement] of Object.entries(slot.placements)) {
    into.add(placementId);
    for (const child of Object.values(placement.slots)) collectPlacementIds(child, into);
  }
};

const onlyKnownPlacements = (
  values: Readonly<Record<string, unknown>>,
  placementIds: ReadonlySet<string>,
): Readonly<Record<string, unknown>> =>
  Object.freeze(
    Object.fromEntries(Object.entries(values).filter(([placementId]) => placementIds.has(placementId))),
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
  const location: DefinitionRenderErrorLocation = { pageId: artifact.pageId, breakpoint };
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
    validatePlacementTree(resolvedSlot, registry, location, { allowEmptyRequiredSlots: false });
  } catch (error) {
    renderFailure =
      error instanceof DefinitionRenderError
        ? error
        : new DefinitionRenderError("INVALID_COMPOSITION", "The preview composition could not be rendered", location);
  }

  const availablePlacementIds = new Set<string>();
  if (resolvedSlot !== undefined) collectPlacementIds(resolvedSlot, availablePlacementIds);

  let projectedData: ProjectedDataByPlacement = {};
  let controlData: ProjectedControlDataByPlacement = {};
  try {
    projectedData = parseProjectedDataByPlacement(
      onlyKnownPlacements(artifact.displaySampleDataByPlacement, availablePlacementIds),
      location,
    );
    controlData = parseProjectedControlDataByPlacement(
      onlyKnownPlacements(artifact.controlSampleDataByPlacement, availablePlacementIds),
      location,
    );
  } catch (error) {
    renderFailure =
      error instanceof DefinitionRenderError
        ? error
        : new DefinitionRenderError(
            "INVALID_COMPOSITION",
            "The preview sample data could not be read",
            location,
          );
  }

  const displayEvents: Record<string, DisplayEventHandlers> = {};
  const controlEvents: Record<string, ControlEventHandlers> = {};
  for (const interaction of artifact.interactions) {
    if (!availablePlacementIds.has(interaction.controlId)) continue;
    const handler = () => onSimulation?.(interaction);
    if (DISPLAY_EVENT_NAMES.includes(interaction.event as DisplaySemanticEventName))
      displayEvents[interaction.controlId] = {
        ...(displayEvents[interaction.controlId] ?? {}),
        [interaction.event as DisplaySemanticEventName]: handler,
      };
    if (CONTROL_EVENT_NAMES.includes(interaction.event as ControlSemanticEventName))
      controlEvents[interaction.controlId] = {
        ...(controlEvents[interaction.controlId] ?? {}),
        [interaction.event as ControlSemanticEventName]: handler,
      };
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
          {artifact.installedReleaseRevision === null
            ? "; no installed release"
            : `; installed revision ${artifact.installedReleaseRevision} is not shown`}
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
          projectedData={projectedData}
          displayEvents={displayEvents as DisplayEventsByPlacement}
          controlData={controlData}
          controlEvents={controlEvents as ControlEventsByPlacement}
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
