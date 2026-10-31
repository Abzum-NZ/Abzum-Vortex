import {
  type PermittedApplicationsRead,
  type PermittedApplication,
  type InstalledRuntimeContext,
  type BoundHumanOrganizationRequest,
  type OptionFilterKey,
  createStoredPageCapabilityService,
  requireProjectedPlacement,
  CHOICE_INPUT_BLOCK_RELEASE,
  LINK_INPUT_BLOCK_RELEASE,
  TEXT_INPUT_BLOCK_RELEASE,
  DATE_INPUT_BLOCK_RELEASE,
  FIELD_INPUT_BLOCK_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
  FORM_CONTAINER_BLOCK_RELEASE,
  placementSettings,
  fieldControl,
  planChoiceOptionGates,
  decideChoiceOptionGates,
  applyChoiceOptionGates,
} from "@vortex/platform/server";
import {
  type ApplicationContent,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  isRecord,
  sameId,
  walkPageComposition,
  walkPlacementData,
  type VisitedPlacement,
} from "@vortex/platform/schema";
import { loadInstalledContext, requestDependencies } from "./installed-context";
import { platformPermissionSource } from "../platform-permission-source";
import { withContributedFormPlacements, withContributedPlacements } from "./contributed-placements";
import {
  collectPlacements,
  isLinkInputPlacement,
  linkInputTargets,
  placementOptionFilter,
  projectedUseAvailability,
} from "./placement-helpers";

