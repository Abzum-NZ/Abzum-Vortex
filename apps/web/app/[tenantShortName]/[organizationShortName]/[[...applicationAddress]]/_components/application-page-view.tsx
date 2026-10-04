"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ApplicationAccountActionsProvider,
  createFlowInvokeClient,
  createFlowRuntime,
  createFormBlockRuntime,
  createFullPlatformComponentRegistry,
  equalFormValue,
  getAccessibleName,
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  parseBoardPayload,
  FORM_CONTAINER_BLOCK_RELEASE,
  PageLayoutRenderer,
  UnsavedWorkProvider,
  useFlowIntentHost,
  useUnsavedWorkGuard,
  useUnsavedWorkRegistry,
  type ApplicationAccountActions,
  type ControlSemanticEvent,
  type ChoiceInputPayload,
  type DisplaySemanticEvent,
  type BoardPayload,
  type FlowDispatchResult,
  type FlowFormAnswer,
  type FlowFormIntent,
  type FlowInvokeClient,
  type FormFlowFeedback,
  type FormBlockRuntime,
  type LinkNavigationEnvironment,
  type ProjectedPageCapability,
  type ServerFlowResponse,
  parseChoiceInputPayload,
} from "@vortex/ui";
import {
  boardColumnContinuationRequestSchema,
  type BoardColumnSelector,
  CHOICE_INPUT_BLOCK_RELEASE,
  CHOICE_INPUT_BLOCK_RELEASE_1_1_0,
  CHOICE_INPUT_BLOCK_RELEASE_1_2_0,
  FIELD_INPUT_BLOCK_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
  formContinuationAnswerSchema,
  type ReferenceChoiceSelectionEvidenceMap,
  type ReferenceChoiceSelectionEvidence,
} from "@vortex/contracts";
import { Button } from "@vortex/ui/components/button";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vortex/ui/components/dialog";
import type {
  ApplicationPageModel,
  PageDataState,
  PlacementFlowBinding,
} from "../../../../_lib/application-page";
import {
  isCurrentComponentRequestGeneration,
  nextComponentRequestGeneration,
  type ComponentRequestGeneration,
} from "@vortex/app/component-result-state";
import { containedComponentIdSchema, recordIdSchema } from "@vortex/contracts";
import { rereadApplicationPlacements } from "../placement-refresh-action";
import { signOut } from "../../../../auth/actions";

type EditFormBaseline = ApplicationPageModel["editFormBaselines"][string];
import type {
  GuidedFormAbandonRequest,
  GuidedFormConfirmRequest,
  GuidedFormConfirmResult,
  GuidedFormStepActionResult,
  GuidedFormStepRequest,
} from "../../../../_lib/guided-form-steps";

type GuidedFormActions = Readonly<{
  advance: (request: GuidedFormStepRequest) => Promise<GuidedFormStepActionResult>;
  confirm: (request: GuidedFormConfirmRequest) => Promise<GuidedFormConfirmResult>;
  abandon: (
    request: GuidedFormAbandonRequest,
  ) => Promise<Readonly<{ kind: "abandoned" | "conflict" | "unavailable" | "temporarily_unavailable" }>>;
}>;

/**
 * The full component flow binding the browser runtime expects. A {@link PlacementFlowBinding} carries
 * only the identities the page needs; every event reaches the server by binding id and flow id, and
 * the server fills the flow's inputs from the installed binding, so its input map is not required here.
 */
type ComponentFlowBinding = Parameters<FormBlockRuntime["submit"]>[0];

const asComponentBinding = (
  placementId: string,
  binding: PlacementFlowBinding,
): ComponentFlowBinding =>
  ({
    bindingId: binding.bindingId,
    // The placement id and the binding's control id are the same stable identity.
    controlId: placementId,
    eventId: binding.eventId,
    event: binding.event,
    flow: { flowId: binding.flowId, inputs: {} },
  }) as ComponentFlowBinding;

/** One registry shared by every rendered application page. */
const platformComponentRegistry = createFullPlatformComponentRegistry();

/**
 * A placement's event callbacks. Display events and control events (the form's ready, reset and
 * submit) are both delivered through the one runtime-inputs map, so the key is the event name.
 */
type FormResetEvent = Extract<ControlSemanticEvent, { event: "form_reset" }>;
type EventHandlers = Record<string, (event: never) => void> & {
  form_reset?: (event: FormResetEvent) => void | Promise<void>;
};
type Notice = Readonly<{ tone: "info" | "problem"; text: string }>;
type SubmittedForm = Readonly<{
  formId: string;
  values: Readonly<Record<string, unknown>>;
  choiceEvidence?: ReferenceChoiceSelectionEvidenceMap;
}>;

/**
 * The fixed sentence for each safe flow outcome. The endpoint returns only the outcome, never a
 * server message, so what a person reads is the same whatever the flow did.
 */
const outcomeNotices: Readonly<Record<string, Notice>> = {
  completed: { tone: "info", text: "Done." },
  committed: { tone: "info", text: "Saved." },
  refused: {
    tone: "problem",
    text: "The operation was refused by current access rules or operation policy. Review your access and the submitted values.",
  },
  conflict: { tone: "problem", text: "This changed since you opened it. Refresh and review it." },
  validation: {
    tone: "problem",
    text: "One or more submitted values do not match the operation's required format or rules. Review each field and its allowed values.",
  },
  partial: {
    tone: "problem",
    text: "Only part of this was saved. Refresh and review what changed.",
  },
  uncertain: {
    tone: "problem",
    text: "The result is not certain yet. Refresh before trying again.",
  },
  background_pending: { tone: "info", text: "Started. It will finish in the background." },
  failed: { tone: "problem", text: "That did not work. Try again." },
};

const unavailableNotice: Notice = { tone: "problem", text: "That is not available right now." };
// The UI parser accepts at most 200 options in one projected choice payload.
const maximumVisibleChoices = 200;

/**
 * A run that reached a task the platform cannot run yet. It is not a refusal, so the person is
 * never told they lack a permission for it.
 */
const notAvailableNotice: Notice = { tone: "problem", text: "This is not available yet." };

/** The notice for a finished run: its safe outcome, unless a task was not available. */
const finishedNotice = (outcome: string | undefined, failureCode: unknown): Notice =>
  failureCode === "task_not_available"
    ? notAvailableNotice
    : (outcomeNotices[outcome ?? "failed"] ?? unavailableNotice);

const refusalNotices: Readonly<
  Record<Extract<FormFlowFeedback, { kind: "refusal" }>["code"], Notice>
> = {
  invalid_command: { tone: "problem", text: "The supplied inputs are invalid." },
  duplicate_conflict: { tone: "problem", text: "A conflicting item already exists." },
  stale_revision: { tone: "problem", text: "This item changed. Refresh and try again." },
};

/** The JSON a table cell reports when a surface hands it to a flow as a caller input. */
const cellToJson = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return null;
  const cell = value as Record<string, unknown>;
  switch (cell.kind) {
    case "text":
      return cell.text;
    case "number":
    case "boolean":
      return cell.value;
    case "date":
      return cell.iso;
    case "choice":
      return cell.key;
    case "link":
      return cell.address;
    default:
      return null;
  }
};

/**
 * What a component event supplies to its bound flow, by the caller input names the flow declares.
 * The vocabulary is closed and event-shaped: `record_id`, `record_ids`, `revision`, `field` and
 * `value`. A binding receives only the names it declares, and the endpoint refuses anything else.
 *
 * A row action carries the row's server-projected current revision exactly as an inline-edit commit
 * does, so a command that changes one existing row is bound at the revision the person actually saw.
 * The value comes from the projected row, never from anything the person types.
 */
const suppliedValues = (event: DisplaySemanticEvent): Record<string, unknown> => {
  switch (event.event) {
    case "row_clicked":
      return { record_id: event.recordId };
    case "row_action":
      return {
        record_id: event.recordId,
        ...(event.revision === undefined ? {} : { revision: event.revision }),
      };
    case "bulk_action":
      return { record_ids: [...event.recordIds] };
    case "inline_edit":
      return {
        record_id: event.recordId,
        field: event.field,
        value: cellToJson(event.value),
        ...(event.revision === undefined ? {} : { revision: event.revision }),
      };
    default:
      return {};
  }
};

/**
 * The one binding a control placement holds for an event its control emits without an event
 * identity. A placement that holds several for the same event names none, so nothing is guessed.
 */
const bindingOfEvent = (
  bindings: readonly PlacementFlowBinding[],
  event: string,
): PlacementFlowBinding | undefined => {
  const ofKind = bindings.filter((binding) => binding.event === event);
  return ofKind.length === 1 ? ofKind[0] : undefined;
};

const eventIdOf = (event: DisplaySemanticEvent): string | undefined =>
  "eventId" in event ? event.eventId : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const choiceScopeKey = (placementId: string, formId?: string): string =>
  formId === undefined ? placementId : `${formId}\u0000${placementId}`;

/** The keyed Show Form body owns its choice request lifetime, including Escape dismissal. */
function ChoiceFormLifetime({ children, mount, unmount, context, baseline }: Readonly<{
  children: ReactNode;
  mount: () => void;
  unmount: () => void;
  context: unknown;
  baseline: unknown;
}>): ReactElement {
  const callbacks = useRef({ mount, unmount });
  callbacks.current = { mount, unmount };
  useEffect(() => {
    const current = callbacks.current;
    current.mount();
    return current.unmount;
  }, [context, baseline]);
  return <>{children}</>;
}

