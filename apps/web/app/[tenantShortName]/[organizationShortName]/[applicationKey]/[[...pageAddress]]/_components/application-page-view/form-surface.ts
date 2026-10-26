import {
  getAccessibleName,
  placementSettings,
  type createPlatformComponentRegistryForReleases,
  type RenderedPage,
} from "@vortex/ui";
import {
  responsivePlacementSchema,
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  isRecord,
  walkPageComposition,
  walkPlacements,
  itemPropSlots,
  type VisitedPlacement,
} from "@vortex/platform/schema";

/** One placement of a form surface: its Vortex metadata and its typed settings. */
export type FormSurfacePlacement = Readonly<{
  vortex: Record<string, unknown>;
  settings: Readonly<Record<string, unknown>>;
}>;

/** A placement's typed settings, read by the declaration of its registered block release. */
const surfacePlacement = (
  registry: ReturnType<typeof createPlatformComponentRegistryForReleases>,
  placementId: string,
  props: Record<string, unknown>,
  vortex: Record<string, unknown>,
): FormSurfacePlacement => {
  const block = isRecord(vortex.block) ? vortex.block : {};
  const blockId = String(block.blockId);
  const releaseVersion = String(block.releaseVersion);
  const release = registry.get(blockId, releaseVersion)?.metadata;
  if (release === undefined)
    throw new Error(
      `Placement '${placementId}' names unregistered block release '${blockId}:${releaseVersion}'`,
    );
  return {
    vortex,
    settings: placementSettings(props, release, { placementId, blockId, releaseVersion }),
  };
};

/** Finds the form ancestor that owns each placement in the rendered page tree. */
export const isPlatformRelease = (
  registry: ReturnType<typeof createPlatformComponentRegistryForReleases>,
  block: unknown,
  identity: Readonly<{ key: string; releaseVersion: string }>,
): boolean => {
  if (
    !isRecord(block) ||
    typeof block.blockId !== "string" ||
    typeof block.releaseVersion !== "string"
  )
    return false;
  const release = registry.get(block.blockId, block.releaseVersion)?.metadata;
  return release?.key === identity.key && release.releaseVersion === identity.releaseVersion;
};

/**
 * The nearest ancestor of each placement (itself included) that is a placement of one block
 * release: the form that owns a field, or the Record detail whose record a header action acts on.
 */
export const ownersByPlacement = (
  page: Readonly<Record<string, unknown>>,
  registry: ReturnType<typeof createPlatformComponentRegistryForReleases>,
  identity: Readonly<{ key: string; releaseVersion: string }>,
): Readonly<Record<string, string>> => {
  const owners: Record<string, string> = {};
  walkPageComposition(page.composition, ({ placementId, vortex }, ancestor: string | undefined) => {
    const owner = isPlatformRelease(registry, vortex.block, identity) ? placementId : ancestor;
    if (owner !== undefined) owners[placementId] = owner;
    return owner;
  });
  return owners;
};

/** The authored Form container and its descendants, when that form is on this projected page. */
export const formSurfaceComposition = (
  page: Readonly<Record<string, unknown>>,
  pageId: string,
  formId: string,
  registry: ReturnType<typeof createPlatformComponentRegistryForReleases>,
):
  | Readonly<{
      composition: RenderedPage;
      placementIds: readonly string[];
      placements: Readonly<Record<string, FormSurfacePlacement>>;
    }>
  | undefined => {
  let match: VisitedPlacement | undefined;
  let matchId: string | undefined;
  let matchUsable = false;
  let matches = 0;
  walkPageComposition(
    page.composition,
    (placement, usable: boolean) => {
      const { placementId } = placement;
      const currentlyUsable = usable && placement.vortex.availability === undefined;
      if (placementId.toLowerCase() === formId.toLowerCase()) {
        match = placement;
        matchId = placementId;
        matchUsable = currentlyUsable;
        matches += 1;
      }
      return currentlyUsable;
    },
    true,
  );
  if (
    match === undefined ||
    matchId === undefined ||
    matches !== 1 ||
    !matchUsable ||
    !isPlatformRelease(
      registry,
      (match as VisitedPlacement).vortex.block,
      PLATFORM_BLOCK_RELEASE_IDENTITIES.FORM_CONTAINER_BLOCK_RELEASE,
    )
  )
    return undefined;
  const form: VisitedPlacement = match;

  const sourceResponsive = form.vortex.responsive;
  if (!isRecord(sourceResponsive)) return undefined;
  const desktop = sourceResponsive.desktop;
  const tablet = sourceResponsive.tablet;
  const phone = sourceResponsive.phone;
  const responsive = responsivePlacementSchema.safeParse(sourceResponsive);
  if (!responsive.success || !isRecord(desktop) || !isRecord(tablet) || !isRecord(phone))
    return undefined;
  // The modal shows the form whatever its page layout hides at a breakpoint.
  const modalVortex: Record<string, unknown> = {
    ...form.vortex,
    responsive: {
      desktop: { ...desktop, visible: true },
      tablet: { ...tablet, visible: true },
      phone: { ...phone, visible: true },
    },
  };
  const modalRoot = { ...form.item, props: { ...form.props, vortex: modalVortex } };

  const placementIds = new Set<string>();
  const placements: Record<string, FormSurfacePlacement> = {};
  const collect = ({ placementId, props, vortex }: VisitedPlacement): undefined => {
    placementIds.add(placementId);
    placements[placementId] = surfacePlacement(registry, placementId, props, vortex);
  };
  placementIds.add(matchId);
  placements[matchId] = {
    vortex: modalVortex,
    settings: surfacePlacement(registry, matchId, form.props, form.vortex).settings,
  };
  for (const [, slot] of itemPropSlots(form.props)) walkPlacements(slot, collect);
  return {
    composition: {
      pageId,
      composition: {
        root: {
          props: { vortex: { slotOrders: { content: { tablet: [matchId], phone: [matchId] } } } },
        },
        content: [modalRoot],
      } as unknown as Extract<RenderedPage["composition"], { content: unknown }>,
    },
    placementIds: [...placementIds],
    placements,
  };
};