export type OptionsPageResult =
  | Readonly<{ kind: "reload" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export type OptionsAddress = Readonly<{
  read: Extract<PermittedApplicationsRead, { kind: "available" }>;
  application: PermittedApplication;
  pageKey: string;
  /** The installed context this same request's own HUMAN address read authorized. */
  installedContext?: InstalledRuntimeContext;
}>;

/** Uses the page's own option gates for a published control value. */
export const validateProjectedControlOption = async (
  bound: BoundHumanOrganizationRequest,
  context: InstalledRuntimeContext,
  projectedPage: Readonly<Record<string, unknown>>,
  placementId: string,
  value: string,
  parsedValue: unknown,
  subject: Readonly<{ recordTypeId: string; recordId: string }> | undefined,
  held: Parameters<typeof applyChoiceOptionGates>[2],
  validateLink: (
    placementId: string,
    selected: Readonly<{ recordTypeId: string; recordId: string }>,
  ) => Promise<boolean>,
): Promise<boolean> => {
  const gate = requireProjectedPlacement(projectedPage, placementId);
  if (gate.kind !== "on_page") return false;
  const props = structuredClone(gate.placement.props);
  const placement = {
    props,
    vortex: gate.placement.vortex,
    settings: placementSettings(props),
  };
  if (fieldControl(placement) === "choice" || fieldControl(placement) === "several_choices") {
    const plan = planChoiceOptionGates([placement], context);
    if (plan === undefined) return false;
    const allowed = await decideChoiceOptionGates(bound.transaction, plan, subject);
    applyChoiceOptionGates(plan, allowed, held);
    return (
      Array.isArray(props.options) &&
      props.options.some((option) => isRecord(option) && option.key === value)
    );
  }
  const block = gate.placement.vortex.block;
  if (
    fieldControl(placement) === "link" ||
    (isRecord(block) &&
      typeof block.blockId === "string" &&
      sameId(block.blockId, LINK_INPUT_BLOCK_RELEASE.blockId))
  )
    return (
      isRecord(parsedValue) &&
      typeof parsedValue.recordTypeId === "string" &&
      typeof parsedValue.recordId === "string" &&
      (await validateLink(placementId, {
        recordTypeId: parsedValue.recordTypeId,
        recordId: parsedValue.recordId,
      }))
    );
  if (
    isRecord(block) &&
    typeof block.blockId === "string" &&
    sameId(block.blockId, CHOICE_INPUT_BLOCK_RELEASE.blockId)
  )
    return (
      Array.isArray(props.options) &&
      props.options.some((option) => isRecord(option) && option.key === value)
    );
  return (
    fieldControl(placement) === "text" ||
    (isRecord(block) &&
      typeof block.blockId === "string" &&
      (sameId(block.blockId, TEXT_INPUT_BLOCK_RELEASE.blockId) ||
        sameId(block.blockId, DATE_INPUT_BLOCK_RELEASE.blockId)))
  );
};

/** A form field whose value is one of the options a source offers: the record a link input picks. */
export type ProjectedOptionsField = Readonly<{
  fieldKey: string;
  placementId: string;
  recordTypes: readonly Readonly<{ moduleRootId: string; recordTypeId: string }>[];
  optionFilter?: OptionFilterKey;
}>;

export type ProjectedOptionsForm = Readonly<{
  fields: ReadonlyMap<string, ProjectedOptionsField>;
}>;

/**
 * The option-sourced fields (link inputs) of the one usable Form on the viewer's projected page,
 * by the field key they publish. Undefined when the form is not on the page, is not usable, or two
 * of its fields share a key.
 */
export const projectedOptionsForm = (
  page: Readonly<Record<string, unknown>>,
  formId: string,
): ProjectedOptionsForm | undefined => {
  const placements = collectPlacements(page);
  const form = placements.filter((placement) => sameId(placement.placementId, formId));
  if (form.length !== 1 || projectedUseAvailability(form[0]!) !== "available") return undefined;
  const fields = new Map<string, ProjectedOptionsField>();
  for (const placement of placements) {
    if (
      placement.formId === undefined ||
      !sameId(placement.formId, formId) ||
      !isLinkInputPlacement(placement) ||
      projectedUseAvailability(placement) !== "available"
    )
      continue;
    const name = placement.settings.name;
    if (!isRecord(name) || name.kind !== "text" || typeof name.value !== "string") continue;
    if (fields.has(name.value)) return undefined;
    const optionFilter = placementOptionFilter(placement.settings);
    fields.set(name.value, {
      fieldKey: name.value,
      placementId: placement.placementId,
      recordTypes: linkInputTargets(placement.settings),
      ...(optionFilter === undefined ? {} : { optionFilter }),
    });
  }
  return { fields };
};

/** Projects only the admitted row's form, inside the transaction that proved its membership. */
export const projectRowOptionsForm = async (
  transaction: Parameters<
    ReturnType<typeof createStoredPageCapabilityService>["projectFormInTransaction"]
  >[0],
  scope: Parameters<
    ReturnType<typeof createStoredPageCapabilityService>["projectFormInTransaction"]
  >[1],
  context: InstalledRuntimeContext,
  projectedPage: Readonly<Record<string, unknown>>,
  pageId: string,
  formId: string,
  subject: Readonly<{ moduleRootId: string; recordTypeId: string; recordId: string }>,
): Promise<
  | (ProjectedOptionsForm &
      Readonly<{
        visibleFields: ReadonlyMap<string, Readonly<{ placementId: string; kind: string }>>;
        projectedPage: Readonly<Record<string, unknown>>;
      }>)
  | undefined
> => {
  const service = createStoredPageCapabilityService({
    ...requestDependencies(),
    context,
    permissions: platformPermissionSource,
    selection: { pageId },
  });
  const form = await service.projectFormInTransaction(
    transaction,
    scope,
    projectedPage,
    formId,
    subject,
  );
  if (form === undefined) return undefined;
  const page = structuredClone(projectedPage) as Record<string, unknown>;
  let replaced = false;
  walkPageComposition(page.composition, (placement) => {
    if (sameId(placement.placementId, formId)) {
      Object.assign(placement.item, structuredClone(form));
      replaced = true;
    }
    return undefined;
  });
  if (!replaced) return undefined;
  const enriched = withContributedFormPlacements(page, context, subject, formId);
  const projected = projectedOptionsForm(enriched, formId);
  if (projected === undefined) return undefined;
  const visibleFields = new Map<string, Readonly<{ placementId: string; kind: string }>>();
  for (const placement of collectPlacements(enriched)) {
    if (placement.formId === undefined || !sameId(placement.formId, formId)) continue;
    const block = placement.vortex.block;
    const blockId =
      isRecord(block) && typeof block.blockId === "string" ? block.blockId : undefined;
    if (
      blockId === undefined ||
      (!sameId(blockId, FIELD_INPUT_BLOCK_RELEASE.blockId) &&
        !Object.values(FIELD_INPUT_CONTROL_RELEASES).some((release) =>
          sameId(blockId, release.blockId),
        ))
    )
      continue;
    const name = placement.settings.name;
    if (
      !isRecord(name) ||
      name.kind !== "text" ||
      typeof name.value !== "string" ||
      visibleFields.has(name.value)
    )
      return undefined;
    const control = fieldControl(placement);
    const kind =
      control ??
      (sameId(blockId, CHOICE_INPUT_BLOCK_RELEASE.blockId)
        ? "choice"
        : sameId(blockId, LINK_INPUT_BLOCK_RELEASE.blockId)
          ? "link"
          : "other");
    visibleFields.set(name.value, { placementId: placement.placementId, kind });
  }
  return { ...projected, visibleFields, projectedPage: enriched };
};

/** Reprojects the current addressed page under the actor and the exact installed release. */
export const projectOptionsPage = async (
  session: IdentitySession,
  address: OptionsAddress,
  request: Readonly<{ installationRevision: number; releaseKey: string; subjectRecordId?: string }>,
  bound?: BoundHumanOrganizationRequest,
): Promise<
  | Readonly<{
      kind: "available";
      page: Readonly<Record<string, unknown>>;
      rawPage: Readonly<Record<string, unknown>>;
      context: InstalledRuntimeContext;
      selection: OrganizationSelectionCandidate;
      dependencies: ReturnType<typeof requestDependencies>;
    }>
  | OptionsPageResult
> => {
  const dependencies = requestDependencies();
  const selection: OrganizationSelectionCandidate = {
    organizationId: address.read.organizationId,
    applicationRootId: address.application.applicationRootId,
    ...(address.application.previewInstallationId === undefined
      ? {}
      : { previewInstallationId: address.application.previewInstallationId }),
  };
  // The address resolution of this same request already read the installed context under the
  // person's own verified scope for exactly this organisation and application; it is reused.
  const carried = address.installedContext;
  const loaded =
    carried !== undefined &&
    sameId(carried.organizationId, selection.organizationId) &&
    sameId(carried.applicationRootId, address.application.applicationRootId)
      ? ({ kind: "available", value: carried } as const)
      : await loadInstalledContext(session, dependencies, selection);
  if (loaded.kind !== "available")
    return loaded.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" }
      : { kind: "refused" };
  const context = loaded.value;
  const application = context.releaseSet.application;
  if (!sameId(context.applicationRootId, address.application.applicationRootId))
    return { kind: "refused" };
  if (
    request.installationRevision !== context.applicationReleaseRevision ||
    request.releaseKey !==
      [
        application.releaseVersion,
        application.contentFingerprint,
        application.resolutionFingerprint,
      ].join(":")
  )
    return { kind: "reload" };
  const pageDefinition = application.content.pages.find((page) => page.key === address.pageKey);
  if (pageDefinition === undefined) return { kind: "refused" };
  const capability = createStoredPageCapabilityService({
    ...dependencies,
    context,
    permissions: platformPermissionSource,
    selection: {
      pageId: pageDefinition.pageId,
      ...(request.subjectRecordId === undefined
        ? {}
        : { subjectRecordId: request.subjectRecordId }),
    },
  });
  const projected =
    bound === undefined
      ? await capability.project(session, selection)
      : {
          kind: "available" as const,
          value: await capability.projectInTransaction(bound.transaction, bound.scope),
        };
  if (projected.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
  if (projected.kind !== "available" || projected.value === undefined) return { kind: "refused" };
  // The page a form submit is checked against carries the same contributed field inputs the
  // viewer was shown.
  return {
    kind: "available",
    page: withContributedPlacements(projected.value, context, pageDefinition),
    rawPage: projected.value,
    context,
    selection,
    dependencies,
  };
};
