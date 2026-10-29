import {
  type ReferenceChoiceInputValues,
  type PermittedApplicationsRead,
  type PermittedApplication,
  type InstalledRuntimeContext,
  createReferenceChoiceService,
  createStoredPageCapabilityService,
  requireProjectedPlacement,
  CHOICE_INPUT_BLOCK_RELEASE,
  LINK_INPUT_BLOCK_RELEASE,
  TEXT_INPUT_BLOCK_RELEASE,
  DATE_INPUT_BLOCK_RELEASE,
  placementSettings,
  fieldControl,
  planChoiceOptionGates,
  decideChoiceOptionGates,
  applyChoiceOptionGates,
} from "@vortex/platform/server";
import {
  type IdentitySession,
  type OrganizationSelectionCandidate,
  isRecord,
  sameId,
  walkPageComposition,
} from "@vortex/platform/schema";
import { loadInstalledContext, requestDependencies } from "./installed-context";
import { getQueryContinuationKey } from "../query-continuation-key";
import { platformPermissionSource } from "../platform-permission-source";
import { withContributedFormPlacements, withContributedPlacements } from "./contributed-placements";
import {
  projectedReferenceChoiceForm,
  hasReferenceChoiceSource,
  referenceChoiceFieldForPlacement,
  type ProjectedReferenceChoiceForm,
} from "../reference-choices";

export type ReferenceChoicePageResult =
  | Readonly<{ kind: "completed"; values: ReferenceChoiceInputValues }>
  | Readonly<{ kind: "reload" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export type ReferenceChoiceAddress = Readonly<{
  read: Extract<PermittedApplicationsRead, { kind: "available" }>;
  application: PermittedApplication;
  pageKey: string;
  /** The installed context this same request's own HUMAN address read authorized. */
  installedContext?: InstalledRuntimeContext;
}>;

/** Proves one dynamic choice key against its installed source under the gate's transaction. */
export const validateProjectedReferenceChoice = async (
  bound: Parameters<
    ReturnType<typeof createReferenceChoiceService>["resolveExactInTransaction"]
  >[0],
  context: InstalledRuntimeContext,
  projectedPage: Readonly<Record<string, unknown>>,
  placementId: string,
  key: string,
): Promise<boolean> => {
  const match = /^r_([0-9a-f]{32})$/.exec(key);
  const gate = requireProjectedPlacement(projectedPage, placementId);
  if (match === null || gate.kind !== "on_page") return false;
  const descriptor = referenceChoiceFieldForPlacement(gate.placement, context.releaseSet.modules);
  if (descriptor === undefined) return false;
  const hex = match[1]!;
  const recordId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const service = createReferenceChoiceService({
    ...requestDependencies(),
    continuationKey: getQueryContinuationKey(),
  });
  const resolved = await service.resolveExactInTransaction(bound, {
    ...descriptor.command,
    exactRecordId: recordId,
  });
  return (
    resolved.kind === "available" &&
    resolved.value.outcome === "completed" &&
    resolved.value.choices.some((choice) => choice.key === key)
  );
};

/** Uses the page's own option gates for a published control value. */
export const validateProjectedControlOption = async (
  bound: Parameters<
    ReturnType<typeof createReferenceChoiceService>["resolveExactInTransaction"]
  >[0],
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
  if (hasReferenceChoiceSource(gate.placement))
    return validateProjectedReferenceChoice(bound, context, projectedPage, placementId, value);
  const props = structuredClone(gate.placement.props);
  const placement = {
    props,
    vortex: gate.placement.vortex,
    settings: placementSettings(props),
  };
  if (fieldControl(placement) === "choice") {
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

/** Projects only the admitted row's form, inside the transaction that proved its membership. */
export const projectRowReferenceChoiceForm = async (
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
): Promise<ProjectedReferenceChoiceForm | undefined> => {
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
  return projectedReferenceChoiceForm(
    withContributedFormPlacements(page, context, subject, formId),
    context.releaseSet.modules,
    formId,
  );
};

/** Reprojects the current addressed page under the actor and the exact installed release. */
export const projectReferenceChoicePage = async (
  session: IdentitySession,
  address: ReferenceChoiceAddress,
  request: Readonly<{ installationRevision: number; releaseKey: string; subjectRecordId?: string }>,
): Promise<
  | Readonly<{
      kind: "available";
      page: Readonly<Record<string, unknown>>;
      context: InstalledRuntimeContext;
      selection: OrganizationSelectionCandidate;
      dependencies: ReturnType<typeof requestDependencies>;
    }>
  | Exclude<ReferenceChoicePageResult, { kind: "completed" }>
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
  const projected = await createStoredPageCapabilityService({
    ...dependencies,
    context,
    permissions: platformPermissionSource,
    selection: {
      pageId: pageDefinition.pageId,
      ...(request.subjectRecordId === undefined
        ? {}
        : { subjectRecordId: request.subjectRecordId }),
    },
  }).project(session, selection);
  if (projected.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
  if (projected.kind !== "available" || projected.value === undefined) return { kind: "refused" };
  // The page a form submit is checked against carries the same contributed field inputs the
  // viewer was shown.
  return {
    kind: "available",
    page: withContributedPlacements(projected.value, context, pageDefinition),
    context,
    selection,
    dependencies,
  };
};
