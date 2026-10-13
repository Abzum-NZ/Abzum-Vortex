import {
  getAccessibleName,
  type FieldInputControlReleaseMap,
  type createFullPlatformComponentRegistry,
  type ProjectedPageCapability,
} from "@vortex/ui";
import {
  responsivePlacementSchema,
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
} from "@vortex/platform/schema";
import { isRecord } from "./event-values";

/** Finds the form ancestor that owns each placement in the rendered page tree. */
export const isPlatformRelease = (
  registry: ReturnType<typeof createFullPlatformComponentRegistry>,
  block: unknown,
  identity: Readonly<{ key: string; releaseVersion: string }>,
): boolean => {
  if (!isRecord(block) || typeof block.blockId !== "string" || typeof block.releaseVersion !== "string")
    return false;
  const release = registry.get(block.blockId, block.releaseVersion)?.metadata;
  return release?.key === identity.key && release.releaseVersion === identity.releaseVersion;
};

export const formOwnersByPlacement = (
  page: Readonly<Record<string, unknown>>,
  registry: ReturnType<typeof createFullPlatformComponentRegistry>,
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
      const owner = isPlatformRelease(
        registry,
        block,
        PLATFORM_BLOCK_RELEASE_IDENTITIES.FORM_CONTAINER_BLOCK_RELEASE,
      ) ? placementId : formOwner;
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
export const formSurfaceComposition = (
  page: Readonly<Record<string, unknown>>,
  pageId: string,
  formId: string,
  registry: ReturnType<typeof createFullPlatformComponentRegistry>,
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
    !isPlatformRelease(registry, match.block, PLATFORM_BLOCK_RELEASE_IDENTITIES.FORM_CONTAINER_BLOCK_RELEASE)
  )
    return undefined;

  const sourceResponsive = match.responsive;
  if (!isRecord(sourceResponsive)) return undefined;
  const desktop = sourceResponsive.desktop;
  const tablet = sourceResponsive.tablet;
  const phone = sourceResponsive.phone;
  const responsive = responsivePlacementSchema.safeParse(sourceResponsive);
  if (
    !responsive.success ||
    !isRecord(desktop) ||
    !isRecord(tablet) ||
    !isRecord(phone)
  )
    return undefined;
  const modalRoot: Record<string, unknown> = {
    ...match,
    responsive: {
      desktop: { ...desktop, visible: true },
      tablet: { ...tablet, visible: true },
      phone: { ...phone, visible: true },
    },
  };

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
  collect(matchId, modalRoot);
  const rootSlot = {
    placements: { [matchId]: modalRoot },
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
export const visibleOwningFormFieldLabel = (
  page: Readonly<Record<string, unknown>>,
  pageId: string,
  formId: string,
  fieldKey: string,
  registry: ReturnType<typeof createFullPlatformComponentRegistry>,
): string | undefined => {
  if (typeof document === "undefined") return undefined;
  const surface = formSurfaceComposition(page, pageId, formId, registry);
  if (surface === undefined) return undefined;
  const ownerForm = surface.placements[formId];
  const ownerBlock = ownerForm?.block;
  if (
    !isPlatformRelease(registry, ownerBlock, PLATFORM_BLOCK_RELEASE_IDENTITIES.FORM_CONTAINER_BLOCK_RELEASE)
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
    const registration = registry.get(block.blockId, block.releaseVersion);
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
export const runtimeInputWithFormDefault = (
  input: Record<string, unknown>,
  placement: Record<string, unknown>,
  value: unknown,
  registry: ReturnType<typeof createFullPlatformComponentRegistry>,
  fieldInputControlReleases: FieldInputControlReleaseMap,
): Record<string, unknown> => {
  if (!isRecord(placement.block) || typeof placement.block.blockId !== "string") return input;
  const blockId = placement.block.blockId.toLowerCase();
  const settings = isRecord(placement.settings) ? placement.settings : {};
  let control = Object.entries(fieldInputControlReleases).find(
    ([, release]) => release.blockId.toLowerCase() === blockId,
  )?.[0];
  const releaseKey = registry.get(blockId, String(placement.block.releaseVersion))?.metadata.key;
  if (releaseKey === PLATFORM_BLOCK_RELEASE_IDENTITIES.FIELD_INPUT_BLOCK_RELEASE.key) {
    const selected = settings.control;
    control = isRecord(selected) && selected.kind === "choice" && typeof selected.value === "string"
      ? selected.value
      : undefined;
  } else if (releaseKey === PLATFORM_BLOCK_RELEASE_IDENTITIES.CHOICE_INPUT_BLOCK_RELEASE.key) {
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