/** Finds the form ancestor that owns each placement in the rendered page tree. */
const formOwnersByPlacement = (
  page: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> => {
  const owners: Record<string, string> = {};
  const visit = (slot: unknown, formOwner?: string): void => {
    if (!isRecord(slot)) return;
    if (!isRecord(slot.placements)) {
      for (const child of Object.values(slot)) visit(child, formOwner);
      return;
    }
    for (const [placementId, candidate] of Object.entries(slot.placements)) {
      if (!isRecord(candidate)) continue;
      const block = candidate.block;
      const owner =
        isRecord(block) &&
        typeof block.blockId === "string" &&
        block.blockId.toLowerCase() === FORM_CONTAINER_BLOCK_RELEASE.blockId.toLowerCase()
          ? placementId
          : formOwner;
      if (owner !== undefined) owners[placementId] = owner;
      if (isRecord(candidate.slots))
        for (const child of Object.values(candidate.slots)) visit(child, owner);
    }
  };
  const composition = page.composition;
  if (!isRecord(composition)) return owners;
  if ("main" in composition) visit(composition.main);
  else if (isRecord(composition.stepContent))
    for (const child of Object.values(composition.stepContent)) visit(child);
  return owners;
};

/** The authored Form container and its descendants, when that form is on this projected page. */
const formSurfaceComposition = (
  page: Readonly<Record<string, unknown>>,
  pageId: string,
  formId: string,
): Readonly<{
  composition: ProjectedPageCapability;
  placementIds: readonly string[];
  placements: Readonly<Record<string, Record<string, unknown>>>;
}> | undefined => {
  let match: Record<string, unknown> | undefined;
  let matchId: string | undefined;
  let matchUsable = false;
  let matches = 0;
  const visit = (slot: unknown, usable: boolean): void => {
    if (!isRecord(slot) || !isRecord(slot.placements)) return;
    for (const [placementId, candidate] of Object.entries(slot.placements)) {
      if (!isRecord(candidate)) continue;
      const currentlyUsable = usable && candidate.availability === undefined;
      if (placementId.toLowerCase() === formId.toLowerCase()) {
        match = candidate;
        matchId = placementId;
        matchUsable = currentlyUsable;
        matches += 1;
      }
      if (isRecord(candidate.slots))
        for (const child of Object.values(candidate.slots)) visit(child, currentlyUsable);
    }
  };
  const composition = page.composition;
  if (!isRecord(composition)) return undefined;
  if ("main" in composition) visit(composition.main, true);
  else if (isRecord(composition.stepContent))
    for (const root of Object.values(composition.stepContent)) visit(root, true);
  if (
    match === undefined ||
    matchId === undefined ||
    matches !== 1 ||
    !matchUsable ||
    !isRecord(match.block) ||
    typeof match.block.blockId !== "string" ||
    match.block.blockId.toLowerCase() !== FORM_CONTAINER_BLOCK_RELEASE.blockId.toLowerCase()
  )
    return undefined;

  const placementIds = new Set<string>();
  const placements: Record<string, Record<string, unknown>> = {};
  const collect = (placementId: string, placement: Record<string, unknown>): void => {
    placementIds.add(placementId);
    placements[placementId] = placement;
    if (!isRecord(placement.slots)) return;
    for (const slot of Object.values(placement.slots)) {
      if (!isRecord(slot) || !isRecord(slot.placements)) continue;
      for (const [childId, child] of Object.entries(slot.placements))
        if (isRecord(child)) collect(childId, child);
    }
  };
  collect(matchId, match);
  const rootSlot = {
    placements: { [matchId]: match },
    order: { desktop: [matchId], tablet: [matchId], phone: [matchId] },
  };
  return {
    composition: {
      pageId,
      type: "form",
      composition: { main: rootSlot },
    } as unknown as ProjectedPageCapability,
    placementIds: [...placementIds],
    placements,
  };
};

const isVisibleInCurrentDocument = (element: HTMLElement): boolean => {
  if (!element.isConnected || element.getClientRects().length === 0) return false;
  for (let current: HTMLElement | null = element; current !== null; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (
      current.hidden ||
      current.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    )
      return false;
  }
  return true;
};

/** Returns a label only when the current visible owning form contains this exact registered field. */
const visibleOwningFormFieldLabel = (
  page: Readonly<Record<string, unknown>>,
  pageId: string,
  formId: string,
  fieldKey: string,
): string | undefined => {
  if (typeof document === "undefined") return undefined;
  const surface = formSurfaceComposition(page, pageId, formId);
  if (surface === undefined) return undefined;
  const ownerForm = surface.placements[formId];
  const ownerBlock = ownerForm?.block;
  if (
    !isRecord(ownerBlock) ||
    typeof ownerBlock.blockId !== "string" ||
    ownerBlock.blockId.toLowerCase() !== FORM_CONTAINER_BLOCK_RELEASE.blockId.toLowerCase() ||
    ownerBlock.releaseVersion !== FORM_CONTAINER_BLOCK_RELEASE.releaseVersion
  )
    return undefined;
  const matchingPlacements = surface.placementIds.flatMap((placementId) => {
    const placement = surface.placements[placementId];
    const block = placement?.block;
    const settings = placement?.settings;
    if (
      !isRecord(block) ||
      typeof block.blockId !== "string" ||
      typeof block.releaseVersion !== "string" ||
      !isRecord(settings) ||
      !isRecord(settings.name) ||
      settings.name.kind !== "text" ||
      settings.name.value !== fieldKey
    )
      return [];
    const registration = platformComponentRegistry.get(block.blockId, block.releaseVersion);
    if (
      registration === undefined ||
      !registration.metadata.supportedEvents.includes("field_changed")
    )
      return [];
    const label = getAccessibleName(
      settings as Parameters<typeof getAccessibleName>[0],
      registration.metadata,
    );
    return label === undefined ? [] : [{ placementId, label }];
  });
  if (matchingPlacements.length !== 1) return undefined;

  const forms = [...document.querySelectorAll<HTMLFormElement>(
    'form[data-vortex-control="form-container"]',
  )].filter(
    (form) => form.dataset.vortexPlacementId === formId && isVisibleInCurrentDocument(form),
  );
  if (forms.length !== 1) return undefined;
  const fieldNodes = [...forms[0]!.querySelectorAll<HTMLElement>("[data-vortex-field-key]")].filter(
    (element) =>
      element.dataset.vortexFieldKey === fieldKey &&
      element.dataset.vortexPlacementId === matchingPlacements[0]!.placementId &&
      isVisibleInCurrentDocument(element),
  );
  return fieldNodes.length === 1 ? matchingPlacements[0]!.label : undefined;
};

/** Preserves the Show form task's scalar defaults on the matching authored control. */
const runtimeInputWithFormDefault = (
  input: Record<string, unknown>,
  placement: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> => {
  if (!isRecord(placement.block) || typeof placement.block.blockId !== "string") return input;
  const blockId = placement.block.blockId.toLowerCase();
  const settings = isRecord(placement.settings) ? placement.settings : {};
  let control = Object.entries(FIELD_INPUT_CONTROL_RELEASES).find(
    ([, release]) => release.blockId.toLowerCase() === blockId,
  )?.[0];
  if (blockId === FIELD_INPUT_BLOCK_RELEASE.blockId.toLowerCase()) {
    const selected = settings.control;
    control = isRecord(selected) && selected.kind === "choice" && typeof selected.value === "string"
      ? selected.value
      : undefined;
  } else if (
    blockId === CHOICE_INPUT_BLOCK_RELEASE.blockId.toLowerCase() ||
    blockId === CHOICE_INPUT_BLOCK_RELEASE_1_1_0.blockId.toLowerCase() ||
    blockId === CHOICE_INPUT_BLOCK_RELEASE_1_2_0.blockId.toLowerCase()
  ) {
    control = "choice";
  }
  const payloadKind: Readonly<Record<string, string>> = {
    text: "text_input",
    number: "number_input",
    boolean: "boolean_input",
    date: "date_input",
    choice: "choice_input",
  };
  const kind = control === undefined ? undefined : payloadKind[control];
  if (kind === undefined) return input;
  if (control === "text" && typeof value !== "string") return input;
  if (control === "number" && value !== null && (typeof value !== "number" || !Number.isFinite(value)))
    return input;
  if (control === "boolean" && typeof value !== "boolean") return input;
  if (
    control === "date" &&
    value !== null &&
    (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
  )
    return input;
  if (control === "choice") {
    if (typeof value !== "string") return input;
    const data = input.data;
    const projectedValues =
      isRecord(data) && data.status === "ready" && isRecord(data.values) ? data.values : undefined;
    const projectedOptions = Array.isArray(projectedValues?.options)
      ? projectedValues.options
      : [];
    const authoredOptions = settings.options;
    const authoredKeys =
      isRecord(authoredOptions) && authoredOptions.kind === "list" && Array.isArray(authoredOptions.items)
        ? authoredOptions.items.flatMap((item) =>
            isRecord(item) &&
            isRecord(item.properties) &&
            isRecord(item.properties.key) &&
            item.properties.key.kind === "text" &&
            typeof item.properties.key.value === "string"
              ? [item.properties.key.value]
              : [],
          )
        : [];
    const allowed =
      projectedOptions.some((option) => isRecord(option) && option.key === value) ||
      authoredKeys.includes(value);
    if (!allowed) return input;
  }
  const data = input.data;
  if (isRecord(data) && data.status === "disabled") return input;
  const currentValues =
    isRecord(data) && data.status === "ready" && isRecord(data.values) ? data.values : {};
  return {
    ...input,
    data: { status: "ready", values: { ...currentValues, kind, value } },
  };
};

/** Finds the semantic events each registered placement declares in the rendered page tree. */
const placementEventNamesByPage = (
  page: Readonly<Record<string, unknown>>,
): Readonly<Record<string, ReadonlySet<string>>> => {
  const eventNames: Record<string, ReadonlySet<string>> = {};
  const visit = (slot: unknown): void => {
    if (!isRecord(slot)) return;
    if (!isRecord(slot.placements)) {
      for (const child of Object.values(slot)) visit(child);
      return;
    }
    for (const [placementId, candidate] of Object.entries(slot.placements)) {
      if (!isRecord(candidate)) continue;
      const block = candidate.block;
      if (
        isRecord(block) &&
        typeof block.blockId === "string" &&
        typeof block.releaseVersion === "string"
      ) {
        const registration = platformComponentRegistry.get(block.blockId, block.releaseVersion);
        if (registration !== undefined)
          eventNames[placementId] = new Set(registration.metadata.supportedEvents);
      }
      if (isRecord(candidate.slots))
        for (const child of Object.values(candidate.slots)) visit(child);
    }
  };
  const composition = page.composition;
  if (!isRecord(composition)) return eventNames;
  if ("main" in composition) visit(composition.main);
  else if (isRecord(composition.stepContent))
    for (const child of Object.values(composition.stepContent)) visit(child);
  return eventNames;
};

/** Finds launcher placements whose row actions open through the addressed server action. */
const applicationLauncherPlacementIds = (page: Readonly<Record<string, unknown>>): Set<string> => {
  const placementIds = new Set<string>();
  const visit = (slot: unknown): void => {
    if (!isRecord(slot)) return;
    if (!isRecord(slot.placements)) {
      for (const child of Object.values(slot)) visit(child);
      return;
    }
    for (const [placementId, candidate] of Object.entries(slot.placements)) {
      if (!isRecord(candidate)) continue;
      const block = candidate.block;
      if (
        isRecord(block) &&
        typeof block.blockId === "string" &&
        block.blockId.toLowerCase() === APPLICATION_LAUNCHER_BLOCK_RELEASE.blockId.toLowerCase()
      )
        placementIds.add(placementId);
      if (isRecord(candidate.slots))
        for (const child of Object.values(candidate.slots)) visit(child);
    }
  };
  const composition = page.composition;
  if (!isRecord(composition)) return placementIds;
  if ("main" in composition) visit(composition.main);
  else if (isRecord(composition.stepContent))
    for (const child of Object.values(composition.stepContent)) visit(child);
  return placementIds;
};

const placementIdsInSlot = (candidate: unknown): ReadonlySet<string> => {
  const result = new Set<string>();
  const visit = (slot: unknown): void => {
    if (!isRecord(slot)) return;
    if (!isRecord(slot.placements)) {
      for (const child of Object.values(slot)) visit(child);
      return;
    }
    for (const [placementId, placement] of Object.entries(slot.placements)) {
      result.add(placementId);
      if (isRecord(placement) && isRecord(placement.slots))
        for (const child of Object.values(placement.slots)) visit(child);
    }
  };
  visit(candidate);
  return result;
};

/**
 * Finds the binding an event identity names. A legacy row action that names no control matches only
 * when the placement declares exactly one row-action binding, so it never guesses between several.
 */
const bindingFor = (
  bindings: readonly PlacementFlowBinding[],
  event: DisplaySemanticEvent,
): PlacementFlowBinding | undefined => {
  const ofKind = bindings.filter((binding) => binding.event === event.event);
  const eventId = eventIdOf(event);
  if (eventId !== undefined) return ofKind.find((binding) => binding.eventId === eventId);
  return ofKind.length === 1 ? ofKind[0] : undefined;
};

const boardPayloadFor = (candidate: unknown): BoardPayload | undefined => {
  if (!isRecord(candidate) || candidate.status !== "ready") return undefined;
  try {
    return parseBoardPayload(candidate.values);
  } catch {
    return undefined;
  }
};

const sameBoardSource = (left: BoardPayload, right: BoardPayload): boolean =>
  left.plan.moduleRootId.toLowerCase() === right.plan.moduleRootId.toLowerCase() &&
  left.plan.moduleReleaseVersion === right.plan.moduleReleaseVersion &&
  left.plan.queryId.toLowerCase() === right.plan.queryId.toLowerCase() &&
  left.choiceFieldId.toLowerCase() === right.choiceFieldId.toLowerCase() &&
  left.cardTitleFieldId.toLowerCase() === right.cardTitleFieldId.toLowerCase() &&
  left.cardFieldIds.length === right.cardFieldIds.length &&
  left.cardFieldIds.every((fieldId, index) =>
    fieldId.toLowerCase() === right.cardFieldIds[index]?.toLowerCase(),
  );

const boardBucketForSelector = (
  board: BoardPayload,
  selector: BoardColumnSelector,
): BoardPayload["unassigned"] | BoardPayload["columns"][number] | undefined =>
  selector.kind === "unassigned"
    ? board.unassigned
    : board.columns.find((column) => column.value === selector.value);

const mergeBoardContinuation = (
  current: BoardPayload,
  fresh: BoardPayload,
  selector: BoardColumnSelector,
): BoardPayload | undefined => {
  if (
    !sameBoardSource(current, fresh) ||
    current.columns.length !== fresh.columns.length ||
    current.columns.some(
      (column, index) =>
        column.value !== fresh.columns[index]?.value ||
        column.label !== fresh.columns[index]?.label,
    )
  )
    return undefined;
  const selectedCurrent = boardBucketForSelector(current, selector);
  const selectedFresh = boardBucketForSelector(fresh, selector);
  if (
    selectedCurrent?.page?.nextContinuationToken === undefined ||
    selectedFresh?.page === undefined ||
    selectedFresh.page === null
  )
    return undefined;
  const columns = fresh.columns.map((column, index) => ({
    ...column,
    page:
      selector.kind === "option" && column.value === selector.value
        ? column.page
        : (current.columns[index]?.page ?? null),
  }));
  const unassigned = {
    ...fresh.unassigned,
    page: selector.kind === "unassigned" ? fresh.unassigned.page : current.unassigned.page,
  };
  try {
    return parseBoardPayload({ ...fresh, columns, unassigned });
  } catch {
    // A duplicate live record identity or strict merged-shape mismatch triggers an initial reread.
    return undefined;
  }
};

const compatibleBoardRowAction = (
  bindings: readonly PlacementFlowBinding[],
): PlacementFlowBinding | undefined => {
  const rowActions = bindings.filter((binding) => binding.event === "row_action");
  if (rowActions.length !== 1) return undefined;
  const [binding] = rowActions;
  if (binding?.recordTypeId === undefined) return undefined;
  const canReceiveSelectedRecord = binding.callerInputs.some(
    (inputName) =>
      inputName === "record_id" ||
      (binding.selectedReadInputs ?? []).some(
        (selected) =>
          selected.callerInputName === inputName &&
          selected.recordTypeId.toLowerCase() === binding.recordTypeId?.toLowerCase(),
      ),
  );
  return canReceiveSelectedRecord ? binding : undefined;
};

/**
 * Renders one installed application page and carries out what its people do on it. Every
 * declared component event goes to the one flow endpoint with the exact installation and binding
 * the page was rendered from. Launcher row actions use the server-side permitted-application
 * recheck. After a write, only data placements affected by that source are re-read.
 */
export function ApplicationPageView({
  model,
  guidedFormActions,
  onOpenApplication,
  pageFeedback,
}: Readonly<{
  model: ApplicationPageModel;
  guidedFormActions: GuidedFormActions;
  onOpenApplication: (event: DisplaySemanticEvent) => Promise<void>;
  pageFeedback?: ReactNode;
}>): ReactElement {
  return (
    <UnsavedWorkProvider>
      <ApplicationPageViewContent
        model={model}
        guidedFormActions={guidedFormActions}
        onOpenApplication={onOpenApplication}
        pageFeedback={pageFeedback}
      />
    </UnsavedWorkProvider>
  );
}

function ApplicationPageViewContent({
  model,
  guidedFormActions,
  onOpenApplication,
  pageFeedback,
}: Readonly<{
  model: ApplicationPageModel;
  guidedFormActions: GuidedFormActions;
  onOpenApplication: (event: DisplaySemanticEvent) => Promise<void>;
  pageFeedback?: ReactNode;
}>): ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentSearch = searchParams.toString();
  const [selection, setSelection] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [choicePages, setChoicePages] = useState<Readonly<Record<string, ChoiceInputPayload>>>({});
  const [dialogChoicePages, setDialogChoicePages] = useState<
    Readonly<Record<string, ChoiceInputPayload>>
  >({});
  const [choicePagesOwner, setChoicePagesOwner] = useState(model);
  const activeChoicePages = choicePagesOwner === model ? choicePages : {};
  const activeDialogChoicePages = choicePagesOwner === model ? dialogChoicePages : {};
  const [refreshedPlacementData, setRefreshedPlacementData] = useState<
    | Readonly<{
        navigationKey: string;
        data: Readonly<Record<string, PageDataState>>;
        editFormBaselines: Readonly<Record<string, EditFormBaseline | null>>;
        subject?: ApplicationPageModel["subject"] | null;
      }>
    | undefined
  >(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [formFeedback, setFormFeedback] = useState<Readonly<Record<string, FormFlowFeedback>>>({});
  const [busy, setBusy] = useState(false);
  const [completedGuidedNavigationKey, setCompletedGuidedNavigationKey] = useState<string>();
  const requestedStepId = useRef<string | undefined>(undefined);
  const guidedSubmitInFlight = useRef(false);
  const [leavePromptOpen, setLeavePromptOpen] = useState(false);
  const unsavedWorkRegistry = useUnsavedWorkRegistry();
  const runtimeInputsRef = useRef<Readonly<Record<string, unknown>>>({});
  const dialogFormRef = useRef<HTMLDivElement>(null);
  const requestChoicePageRef = useRef<
    (
      placementId: string,
      event: Extract<ControlSemanticEvent, { event: "choices_requested" }>,
      formId?: string,
    ) => Promise<void>
  >(async () => undefined);
  const choiceRequestIdsRef = useRef<Record<string, number>>({});
  const choiceSelectionsRef = useRef<Record<string, Readonly<{
    key: string;
    evidence: ReferenceChoiceSelectionEvidence;
  }>>>({});
  const choiceDefaultContextsRef = useRef<Record<string, boolean>>({});
  const submittedFormsRef = useRef(new Map<string, SubmittedForm>());
  const continuingFormsRef = useRef(new Map<string, SubmittedForm>());
  const confirmationResolveRef = useRef<((leave: boolean) => void) | undefined>(undefined);
  const confirmationPromiseRef = useRef<Promise<boolean> | undefined>(undefined);
  const confirmDiscardUnsavedWork = useCallback((): Promise<boolean> => {
    if (confirmationPromiseRef.current !== undefined) return Promise.resolve(false);
    const confirmation = new Promise<boolean>((resolve) => {
      confirmationResolveRef.current = resolve;
    });
    confirmationPromiseRef.current = confirmation;
    setLeavePromptOpen(true);
    return confirmation;
  }, []);
  const settleDiscardConfirmation = useCallback(
    (leave: boolean) => {
      const resolve = confirmationResolveRef.current;
      if (resolve === undefined) return;
      confirmationResolveRef.current = undefined;
      confirmationPromiseRef.current = undefined;
      setLeavePromptOpen(false);
      if (leave) unsavedWorkRegistry?.clearAll();
      resolve(leave);
    },
    [unsavedWorkRegistry],
  );
  useEffect(
    () => () => {
      const resolve = confirmationResolveRef.current;
      confirmationResolveRef.current = undefined;
      confirmationPromiseRef.current = undefined;
      resolve?.(false);
    },
    [],
  );
  const { hasUnsavedWork, guard: unsavedWork } = useUnsavedWorkGuard(confirmDiscardUnsavedWork);

  const application = model.invocation;
  const formOwners = useMemo(() => formOwnersByPlacement(model.page), [model.page]);
  const placementEventNames = useMemo(
    () => placementEventNamesByPage(model.page),
    [model.page],
  );
  const launcherPlacements = useMemo(
    () => applicationLauncherPlacementIds(model.page),
    [model.page],
  );
  const serverDataRef = useRef(model.data);
  const serverDataGenerationRef = useRef(0);
  if (serverDataRef.current !== model.data) {
    serverDataRef.current = model.data;
    serverDataGenerationRef.current += 1;
  }
  const navigationBase = JSON.stringify([
    pathname,
    currentSearch,
    model.pageId,
    application.installationRevision,
    application.releaseKey,
    serverDataGenerationRef.current,
  ]);
  const navigationSequenceRef = useRef(0);
  const placementRequestsRef = useRef<{
    base: string;
    key: string;
    generations: Map<string, ComponentRequestGeneration>;
  }>({ base: "", key: "", generations: new Map<string, ComponentRequestGeneration>() });
  const boardContinuationInFlightRef = useRef(new Set<string>());
  if (placementRequestsRef.current.base !== navigationBase) {
    navigationSequenceRef.current += 1;
    placementRequestsRef.current = {
      base: navigationBase,
      key: `${navigationBase}:${navigationSequenceRef.current}`,
      generations: new Map(),
    };
  }
  const navigationKey = placementRequestsRef.current.key;
  const guidedFormCompleted = completedGuidedNavigationKey === navigationKey;
  const subject =
    refreshedPlacementData?.navigationKey === navigationKey &&
    refreshedPlacementData.subject !== undefined
      ? refreshedPlacementData.subject ?? undefined
      : model.subject;
  const currentPageKey = model.pages.find(
    (page) => page.pageId.toLowerCase() === model.pageId.toLowerCase(),
  )?.key;
  const guidedActivePlacementIds = useMemo(() => {
    const guidedForm = model.guidedForm;
    const composition = model.page.composition;
    if (!guidedForm || !isRecord(composition) || !isRecord(composition.stepContent))
      return undefined;
    return placementIdsInSlot(composition.stepContent[guidedForm.activeStepId]);
  }, [model.guidedForm, model.page]);
  const guidedActiveFormIds = useMemo(
    () =>
        guidedActivePlacementIds === undefined
        ? []
        : [...guidedActivePlacementIds].filter(
            (placementId) => formOwners[placementId] === placementId,
          ),
    [formOwners, guidedActivePlacementIds],
  );
  const guidedAddress = useMemo(
    () => ({
      tenantShortName: application.tenantShortName,
      organizationShortName: application.organizationShortName,
      applicationKey: application.applicationKey,
      pageKey: application.pageKey,
      ...(subject === undefined ? {} : { subjectRecordId: subject.recordId }),
    }),
    [application, subject],
  );
  const basePath = `/${encodeURIComponent(application.tenantShortName)}/${encodeURIComponent(application.organizationShortName)}/${encodeURIComponent(application.applicationKey)}`;
  const pageKeyOf = useMemo(
    () => new Map(model.pages.map((page) => [page.pageId.toLowerCase(), page.key])),
    [model.pages],
  );
  const resolvePageHref = useCallback(
    (pageId: string) => {
      const key = pageKeyOf.get(pageId.toLowerCase());
      return key === undefined ? basePath : `${basePath}/${encodeURIComponent(key)}`;
    },
    [basePath, pageKeyOf],
  );
  const refreshPlacements = useCallback(
    async (placementIds: readonly string[]): Promise<void> => {
      const pageKey = currentPageKey;
      const requestScope = placementRequestsRef.current;
      // A callback retained by an earlier page must not start a read in the new page's scope.
      if (pageKey === undefined || requestScope.key !== navigationKey) return;

      const requests = new Map<string, ComponentRequestGeneration>();
      for (const placementId of new Set(placementIds)) {
        const parsedId = containedComponentIdSchema.safeParse(placementId);
        if (!parsedId.success) continue;
        const key = parsedId.data.toLowerCase();
        const request = nextComponentRequestGeneration(
          requestScope.generations.get(key),
          parsedId.data,
          requestScope.key,
        );
        requestScope.generations.set(key, request);
        requests.set(key, request);
      }
      if (requests.size === 0) return;

      const loadedData = new Map<string, PageDataState>();
      const loadedBaselines = new Map<string, EditFormBaseline | null>();
      const loadedSubjects = new Map<string, ApplicationPageModel["subject"] | null>();
      const requestEntries = [...requests.entries()];
      for (let offset = 0; offset < requestEntries.length; offset += 500) {
        if (placementRequestsRef.current.key !== requestScope.key) return;
        const batch = requestEntries
          .slice(offset, offset + 500)
          .filter(([key, request]) =>
            isCurrentComponentRequestGeneration(requestScope.generations.get(key), request),
          );
        if (batch.length === 0) continue;

        let result: Awaited<ReturnType<typeof rereadApplicationPlacements>>;
        try {
          result = await rereadApplicationPlacements(
            {
              tenantShortName: application.tenantShortName,
              organizationShortName: application.organizationShortName,
              applicationKey: application.applicationKey,
              pageKey,
              installationRevision: application.installationRevision,
              search: currentSearch,
            },
            batch.map(([, request]) => request.componentId),
          );
        } catch {
          result = { kind: "temporarily_unavailable" };
        }
        if (placementRequestsRef.current.key !== requestScope.key) return;
        if (result.kind === "reload") {
          if (
            batch.some(([key, request]) =>
              isCurrentComponentRequestGeneration(requestScope.generations.get(key), request),
            )
          ) {
            router.refresh();
            return;
          }
          continue;
        }

        for (const [key, request] of batch) {
          if (
            !isCurrentComponentRequestGeneration(requestScope.generations.get(key), request)
          )
            continue;
          const data =
            result.kind === "available"
              ? Object.entries(result.data).find(([candidate]) => candidate.toLowerCase() === key)?.[1]
              : undefined;
          const baseline =
            result.kind === "available"
              ? Object.entries(result.editFormBaselines).find(
                  ([candidate]) => candidate.toLowerCase() === key,
                )?.[1] ?? null
              : null;
          loadedData.set(key, data ?? { status: "error" });
          loadedBaselines.set(key, baseline);
          const displayKey =
            Object.keys(model.data).find((candidate) => candidate.toLowerCase() === key) ??
            request.componentId;
          if (Object.hasOwn(model.editFormBaselines, displayKey) || baseline !== null)
            loadedSubjects.set(key, result.kind === "available" ? result.subject : null);
        }
      }

      const accepted: {
        key: string;
        request: ComponentRequestGeneration;
        placementId: string;
        data: PageDataState;
        editFormBaseline: EditFormBaseline | null;
        subject?: ApplicationPageModel["subject"] | null;
      }[] = [];
      for (const [key, request] of requests) {
        if (
          !loadedData.has(key) ||
          !isCurrentComponentRequestGeneration(requestScope.generations.get(key), request)
        )
          continue;
        const displayKey =
          Object.keys(model.data).find((candidate) => candidate.toLowerCase() === key) ??
          request.componentId;
        accepted.push({
          key,
          request,
          placementId: displayKey,
          data: loadedData.get(key) ?? { status: "error" },
          editFormBaseline: loadedBaselines.get(key) ?? null,
          ...(loadedSubjects.has(key) ? { subject: loadedSubjects.get(key) } : {}),
        });
      }
      if (accepted.length === 0) return;
      const refreshedChoices = new Set(
        accepted
          .filter((entry) =>
            isCurrentComponentRequestGeneration(requestScope.generations.get(entry.key), entry.request),
          )
          .map((entry) => entry.placementId),
      );
      if (refreshedChoices.size > 0) {
        for (const stateKey of Object.keys(choiceRequestIdsRef.current))
          if ([...refreshedChoices].some((placementId) =>
            stateKey === placementId || stateKey.endsWith(`\u0000${placementId}`),
          ))
            choiceRequestIdsRef.current[stateKey] =
              (choiceRequestIdsRef.current[stateKey] ?? 0) + 1;
        setChoicePages((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([placementId]) => !refreshedChoices.has(placementId)),
          ),
        );
        setDialogChoicePages((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([stateKey]) =>
              ![...refreshedChoices].some((placementId) =>
                stateKey.endsWith(`\u0000${placementId}`),
              ),
            ),
          ),
        );
      }
      setRefreshedPlacementData((current) => {
        const liveScope = placementRequestsRef.current;
        if (liveScope?.key !== requestScope.key) return current;
        const data = { ...(current?.navigationKey === requestScope.key ? current.data : {}) };
        const editFormBaselines = {
          ...(current?.navigationKey === requestScope.key ? current.editFormBaselines : {}),
        };
        let subject = current?.navigationKey === requestScope.key ? current.subject : undefined;
        let changed = false;
        for (const entry of accepted) {
          if (!isCurrentComponentRequestGeneration(liveScope.generations.get(entry.key), entry.request))
            continue;
          data[entry.placementId] = entry.data;
          editFormBaselines[entry.placementId] = entry.editFormBaseline;
          if (entry.subject !== undefined) subject = entry.subject;
          changed = true;
        }
        return changed
          ? { navigationKey: requestScope.key, data, editFormBaselines, subject }
          : current;
      });
    },
    [
      application,
      currentPageKey,
      currentSearch,
      model.data,
      model.editFormBaselines,
      navigationKey,
      router,
    ],
  );
  const refreshTargetsForBinding = useCallback(
    (bindingId: string): readonly string[] => {
      const match = Object.entries(model.refreshPlacementsByBinding).find(
        ([candidate]) => candidate.toLowerCase() === bindingId.toLowerCase(),
      );
      return match?.[1] ?? [];
    },
    [model.refreshPlacementsByBinding],
  );
  const currentData = useMemo(
    () =>
      refreshedPlacementData?.navigationKey === navigationKey
        ? { ...model.data, ...refreshedPlacementData.data }
        : model.data,
    [model.data, navigationKey, refreshedPlacementData],
  );
  const currentEditFormBaselines = useMemo(() => {
    const baselines = { ...model.editFormBaselines };
    if (refreshedPlacementData?.navigationKey === navigationKey)
      for (const [placementId, baseline] of Object.entries(
        refreshedPlacementData.editFormBaselines,
      )) {
        if (baseline === null) delete baselines[placementId];
        else baselines[placementId] = baseline;
      }
    return baselines;
  }, [model.editFormBaselines, navigationKey, refreshedPlacementData]);

  useEffect(() => {
    setBusy(false);
    setNotice(undefined);
    setFormFeedback({});
  }, [navigationKey]);

  useEffect(() => {
    setChoicePagesOwner(model);
    setChoicePages({});
    setDialogChoicePages({});
    choiceSelectionsRef.current = {};
    choiceDefaultContextsRef.current = {};
    for (const placementId of Object.keys(choiceRequestIdsRef.current))
      choiceRequestIdsRef.current[placementId] = (choiceRequestIdsRef.current[placementId] ?? 0) + 1;
  }, [model]);

  const parseChoicePage = useCallback(
    (placementId: string, values: unknown): ChoiceInputPayload =>
      parseChoiceInputPayload(values, { pageId: model.pageId, placementId },
        model.referenceChoiceInputs.find((field) => field.placementId === placementId)?.releaseVersion,
      ),
    [model.pageId, model.referenceChoiceInputs],
  );

  const choicePayloadFor = useCallback(
    (placementId: string, formId?: string): ChoiceInputPayload | undefined => {
      const key = choiceScopeKey(placementId, formId);
      const loaded = formId === undefined ? activeChoicePages[key] : activeDialogChoicePages[key];
      if (loaded !== undefined) return loaded;
      const data = currentData[placementId];
      if (!isRecord(data) || data.status !== "ready") return undefined;
      try {
        return parseChoicePage(placementId, data.values);
      } catch {
        return undefined;
      }
    },
    [activeChoicePages, activeDialogChoicePages, currentData, parseChoicePage],
  );

  const choiceEvidenceFor = useCallback(
    (
      formId: string,
      values: Readonly<Record<string, unknown>>,
      surface: "page" | "dialog" = "page",
    ): ReferenceChoiceSelectionEvidenceMap | undefined => {
      const evidence: Record<string, NonNullable<ChoiceInputPayload["optionEvidence"]>[string]> = {};
      for (const field of model.referenceChoiceInputs) {
        if (field.formId.toLowerCase() !== formId.toLowerCase()) continue;
        const selected = values[field.fieldKey];
        if (typeof selected !== "string") continue;
        const issued = choicePayloadFor(
          field.placementId,
          surface === "dialog" ? formId : undefined,
        )?.optionEvidence?.[selected];
        if (issued !== undefined) evidence[field.fieldKey] = issued;
      }
      return Object.keys(evidence).length === 0 ? undefined : evidence;
    },
    [choicePayloadFor, model.referenceChoiceInputs],
  );

  const requestChoicePage = useCallback(
    async (
      placementId: string,
      event: Extract<ControlSemanticEvent, { event: "choices_requested" }>,
      formId?: string,
    ): Promise<void> => {
      const stateKey = choiceScopeKey(placementId, formId);
      const field = model.referenceChoiceInputs.find((candidate) => candidate.placementId === placementId);
      const dependencyContext = model.referenceChoiceInputs.some((candidate) =>
        candidate.formId === field?.formId && candidate.dependency !== undefined,
      ) ? placementRequestsRef.current.key : undefined;
      const currentContext = (): boolean => dependencyContext === undefined ||
        placementRequestsRef.current.key === dependencyContext;
      const dependencyChoice = field?.dependency === undefined ? undefined :
        choiceSelectionsRef.current[choiceScopeKey(field.dependency.placementId, formId)];
      if (field?.dependency !== undefined && dependencyChoice === undefined) return;
      const selected = field?.dependency === undefined ||
        choiceSelectionsRef.current[stateKey]?.key === event.selectedKey;
      const requestId = (choiceRequestIdsRef.current[stateKey] ?? 0) + 1;
      choiceRequestIdsRef.current[stateKey] = requestId;
      try {
        const response = await fetch("/api/reference-choices", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify({
            tenantShortName: application.tenantShortName,
            organizationShortName: application.organizationShortName,
            applicationKey: application.applicationKey,
            pageKey: application.pageKey,
            placementId,
            installationRevision: application.installationRevision,
            releaseKey: application.releaseKey,
            ...(event.search === undefined ? {} : { search: event.search }),
            ...(event.continuationToken === undefined
              ? {}
              : { continuationToken: event.continuationToken }),
            ...(event.selectedKey === undefined || !selected ? {} : { selectedKey: event.selectedKey }),
            ...(event.selectedEvidence === undefined || !selected
              ? {}
              : { selectedEvidence: event.selectedEvidence }),
            ...(dependencyChoice === undefined ? {} : { dependencyChoice }),
          }),
        });
        const body: unknown = await response.json();
        if (!currentContext() || choiceRequestIdsRef.current[stateKey] !== requestId) return;
        if (
          isRecord(body) &&
          body.kind === "reload"
        ) {
          router.refresh();
          return;
        }
        if (!response.ok || !isRecord(body) || body.kind !== "completed") {
          setNotice(unavailableNotice);
          router.refresh();
          return;
        }
        const payload = parseChoicePage(placementId, body.values);
        if (dependencyChoice !== undefined && payload.dependencyKey !== dependencyChoice.key) return;
        const setPages = formId === undefined ? setChoicePages : setDialogChoicePages;
        setPages((current) => {
          if (!currentContext() || choiceRequestIdsRef.current[stateKey] !== requestId) return current;
          const previous = current[stateKey] ?? choicePayloadFor(placementId, formId);
          const append = event.continuationToken !== undefined && previous !== undefined &&
            previous.dependencyKey === payload.dependencyKey;
          const allOptions = append
            ? [
                ...new Map(
                  [...(previous.options ?? []), ...(payload.options ?? [])].map((option) => [
                    option.key,
                    option,
                  ]),
                ).values(),
              ]
            : (payload.options ?? []);
          const selected = allOptions.find((option) => option.key === payload.value);
          const recent = allOptions.slice(-maximumVisibleChoices);
          const options =
            selected !== undefined && !recent.some((option) => option.key === selected.key)
              ? [selected, ...recent.slice(1)]
              : recent;
          const availableEvidence = append
            ? { ...previous.optionEvidence, ...payload.optionEvidence }
            : (payload.optionEvidence ?? {});
          const optionEvidence = Object.fromEntries(
            options.map((option) => [option.key, availableEvidence[option.key]]),
          );
          return {
            ...current,
            [stateKey]: parseChoicePage(placementId, {
                kind: "choice_input",
                value: payload.value ?? null,
                options,
                optionEvidence,
                ...(payload.dependencyKey === undefined ? {} : { dependencyKey: payload.dependencyKey }),
                ...(payload.nextContinuationToken === undefined
                  ? {}
                  : { nextContinuationToken: payload.nextContinuationToken }),
                ...(payload.error === undefined ? {} : { error: payload.error }),
              }),
          };
        });
      } catch {
        if (currentContext() && choiceRequestIdsRef.current[stateKey] === requestId)
          setNotice(unavailableNotice);
      }
    },
    [application, choicePayloadFor, model.referenceChoiceInputs, parseChoicePage, router],
  );
  requestChoicePageRef.current = requestChoicePage;

  const clearChoiceForm = useCallback((formId: string, dialogFormId?: string): void => {
    const fields = model.referenceChoiceInputs.filter((field) =>
      field.formId.toLowerCase() === formId.toLowerCase(),
    );
    if (!fields.some((field) => field.dependency !== undefined)) return;
    const keys = new Set(fields.map((field) => choiceScopeKey(field.placementId, dialogFormId)));
    for (const key of keys) {
      delete choiceSelectionsRef.current[key];
      delete choiceDefaultContextsRef.current[key];
      choiceRequestIdsRef.current[key] = (choiceRequestIdsRef.current[key] ?? 0) + 1;
    }
    const setPages = dialogFormId === undefined ? setChoicePages : setDialogChoicePages;
    setPages((current) => {
      const pages = Object.fromEntries(Object.entries(current).filter(([key]) => !keys.has(key)));
      for (const field of fields)
        if (field.dependency !== undefined)
          pages[choiceScopeKey(field.placementId, dialogFormId)] = parseChoicePage(field.placementId, {
            kind: "choice_input", value: null, options: [], optionEvidence: {}, dependencyKey: null,
          });
      return pages;
    });
  }, [model.referenceChoiceInputs, parseChoicePage]);

  const initializeChoiceForm = useCallback((
    formId: string,
    dialogFormId?: string,
    defaults?: Readonly<Record<string, unknown>>,
  ): void => {
    clearChoiceForm(formId, dialogFormId);
    const fields = model.referenceChoiceInputs.filter((field) =>
      field.formId.toLowerCase() === formId.toLowerCase(),
    );
    if (!fields.some((field) => field.dependency !== undefined)) return;
    for (const field of fields) {
      if (field.dependency !== undefined) continue;
      const data = currentData[field.placementId];
      if (!isRecord(data) || data.status !== "ready") continue;
      let payload: ChoiceInputPayload;
      try { payload = parseChoicePage(field.placementId, data.values); } catch { continue; }
      const key = defaults !== undefined && Object.hasOwn(defaults, field.fieldKey)
        ? defaults[field.fieldKey] : payload.value;
      const evidence = typeof key === "string" ? payload.optionEvidence?.[key] : undefined;
      if (typeof key === "string" && evidence !== undefined &&
          payload.options?.some((option) => option.key === key))
        choiceSelectionsRef.current[choiceScopeKey(field.placementId, dialogFormId)] = { key, evidence };
    }
    const setPages = dialogFormId === undefined ? setChoicePages : setDialogChoicePages;
    for (const field of fields) {
      if (field.dependency === undefined) continue;
      const parent = choiceSelectionsRef.current[choiceScopeKey(field.dependency.placementId, dialogFormId)];
      if (parent === undefined) continue;
      const key = choiceScopeKey(field.placementId, dialogFormId);
      choiceDefaultContextsRef.current[key] = true;
      setPages((current) => ({ ...current, [key]: parseChoicePage(field.placementId, {
        kind: "choice_input", value: null, options: [], optionEvidence: {}, dependencyKey: parent.key,
      }) }));
      void requestChoicePageRef.current(field.placementId, { event: "choices_requested" }, dialogFormId);
    }
  }, [clearChoiceForm, currentData, model.referenceChoiceInputs, parseChoicePage]);

  useEffect(() => {
    const forms = new Set(model.referenceChoiceInputs.filter((field) => field.dependency !== undefined)
      .map((field) => field.formId));
    for (const formId of forms) initializeChoiceForm(formId);
    return () => {
      for (const formId of forms) clearChoiceForm(formId);
    };
  }, [clearChoiceForm, initializeChoiceForm, model.referenceChoiceInputs]);

  const changeChoiceField = useCallback((
    placementId: string,
    event: ControlSemanticEvent,
    dialogFormId?: string,
  ): void => {
    if (event.event !== "field_changed") return;
    const field = model.referenceChoiceInputs.find((candidate) => candidate.placementId === placementId);
    if (field === undefined || !model.referenceChoiceInputs.some((candidate) =>
      candidate.formId === field.formId && candidate.dependency !== undefined,
    )) return;
    const stateKey = choiceScopeKey(placementId, dialogFormId);
    if (field.dependency !== undefined) delete choiceDefaultContextsRef.current[stateKey];
    const previous = choiceSelectionsRef.current[stateKey]?.key;
    const payload = choicePayloadFor(placementId, dialogFormId);
    const evidence = typeof event.value === "string" ? payload?.optionEvidence?.[event.value] : undefined;
    const next = typeof event.value === "string" && evidence !== undefined &&
      payload?.options?.some((option) => option.key === event.value)
      ? { key: event.value, evidence } : undefined;
    if (next === undefined) delete choiceSelectionsRef.current[stateKey];
    else choiceSelectionsRef.current[stateKey] = next;
    if (previous === next?.key) return;
    const setPages = dialogFormId === undefined ? setChoicePages : setDialogChoicePages;
    for (const child of model.referenceChoiceInputs) {
      if (child.formId !== field.formId || child.dependency?.placementId !== placementId) continue;
      const key = choiceScopeKey(child.placementId, dialogFormId);
      delete choiceSelectionsRef.current[key];
      delete choiceDefaultContextsRef.current[key];
      choiceRequestIdsRef.current[key] = (choiceRequestIdsRef.current[key] ?? 0) + 1;
      setPages((current) => ({ ...current, [key]: parseChoicePage(child.placementId, {
        kind: "choice_input", value: null, options: [], optionEvidence: {}, dependencyKey: next?.key ?? null,
      }) }));
      if (next !== undefined)
        void requestChoicePageRef.current(child.placementId, { event: "choices_requested" }, dialogFormId);
    }
  }, [choicePayloadFor, model.referenceChoiceInputs, parseChoicePage]);

  useEffect(() => {
    if (!hasUnsavedWork) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!unsavedWork.hasUnsavedWork()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedWork, unsavedWork]);

  useEffect(() => {
    if (!hasUnsavedWork) return;
    const onDocumentClick = (event: MouseEvent): void => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target =
        event.target instanceof Element
          ? event.target
          : event.target instanceof Node
            ? event.target.parentElement
            : null;
      const anchor = target?.closest<HTMLAnchorElement>("a[href]");
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        (anchor.target !== "" && anchor.target.toLowerCase() !== "_self") ||
        anchor.hasAttribute("download")
      )
        return;
      let address: URL;
      try {
        address = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (!["http:", "https:"].includes(address.protocol) || !unsavedWork.hasUnsavedWork()) return;
      if (
        address.origin === window.location.origin &&
        address.pathname === window.location.pathname &&
        address.search === window.location.search
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        if (!(await unsavedWork.confirmDiscardUnsavedWork())) return;
        if (address.origin === window.location.origin)
          router.push(`${address.pathname}${address.search}${address.hash}`);
        else window.location.assign(address.href);
      })();
    };
    document.addEventListener("click", onDocumentClick, true);
    return () => document.removeEventListener("click", onDocumentClick, true);
  }, [hasUnsavedWork, router, unsavedWork]);

  /**
   * The one browser flow client and host (#1013): a form submit starts the bound flow on the server
   * and the runtime carries out every pause (another form or a confirmation) through a continuation,
   * which is returned exactly as the server issued it.
   */
  const flowClient = useMemo<FlowInvokeClient>(() => {
    const client = createFlowInvokeClient({
      address: {
        tenantShortName: application.tenantShortName,
        organizationShortName: application.organizationShortName,
        applicationKey: application.applicationKey,
        pageKey: application.pageKey,
      },
      installation: {
        installationRevision: application.installationRevision,
        releaseKey: application.releaseKey,
      },
      ...(subject === undefined ? {} : { subject }),
    });
    const recordResponse = (
      response: ServerFlowResponse,
      submission: SubmittedForm | undefined,
    ) => {
      if (submission === undefined) return;
      if (response.kind === "intent") {
        continuingFormsRef.current.set(response.continuation, submission);
      } else if (
        response.kind === "result" &&
        response.failure === undefined &&
        response.descriptor.commit === "confirmed"
      ) {
        // The server has confirmed the submitted values before its Navigate intent is presented.
        unsavedWorkRegistry?.markSaved(submission.formId, submission.values);
      }
    };
    return {
      startBinding: async (binding, callerInputs, clickId) => {
        const submission = submittedFormsRef.current.get(binding.bindingId);
        submittedFormsRef.current.delete(binding.bindingId);
        const inputs =
          submission?.choiceEvidence === undefined
            ? callerInputs
            : { ...callerInputs, choiceEvidence: submission.choiceEvidence };
        const response = await client.startBinding(binding, inputs, clickId);
        recordResponse(response, submission);
        return response;
      },
      resume: async (flowId, continuation, answer, evidence) => {
        const submission = continuingFormsRef.current.get(continuation);
        continuingFormsRef.current.delete(continuation);
        const response = await client.resume(flowId, continuation, answer, evidence);
        recordResponse(response, submission);
        return response;
      },
    };
  }, [application, subject, unsavedWorkRegistry]);
  const navigationEnvironment = useMemo<LinkNavigationEnvironment>(
    () => ({
      unsavedWork,
      recheckInternalTarget: async (target) => target.kind !== "external",
      navigateInternal: (target) => {
        if (target.kind !== "page") return;
        const parameters = new URLSearchParams();
        for (const [name, value] of Object.entries(target.parameters ?? {}))
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
            parameters.set(name, String(value));
        const query = parameters.toString();
        router.push(`${resolvePageHref(target.pageId)}${query === "" ? "" : `?${query}`}`);
      },
      resolveInternalAddress: (target) =>
        target.kind === "page" ? resolvePageHref(target.pageId) : basePath,
    }),
    [basePath, resolvePageHref, router, unsavedWork],
  );
  const renderForm = useCallback(
    (
      form: FlowFormIntent,
      controls: Readonly<{
        submit: (
          values: Extract<FlowFormAnswer, { kind: "submit" }>["values"],
          choiceEvidence?: ReferenceChoiceSelectionEvidenceMap,
        ) => void;
        cancel: () => void;
      }>,
    ) => {
      const surface = formSurfaceComposition(model.page, model.pageId, form.formId);
      if (surface === undefined)
        return (
          <div className="flex flex-col gap-4">
            <p role="alert">Form unavailable.</p>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={controls.cancel}>
                Cancel
              </Button>
            </DialogFooter>
          </div>
        );
      const scopedInputs: Record<string, unknown> = {};
      for (const placementId of surface.placementIds) {
        const current = runtimeInputsRef.current[placementId];
        let input: Record<string, unknown> = isRecord(current) ? current : {};
        const isReferenceChoice = model.referenceChoiceInputs.some(
          (field) => field.placementId === placementId &&
            field.formId.toLowerCase() === form.formId.toLowerCase(),
        );
        const dialogChoicePage =
          isReferenceChoice ? choicePayloadFor(placementId, form.formId) : undefined;
        if (dialogChoicePage !== undefined)
          input = { ...input, data: { status: "ready", values: dialogChoicePage } };
        const placement = surface.placements[placementId];
        const settings = placement !== undefined && isRecord(placement.settings)
          ? placement.settings
          : undefined;
        const name =
          settings !== undefined &&
          isRecord(settings.name) &&
          settings.name.kind === "text" &&
          typeof settings.name.value === "string"
            ? settings.name.value
            : undefined;
        const choiceField = model.referenceChoiceInputs.find((field) => field.placementId === placementId);
        const defaultValue = name === undefined ? undefined : form.inputs[name];
        const defaultEvidence = typeof defaultValue === "string"
          ? dialogChoicePage?.optionEvidence?.[defaultValue] : undefined;
        const dependentDefaultOffered = choiceField?.dependency === undefined ||
          (choiceDefaultContextsRef.current[choiceScopeKey(placementId, form.formId)] === true &&
            defaultEvidence !== undefined &&
            dialogChoicePage?.options?.some((option) => option.key === defaultValue) === true);
        if (
          placement !== undefined &&
          name !== undefined &&
          Object.hasOwn(form.inputs, name) && dependentDefaultOffered
        ) {
          input = runtimeInputWithFormDefault(input, placement, form.inputs[name]);
          if (choiceField?.dependency !== undefined && typeof defaultValue === "string" &&
              defaultEvidence !== undefined) {
            choiceSelectionsRef.current[choiceScopeKey(placementId, form.formId)] = {
              key: defaultValue,
              evidence: defaultEvidence,
            };
          }
        }
        const events: Record<string, unknown> = {};
        if (placementId.toLowerCase() === form.formId.toLowerCase())
          events.form_submit = (event: ControlSemanticEvent) => {
            if (event.event !== "form_submit") return;
            const answer = formContinuationAnswerSchema.safeParse({
              kind: "submit",
              values: event.values,
            });
            if (!answer.success || answer.data.kind !== "submit") {
              setNotice(unavailableNotice);
              return;
            }
            controls.submit(
              answer.data.values,
              choiceEvidenceFor(form.formId, event.values, "dialog"),
            );
          };
        else if (isReferenceChoice)
          events.choices_requested = (event: ControlSemanticEvent) => {
            if (event.event !== "choices_requested") return;
            return requestChoicePageRef.current(placementId, event, form.formId);
          };
        if (isReferenceChoice)
          events.field_changed = (event: ControlSemanticEvent) =>
            changeChoiceField(placementId, event, form.formId);
        if (placementId.toLowerCase() === form.formId.toLowerCase())
          events.form_reset = (event: ControlSemanticEvent) => {
            if (event.event === "form_reset")
              initializeChoiceForm(form.formId, form.formId, form.inputs);
          };
        const modalInput: Record<string, unknown> = {};
        if (input.data !== undefined) modalInput.data = input.data;
        if (Object.keys(events).length > 0) modalInput.events = events;
        if (Object.keys(modalInput).length > 0) scopedInputs[placementId] = modalInput;
      }
      return (
        <ChoiceFormLifetime
          key={form.taskId}
          context={model}
          baseline={currentData}
          mount={() => initializeChoiceForm(form.formId, form.formId, form.inputs)}
          unmount={() => clearChoiceForm(form.formId, form.formId)}
        >
        <div ref={dialogFormRef} className="flex flex-col gap-4">
          <UnsavedWorkProvider>
            <PageLayoutRenderer
              composition={surface.composition}
              registry={platformComponentRegistry}
              pageId={model.pageId}
              theme={model.theme}
              projectedNavigation={model.navigation}
              resolvePageHref={resolvePageHref}
              currentPageId={model.pageId}
              runtimeInputs={scopedInputs}
            />
          </UnsavedWorkProvider>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={controls.cancel}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => dialogFormRef.current?.querySelector("form")?.requestSubmit()}
            >
              Continue
            </Button>
          </DialogFooter>
        </div>
        </ChoiceFormLifetime>
      );
    },
    [choiceEvidenceFor, choicePayloadFor, changeChoiceField, clearChoiceForm,
      currentData, initializeChoiceForm, model, resolvePageHref],
  );
  const { host, element: intentHostElement } = useFlowIntentHost({
    renderForm,
    navigation: navigationEnvironment,
  });
  // One flow runtime per host, shared by every event of the page: a gesture dispatches its bound
  // flow once through the one invoke client, and every pause and presentation intent is carried out
  // by the same host before the next answer is sent.
  const flowRuntime = useMemo(
    () => createFlowRuntime({ client: flowClient, host }),
    [flowClient, host],
  );
  const formBlock = useMemo(() => createFormBlockRuntime(flowRuntime), [flowRuntime]);

  /** A page's own view state (sort, filter, search) lives in its address, so it can be shared and reloaded. */
  const setQuery = useCallback(
    (change: (parameters: URLSearchParams) => void) => {
      const parameters = new URLSearchParams(searchParams.toString());
      change(parameters);
      const query = parameters.toString();
      router.replace(query === "" ? pathname : `${pathname}?${query}`);
    },
    [pathname, router, searchParams],
  );

  /**
   * Reports a server-driven flow's safe outcome for any gesture. The runtime already carried out
   * every pause through a continuation and every presentation intent through the host; only the
   * final outcome is shown, and affected placements re-read their persisted data after a write. A
   * gesture the form block ignored because the same binding is already running leaves the page as
   * that run set it.
   */
  const applyDispatch = useCallback(
    async (
      dispatch: Promise<FlowDispatchResult | undefined>,
      formPlacementId?: string,
      afterAccepted?: () => Promise<Notice | undefined>,
      sourceBindingId?: string,
    ) => {
      const isCurrentNavigation = (): boolean =>
        placementRequestsRef.current.key === navigationKey;
      setBusy(true);
      setNotice(undefined);
      if (formPlacementId !== undefined)
        setFormFeedback((current) => {
          if (!Object.hasOwn(current, formPlacementId)) return current;
          const next = { ...current };
          delete next[formPlacementId];
          return next;
        });
      const showResult = (
        resultNotice: Notice,
        refusalFeedback?: Extract<FormFlowFeedback, { kind: "refusal" }>,
      ): void => {
        if (formPlacementId === undefined) {
          setNotice(resultNotice);
        } else {
          setNotice(undefined);
          setFormFeedback((current) => ({
            ...current,
            [formPlacementId]: refusalFeedback ?? {
              kind: "message",
              tone: resultNotice.tone === "problem" ? "problem" : "success",
              text: resultNotice.text,
            },
          }));
        }
      };
      let settles = true;
      try {
        const result = await dispatch;
        if (!isCurrentNavigation()) return;
        if (result === undefined) {
          settles = false;
          return;
        }
        if (result.ranIn === "browser") {
          showResult(unavailableNotice);
          return;
        }
        const server = result.result;
        if (server.kind === "reload") {
          return router.refresh();
        }
        if (server.kind === "finished") {
          let resultNotice = finishedNotice(server.descriptor.outcome, server.failure?.code);
          const diagnostic = server.failure?.diagnostic;
          const fieldLabel =
            diagnostic?.submittedField === undefined || formPlacementId === undefined
              ? undefined
              : visibleOwningFormFieldLabel(
                  model.page,
                  model.pageId,
                  formPlacementId,
                  diagnostic.submittedField,
                );
          const recovery =
            server.descriptor.outcome === "partial" || server.descriptor.outcome === "uncertain"
              ? server.descriptor.outcome
              : undefined;
          const refusalFeedback: Extract<FormFlowFeedback, { kind: "refusal" }> | undefined =
            diagnostic === undefined
              ? undefined
              : {
                  kind: "refusal" as const,
                  code: diagnostic.code,
                  ...(fieldLabel === undefined ? {} : { fieldLabel }),
                  ...(recovery === undefined ? {} : { recovery }),
                };
          if (diagnostic !== undefined) {
            const reason = refusalNotices[diagnostic.code];
            resultNotice = {
              ...reason,
              text: recovery === undefined ? reason.text : `${reason.text} ${resultNotice.text}`,
            };
          }
          if (
            afterAccepted !== undefined &&
            ["completed", "committed", "background_pending"].includes(
              server.descriptor.outcome,
            )
          ) {
            try {
              resultNotice = (await afterAccepted()) ?? resultNotice;
            } catch {
              resultNotice = unavailableNotice;
            }
          }
          if (!isCurrentNavigation()) return;
          showResult(resultNotice, refusalFeedback);
          // A finished guided-form submission may have abandoned its draft. Keep the journey
          // visible but inactive until a new page load establishes the next draft.
          if (
            model.guidedForm !== undefined &&
            (afterAccepted !== undefined ||
              server.descriptor.commit === "confirmed" ||
              server.descriptor.commit === "partial")
          )
            setCompletedGuidedNavigationKey(navigationKey);
          if (
            (server.descriptor.commit === "confirmed" || server.descriptor.commit === "partial") &&
            sourceBindingId !== undefined
          )
            void refreshPlacements(refreshTargetsForBinding(sourceBindingId));
          return;
        }
        if (server.kind === "refused") {
          showResult(unavailableNotice);
          return;
        }
        if (server.kind === "abandoned") {
          // The run may have committed a step before the answer was lost: never report nothing.
          showResult(outcomeNotices.uncertain ?? unavailableNotice);
          if (model.guidedForm !== undefined) setCompletedGuidedNavigationKey(navigationKey);
          if (sourceBindingId !== undefined)
            void refreshPlacements(refreshTargetsForBinding(sourceBindingId));
          return;
        }
        showResult(unavailableNotice);
      } catch {
        if (isCurrentNavigation()) showResult(unavailableNotice);
      } finally {
        if (settles && isCurrentNavigation()) setBusy(false);
      }
    },
    [
      model.guidedForm,
      model.page,
      model.pageId,
      navigationKey,
      refreshPlacements,
      refreshTargetsForBinding,
      router,
    ],
  );

  const guidedSummaryStepId = useMemo(() => {
    if (!Array.isArray(model.page.steps)) return undefined;
    const summary = model.page.steps.find(
      (step) => isRecord(step) && step.summary === true && typeof step.id === "string",
    );
    return isRecord(summary) && typeof summary.id === "string" ? summary.id : undefined;
  }, [model.page]);
  const guidedPreviousStepId = useMemo(() => {
    const activeStepId = model.guidedForm?.activeStepId;
    if (activeStepId === undefined || !Array.isArray(model.page.steps)) return undefined;
    const activeIndex = model.page.steps.findIndex(
      (step) => isRecord(step) && step.id === activeStepId,
    );
    if (activeIndex <= 0) return undefined;
    const previous = model.page.steps[activeIndex - 1];
    return isRecord(previous) && typeof previous.id === "string" ? previous.id : undefined;
  }, [model.guidedForm?.activeStepId, model.page]);

  const advanceGuidedStep = useCallback(
    async (stepId: string, values: Readonly<Record<string, unknown>>, requested?: string) => {
      const guidedForm = model.guidedForm;
      if (guidedForm === undefined || busy || guidedFormCompleted) return;
      setBusy(true);
      setNotice(undefined);
      try {
        const result = await guidedFormActions.advance({
          address: guidedAddress,
          draftId: guidedForm.draftId,
          expectedRevision: guidedForm.revision,
          stepId,
          ...(requested === undefined ? {} : { requestedStepId: requested }),
          values,
        });
        if (result.kind === "updated" || result.kind === "unchanged") {
          if (result.kind === "updated" && !result.valid && result.activeStepId === stepId)
            setNotice({ tone: "problem", text: "Review the fields in this step before continuing." });
          const queryStep =
            result.activeStepId === result.computedStepId ? null : result.activeStepId;
          if (searchParams.get("step") === queryStep) router.refresh();
          else
            setQuery((parameters) => {
              if (queryStep === null) parameters.delete("step");
              else parameters.set("step", queryStep);
            });
          return;
        }
        if (result.kind === "conflict") {
          setNotice({ tone: "problem", text: "This draft changed in another session. Review the latest step." });
          router.refresh();
          return;
        }
        setNotice(unavailableNotice);
      } catch {
        setNotice(unavailableNotice);
      } finally {
        setBusy(false);
      }
    },
    [
      busy,
      guidedAddress,
      guidedFormActions,
      guidedFormCompleted,
      model.guidedForm,
      router,
      searchParams,
      setQuery,
    ],
  );

  const requestGuidedStep = useCallback(
    (requested?: string) => {
      const guidedForm = model.guidedForm;
      if (guidedForm === undefined || busy || guidedFormCompleted) return;
      if (requested !== undefined && guidedForm.activeStepId === guidedSummaryStepId) {
        void advanceGuidedStep(guidedForm.activeStepId, {}, requested);
        return;
      }
      requestedStepId.current = requested;
      const boundSummaryFormId =
        guidedForm.activeStepId === guidedSummaryStepId
          ? guidedActiveFormIds.find((placementId) =>
              (model.bindings[placementId] ?? []).some(
                (binding) =>
                  binding.event === "form_submit" &&
                  binding.flowId.toLowerCase() === guidedForm.flowId.toLowerCase(),
              ),
            )
          : undefined;
      const activeFormId = boundSummaryFormId ?? guidedActiveFormIds[0];
      const activeForm =
        activeFormId === undefined
          ? undefined
          : [...document.querySelectorAll<HTMLFormElement>(
              'form[data-vortex-control="form-container"]',
            )].find((form) => form.dataset.vortexPlacementId === activeFormId);
      if (activeForm !== undefined) {
        activeForm.requestSubmit();
        return;
      }
      requestedStepId.current = undefined;
      void advanceGuidedStep(guidedForm.activeStepId, {}, requested);
    },
    [
      advanceGuidedStep,
      busy,
      guidedFormCompleted,
      guidedActiveFormIds,
      guidedSummaryStepId,
      model.bindings,
      model.guidedForm,
    ],
  );

  const submitGuidedSummary = useCallback(
    async (
      placementId: string,
      binding: PlacementFlowBinding,
      submittedValues: Readonly<Record<string, unknown>>,
      selectedOwnerGroupId?: string,
    ) => {
      const guidedForm = model.guidedForm;
      if (
        guidedForm === undefined ||
        guidedSummaryStepId === undefined ||
        guidedForm.activeStepId !== guidedSummaryStepId ||
        binding.flowId.toLowerCase() !== guidedForm.flowId.toLowerCase() ||
        busy ||
        guidedFormCompleted ||
        guidedSubmitInFlight.current
      )
        return;
      guidedSubmitInFlight.current = true;
      setBusy(true);
      setNotice(undefined);
      let flowStarted = false;
      try {
        const confirmed = await guidedFormActions.confirm({
          address: guidedAddress,
          draftId: guidedForm.draftId,
          expectedRevision: guidedForm.revision,
          stepId: guidedForm.activeStepId,
        });
        if (confirmed.kind !== "confirmed") {
          setNotice(
            confirmed.kind === "conflict"
              ? { tone: "problem", text: "This draft changed in another session. Review the latest step." }
              : unavailableNotice,
          );
          if (confirmed.kind === "conflict") router.refresh();
          return;
        }
        const afterAccepted = async (): Promise<Notice | undefined> => {
          unsavedWorkRegistry?.markSaved(placementId, submittedValues);
          const abandoned = await guidedFormActions.abandon({
            address: guidedAddress,
            draftId: guidedForm.draftId,
            expectedRevision: guidedForm.revision,
          });
          return abandoned.kind === "abandoned"
            ? undefined
            : {
                tone: "problem",
                text: "The submission finished, but the saved draft could not be cleared. Refresh before submitting again.",
              };
        };
        const dispatch = formBlock.submit(
          asComponentBinding(placementId, binding),
          { $guidedFormConfirmation: confirmed.proof },
          selectedOwnerGroupId,
        );
        flowStarted = true;
        await applyDispatch(dispatch, placementId, afterAccepted, binding.bindingId);
      } catch {
        setNotice(unavailableNotice);
      } finally {
        guidedSubmitInFlight.current = false;
        if (!flowStarted) setBusy(false);
      }
    },
    [
      applyDispatch,
      busy,
      formBlock,
      guidedAddress,
      guidedFormActions,
      guidedFormCompleted,
      guidedSummaryStepId,
      guidedSubmitInFlight,
      model.guidedForm,
      router,
      unsavedWorkRegistry,
    ],
  );

  /**
   * Runs the flow bound to a display or action event through the same runtime as a form gesture.
   * The binding receives only the caller inputs it declares; the server fills the rest from the
   * installed binding and refuses anything else.
   */
  const runBinding = useCallback(
    (
      placementId: string,
      binding: PlacementFlowBinding,
      supplied: Record<string, unknown>,
      selectedRecordId?: string,
    ) => {
      const callerInputs = { ...supplied };
      for (const selectedReadInput of binding.selectedReadInputs ?? []) {
        delete callerInputs[selectedReadInput.callerInputName];
        if (
          binding.recordTypeId === undefined ||
          binding.recordTypeId.toLowerCase() !== selectedReadInput.recordTypeId.toLowerCase()
        )
          continue;
        const parsedRecordId = recordIdSchema.safeParse(selectedRecordId);
        if (!parsedRecordId.success) continue;
        callerInputs[selectedReadInput.callerInputName] = {
          recordTypeId: binding.recordTypeId,
          recordId: parsedRecordId.data,
        };
      }
      return applyDispatch(
        flowRuntime.dispatch(
          asComponentBinding(placementId, binding),
          Object.fromEntries(
            Object.entries(callerInputs).filter(([name]) => binding.callerInputs.includes(name)),
          ),
        ),
        formOwners[placementId],
        undefined,
        binding.bindingId,
      );
    },
    [applyDispatch, formOwners, flowRuntime],
  );

  const continueBoardColumn = useCallback(
    async (placementId: string, event: DisplaySemanticEvent): Promise<boolean> => {
      if (
        busy ||
        event.event !== "page_changed" ||
        !("column" in event) ||
        typeof event.continuationToken !== "string"
      )
        return false;
      const parsedId = containedComponentIdSchema.safeParse(placementId);
      const continuation = boardColumnContinuationRequestSchema.safeParse({
        column: event.column,
        continuationToken: event.continuationToken,
      });
      const requestScope = placementRequestsRef.current;
      if (
        !parsedId.success ||
        !continuation.success ||
        requestScope.key !== navigationKey ||
        currentPageKey === undefined
      )
        return false;

      const displayId =
        Object.keys(currentData).find((candidate) =>
          candidate.toLowerCase() === parsedId.data.toLowerCase(),
        ) ?? parsedId.data;
      const currentBoard = boardPayloadFor(currentData[displayId]);
      const currentBucket =
        currentBoard === undefined
          ? undefined
          : boardBucketForSelector(currentBoard, continuation.data.column);
      if (
        currentBoard === undefined ||
        currentBucket?.page?.nextContinuationToken !== continuation.data.continuationToken
      )
        return false;

      const serialKey = `${requestScope.key}\u0000${parsedId.data.toLowerCase()}`;
      if (boardContinuationInFlightRef.current.has(serialKey)) return false;
      boardContinuationInFlightRef.current.add(serialKey);
      const request = nextComponentRequestGeneration(
        requestScope.generations.get(parsedId.data.toLowerCase()),
        parsedId.data,
        requestScope.key,
      );
      requestScope.generations.set(parsedId.data.toLowerCase(), request);

      const clearAndReload = (): false => {
        if (
          placementRequestsRef.current.key === requestScope.key &&
          isCurrentComponentRequestGeneration(
            requestScope.generations.get(parsedId.data.toLowerCase()),
            request,
          )
        ) {
          setRefreshedPlacementData((current) => {
            const liveScope = placementRequestsRef.current;
            if (liveScope.key !== requestScope.key) return current;
            const prior = current?.navigationKey === requestScope.key ? current : undefined;
            return {
              navigationKey: requestScope.key,
              data: { ...(prior?.data ?? {}), [displayId]: { status: "error" } },
              editFormBaselines: { ...(prior?.editFormBaselines ?? {}) },
              ...(prior?.subject === undefined ? {} : { subject: prior.subject }),
            };
          });
          void refreshPlacements([parsedId.data]);
        }
        return false;
      };

      try {
        let result: Awaited<ReturnType<typeof rereadApplicationPlacements>>;
        try {
          result = await rereadApplicationPlacements(
            {
              tenantShortName: application.tenantShortName,
              organizationShortName: application.organizationShortName,
              applicationKey: application.applicationKey,
              pageKey: currentPageKey,
              installationRevision: application.installationRevision,
              search: currentSearch,
            },
            [parsedId.data],
            { placementId: parsedId.data, request: continuation.data },
          );
        } catch {
          result = { kind: "temporarily_unavailable" };
        }
        if (
          placementRequestsRef.current.key !== requestScope.key ||
          !isCurrentComponentRequestGeneration(
            requestScope.generations.get(parsedId.data.toLowerCase()),
            request,
          )
        )
          return false;
        if (result.kind === "reload") {
          router.refresh();
          return false;
        }
        if (result.kind !== "available") return clearAndReload();

        const returnedData = Object.entries(result.data).find(
          ([candidate]) => candidate.toLowerCase() === parsedId.data.toLowerCase(),
        )?.[1];
        const freshBoard = boardPayloadFor(returnedData);
        const mergedBoard =
          freshBoard === undefined
            ? undefined
            : mergeBoardContinuation(currentBoard, freshBoard, continuation.data.column);
        if (mergedBoard === undefined) return clearAndReload();

        setRefreshedPlacementData((current) => {
          const liveScope = placementRequestsRef.current;
          if (
            liveScope.key !== requestScope.key ||
            !isCurrentComponentRequestGeneration(
              liveScope.generations.get(parsedId.data.toLowerCase()),
              request,
            )
          )
            return current;
          const prior = current?.navigationKey === requestScope.key ? current : undefined;
          return {
            navigationKey: requestScope.key,
            data: {
              ...(prior?.data ?? {}),
              [displayId]: { status: "ready", values: mergedBoard },
            },
            editFormBaselines: { ...(prior?.editFormBaselines ?? {}) },
            ...(prior?.subject === undefined ? {} : { subject: prior.subject }),
          };
        });
        return true;
      } finally {
        boardContinuationInFlightRef.current.delete(serialKey);
      }
    },
    [
      application,
      busy,
      currentData,
      currentPageKey,
      currentSearch,
      navigationKey,
      refreshPlacements,
      router,
    ],
  );

  const runtimeInputs = useMemo(() => {
    const inputs: Record<string, unknown> = {};
    // A placement may hold bindings (a form submits) without holding projected data, so both key
    // sets are wired: every placement with data or with a flow binding receives its callbacks.
    const placementIds = new Set([
      ...Object.keys(currentData),
      ...Object.keys(model.bindings),
      ...Object.keys(formFeedback),
      ...guidedActiveFormIds,
      ...model.referenceChoiceInputs.filter((field) => field.dependency !== undefined)
        .map((field) => field.formId),
    ]);
    if (guidedActivePlacementIds !== undefined)
      for (const placementId of placementIds)
        if (!guidedActivePlacementIds.has(placementId)) placementIds.delete(placementId);
    for (const placementId of placementIds) {
      const data =
        guidedFormCompleted && guidedActiveFormIds.includes(placementId)
          ? ({ status: "disabled", reason: "Refresh to start another form." } as const)
          : currentData[placementId];
      const bindings = model.bindings[placementId] ?? [];
      const events: EventHandlers = {};
      const boardData = boardPayloadFor(data);
      const boardRowActionBinding =
        boardData === undefined ? undefined : compatibleBoardRowAction(bindings);
      const declaredEvents = placementEventNames[placementId];
      const supportsEvent = (eventName: string): boolean =>
        declaredEvents?.has(eventName) === true;
      const flowFeedback =
        formOwners[placementId] === placementId ? formFeedback[placementId] : undefined;
      // Runtime data alone does not identify a display: forms can have projected owner-group data.
      // Give each placement only the display callbacks its own registered release declares.
      if (data !== undefined && model.guidedForm === undefined) {
        if (launcherPlacements.has(placementId) && supportsEvent("row_action"))
          events.row_action = async (event: DisplaySemanticEvent) => {
            if (event.event !== "row_action" || busy) return;
            if (unsavedWork.hasUnsavedWork() && !(await unsavedWork.confirmDiscardUnsavedWork()))
              return;
            await onOpenApplication(event);
          };
        for (const kind of ["row_clicked", "row_action", "bulk_action", "inline_edit"] as const)
          if (
            supportsEvent(kind) &&
            (kind !== "row_action" ||
              (!launcherPlacements.has(placementId) && boardData === undefined)) &&
            bindings.some((binding) => binding.event === kind)
          )
            events[kind] = (event: DisplaySemanticEvent) => {
              const binding = bindingFor(bindings, event);
              if (binding !== undefined && !busy)
                void runBinding(
                  placementId,
                  binding,
                  suppliedValues(event),
                  event.event === "row_clicked" ||
                    event.event === "row_action" ||
                    event.event === "inline_edit"
                    ? event.recordId
                    : undefined,
                );
            };
        if (
          boardData !== undefined &&
          boardRowActionBinding !== undefined &&
          supportsEvent("row_action")
        )
          events.row_action = async (event: DisplaySemanticEvent) => {
            if (event.event !== "row_action" || event.eventId !== undefined || busy) return;
            await runBinding(
              placementId,
              boardRowActionBinding,
              suppliedValues(event),
              event.recordId,
            );
          };
        if (boardData !== undefined && supportsEvent("page_changed"))
          events.page_changed = (event: DisplaySemanticEvent) =>
            continueBoardColumn(placementId, event);
        if (supportsEvent("refresh"))
          events.refresh = () => {
            void refreshPlacements([placementId]);
          };
        if (supportsEvent("selection_changed"))
          events.selection_changed = (event: DisplaySemanticEvent) => {
            if (event.event !== "selection_changed") return;
            setSelection((current) => {
              const held = new Set(current[placementId] ?? []);
              if (event.selected) held.add(event.recordId);
              else held.delete(event.recordId);
              return { ...current, [placementId]: [...held] };
            });
          };
        if (supportsEvent("sort_changed"))
          events.sort_changed = (event: DisplaySemanticEvent) => {
            if (event.event !== "sort_changed") return;
            setQuery((parameters) =>
              parameters.set(`sort.${placementId}`, `${event.columnKey}:${event.direction}`),
            );
          };
        if (supportsEvent("filter_changed"))
          events.filter_changed = (event: DisplaySemanticEvent) => {
            if (event.event !== "filter_changed") return;
            setQuery((parameters) => {
              const name = `filter.${placementId}.${event.field}`;
              if (event.value === "") parameters.delete(name);
              else parameters.set(name, event.value);
            });
          };
        if (supportsEvent("search_changed"))
          events.search_changed = (event: DisplaySemanticEvent) => {
            if (event.event !== "search_changed") return;
            setQuery((parameters) => {
              if (event.query.trim() === "") parameters.delete(`search.${placementId}`);
              else parameters.set(`search.${placementId}`, event.query);
            });
          };
      }
      if (model.referenceChoiceInputs.some((field) => field.placementId === placementId))
        events.choices_requested = (event: ControlSemanticEvent) => {
          if (event.event !== "choices_requested") return;
          return requestChoicePageRef.current(placementId, event);
        };
      if (model.referenceChoiceInputs.some((field) => field.placementId === placementId))
        events.field_changed = (event: ControlSemanticEvent) => changeChoiceField(placementId, event);
      // An action button runs its bound flow through the same path as a display event. Inside a
      // form it reports the form's current values. A record page also supplies its verified page
      // subject for declared navigation bindings; the binding receives only the inputs it declares.
      const actionBinding = bindingOfEvent(bindings, "action");
      if (actionBinding !== undefined && model.guidedForm === undefined)
        events.action = (event: ControlSemanticEvent) => {
          if (event.event !== "action" || event.intent !== "activate" || busy) return;
          return runBinding(
            placementId,
            actionBinding,
            {
              ...(event.values ?? {}),
              ...(subject === undefined ? {} : { record_id: subject.recordId }),
            },
            subject?.recordId,
          );
        };
      // A form container emits its one submission for a gesture; it runs the bound flow once
      // through the runtime, which resumes every pause with the server-issued continuation.
      const submitBinding = bindings.find((binding) => binding.event === "form_submit");
      if (
        submitBinding !== undefined ||
        (model.guidedForm !== undefined && formOwners[placementId] === placementId)
      )
        events.form_submit = (event: ControlSemanticEvent) => {
          if (event.event !== "form_submit" || busy || guidedFormCompleted) return;
          if (model.guidedForm !== undefined) {
            const requested = requestedStepId.current;
            requestedStepId.current = undefined;
            if (model.guidedForm.activeStepId === guidedSummaryStepId) {
              if (submitBinding === undefined) setNotice(unavailableNotice);
              else void submitGuidedSummary(
                placementId,
                submitBinding,
                event.values,
                event.selectedOwnerGroupId,
              );
            }
            else
              void advanceGuidedStep(model.guidedForm.activeStepId, event.values, requested);
            return;
          }
          if (submitBinding === undefined) return;
          const baseline = currentEditFormBaselines[placementId];
          const values =
            baseline === undefined
              ? event.values
              : Object.fromEntries(
                  Object.entries(event.values).filter(
                    ([name, value]) =>
                      Object.hasOwn(baseline, name) && !equalFormValue(value, baseline[name]),
                  ),
                );
          if (baseline !== undefined && Object.keys(values).length === 0) {
            setNotice(undefined);
            setFormFeedback((current) => ({
              ...current,
              [placementId]: { kind: "message", tone: "success", text: "No changes to save." },
            }));
            return;
          }
          const choiceEvidence = choiceEvidenceFor(placementId, values);
          submittedFormsRef.current.set(submitBinding.bindingId, {
            formId: placementId,
            values: event.values,
            ...(choiceEvidence === undefined ? {} : { choiceEvidence }),
          });
          void applyDispatch(
            formBlock.submit(
              asComponentBinding(placementId, submitBinding),
              values,
              event.selectedOwnerGroupId,
            ),
            placementId,
            undefined,
            submitBinding.bindingId,
          );
        };
      const readyBinding = bindings.find((binding) => binding.event === "form_ready");
      if (readyBinding !== undefined && model.guidedForm === undefined)
        events.form_ready = (event: ControlSemanticEvent) => {
          if (event.event !== "form_ready" || busy) return;
          void applyDispatch(
            formBlock.ready(asComponentBinding(placementId, readyBinding)),
            undefined,
            undefined,
            readyBinding.bindingId,
          );
        };
      const resetBinding = bindings.find((binding) => binding.event === "form_reset");
      if (resetBinding !== undefined && model.guidedForm === undefined)
        events.form_reset = (event: ControlSemanticEvent) => {
          if (event.event !== "form_reset" || busy) return;
          setFormFeedback((current) => {
            if (!Object.hasOwn(current, placementId)) return current;
            const next = { ...current };
            delete next[placementId];
            return next;
          });
          void applyDispatch(
            formBlock.reset(asComponentBinding(placementId, resetBinding)),
            undefined,
            undefined,
            resetBinding.bindingId,
          );
        };
      if (model.referenceChoiceInputs.some((field) =>
        field.formId === placementId && field.dependency !== undefined,
      )) {
        const boundReset = events.form_reset;
        events.form_reset = (event: ControlSemanticEvent) => {
          if (event.event !== "form_reset") return;
          initializeChoiceForm(placementId);
          return boundReset?.(event);
        };
      }
      if (data === undefined) {
        if (Object.keys(events).length > 0 || flowFeedback !== undefined)
          inputs[placementId] = {
            ...(Object.keys(events).length === 0 ? {} : { events }),
            ...(flowFeedback === undefined ? {} : { flowFeedback }),
          };
        continue;
      }
      const held = selection[placementId];
      const ready = data as { status?: string; values?: Record<string, unknown> };
      inputs[placementId] = {
        data:
          activeChoicePages[placementId] !== undefined
            ? { status: "ready", values: activeChoicePages[placementId] }
            : ready.status === "ready" && ready.values?.kind === "table" && held !== undefined
              ? { ...ready, values: { ...ready.values, selectedRecordIds: held } }
              : data,
        events,
        ...(flowFeedback === undefined ? {} : { flowFeedback }),
      };
    }
    return inputs;
  }, [
    applyDispatch,
    busy,
    formBlock,
    formFeedback,
    formOwners,
    launcherPlacements,
    choiceEvidenceFor,
    changeChoiceField,
    initializeChoiceForm,
    activeChoicePages,
    model.referenceChoiceInputs,
    currentData,
    currentEditFormBaselines,
    guidedActivePlacementIds,
    guidedActiveFormIds,
    guidedFormCompleted,
    guidedSummaryStepId,
    advanceGuidedStep,
    submitGuidedSummary,
    model.bindings,
    model.guidedForm,
    placementEventNames,
    router,
    refreshPlacements,
    runBinding,
    requestChoicePage,
    selection,
    setQuery,
    subject,
    onOpenApplication,
    unsavedWork,
    continueBoardColumn,
  ]);

  runtimeInputsRef.current = runtimeInputs;
  const accountActions: ApplicationAccountActions = {
    organizationName: application.organizationShortName,
    chooseOrganization: async () => {
      if (unsavedWork.hasUnsavedWork() && !(await unsavedWork.confirmDiscardUnsavedWork())) return;
      router.push("/signed-in");
    },
    signOut: async () => {
      if (unsavedWork.hasUnsavedWork() && !(await unsavedWork.confirmDiscardUnsavedWork())) return;
      await signOut();
    },
  };

  return (
    <>
      <ApplicationAccountActionsProvider actions={accountActions}>
      <PageLayoutRenderer
        applicationSurface
        feedback={pageFeedback === undefined && notice === undefined &&
          model.bodyContentAvailable !== false ? undefined : (
          <>
            {pageFeedback}
            {model.bodyContentAvailable !== false ? null : (
              <Alert role="status" aria-live="polite">
                <AlertDescription>No page content is available.</AlertDescription>
              </Alert>
            )}
            {notice === undefined ? null : (
              <Alert
                variant={notice.tone === "problem" ? "destructive" : "default"}
                role={notice.tone === "problem" ? "alert" : "status"}
                aria-live="polite"
                data-vortex-notice={notice.tone}
              >
                <AlertDescription>{notice.text}</AlertDescription>
              </Alert>
            )}
          </>
        )}
        composition={model.page as unknown as ProjectedPageCapability}
        registry={platformComponentRegistry}
        shells={model.shells}
        pageId={model.pageId}
        theme={model.theme}
        projectedNavigation={model.navigation}
        resolvePageHref={resolvePageHref}
        currentPageId={model.pageId}
        {...(model.guidedForm === undefined
          ? {}
          : {
              activeStepId: model.guidedForm.activeStepId,
              guidedSummaryValues: model.guidedForm.values,
            })}
        runtimeInputs={runtimeInputs}
        {...(model.guidedForm === undefined
          ? {}
          : {
              guidedStepNavigation: {
                  disabled: busy || guidedFormCompleted,
                  onBack: () => {
                    if (guidedPreviousStepId !== undefined)
                      requestGuidedStep(guidedPreviousStepId);
                  },
                  onNext: () => requestGuidedStep(),
              },
            })}
      />
      </ApplicationAccountActionsProvider>
      {intentHostElement}
      <Dialog
        open={leavePromptOpen}
        disablePointerDismissal
        onOpenChange={(open) => {
          if (!open) settleDiscardConfirmation(false);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Leave this page?</DialogTitle>
            <DialogDescription>Your unsaved changes will be lost.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row">
            <Button
              type="button"
              variant="secondary"
              autoFocus
              onClick={() => settleDiscardConfirmation(false)}
            >
              Stay
            </Button>
            <Button type="button" onClick={() => settleDiscardConfirmation(true)}>
              Leave
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