const isVisibleInCurrentDocument = (element: HTMLElement): boolean => {
  if (!element.isConnected || element.getClientRects().length === 0) return false;
  for (
    let current: HTMLElement | null = element;
    current !== null;
    current = current.parentElement
  ) {
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
  registry: ReturnType<typeof createPlatformComponentRegistryForReleases>,
): string | undefined => {
  if (typeof document === "undefined") return undefined;
  const surface = formSurfaceComposition(page, pageId, formId, registry);
  if (surface === undefined) return undefined;
  const ownerForm = surface.placements[formId];
  const ownerBlock = ownerForm?.vortex.block;
  if (
    !isPlatformRelease(
      registry,
      ownerBlock,
      PLATFORM_BLOCK_RELEASE_IDENTITIES.FORM_CONTAINER_BLOCK_RELEASE,
    )
  )
    return undefined;
  const matchingPlacements = surface.placementIds.flatMap((placementId) => {
    const placement = surface.placements[placementId];
    const block = placement?.vortex.block;
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

  const forms = [
    ...document.querySelectorAll<HTMLFormElement>('form[data-vortex-control="form-container"]'),
  ].filter((form) => form.dataset.vortexPlacementId === formId && isVisibleInCurrentDocument(form));
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
  placement: FormSurfacePlacement,
  value: unknown,
  registry: ReturnType<typeof createPlatformComponentRegistryForReleases>,
): Record<string, unknown> => {
  const block = placement.vortex.block;
  if (!isRecord(block) || typeof block.blockId !== "string") return input;
  const blockId = block.blockId.toLowerCase();
  const releaseVersion = String(block.releaseVersion);
  const settings = placement.settings;
  const release = registry.get(blockId, releaseVersion)?.metadata;
  if (release === undefined)
    throw new Error(
      `Show form default names unregistered block release '${blockId}:${releaseVersion}'`,
    );
  const identities = PLATFORM_BLOCK_RELEASE_IDENTITIES;
  let control: string | undefined;
  if (release.key === identities.FIELD_INPUT_BLOCK_RELEASE.key) {
    const selected = settings.control;
    control =
      isRecord(selected) && selected.kind === "choice" && typeof selected.value === "string"
        ? selected.value
        : undefined;
  } else if (release.key === identities.CHOICE_INPUT_BLOCK_RELEASE.key) {
    control = "choice";
  } else if (release.key === identities.TEXT_INPUT_BLOCK_RELEASE.key) {
    control = "text";
  } else if (release.key === identities.NUMBER_INPUT_BLOCK_RELEASE.key) {
    control = "number";
  } else if (release.key === identities.BOOLEAN_INPUT_BLOCK_RELEASE.key) {
    control = "boolean";
  } else if (release.key === identities.DATE_INPUT_BLOCK_RELEASE.key) {
    control = "date";
  }
  const payloadKind: Readonly<Record<string, string>> = {
    text: "text_input",
    number: "number_input",
    boolean: "boolean_input",
    date: "date_input",
    date_time: "date_time_input",
    choice: "choice_input",
  };
  const kind = control === undefined ? undefined : payloadKind[control];
  if (kind === undefined) return input;
  if (control === "text" && typeof value !== "string") return input;
  if (
    control === "number" &&
    value !== null &&
    (typeof value !== "number" || !Number.isFinite(value))
  )
    return input;
  if (control === "boolean" && typeof value !== "boolean") return input;
  if (
    control === "date" &&
    value !== null &&
    (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
  )
    return input;
  // A date-time default is an offset-bearing ISO timestamp (a Flow `date_time` value).
  if (
    control === "date_time" &&
    value !== null &&
    (typeof value !== "string" ||
      Number.isNaN(Date.parse(value)) ||
      !/(Z|[+-]\d{2}:\d{2})$/.test(value))
  )
    return input;
  if (control === "choice") {
    if (typeof value !== "string") return input;
    const data = input.data;
    const projectedValues =
      isRecord(data) && data.status === "ready" && isRecord(data.values) ? data.values : undefined;
    const projectedOptions = Array.isArray(projectedValues?.options) ? projectedValues.options : [];
    const authoredOptions = settings.options;
    const authoredKeys =
      isRecord(authoredOptions) &&
      authoredOptions.kind === "list" &&
      Array.isArray(authoredOptions.items)
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
