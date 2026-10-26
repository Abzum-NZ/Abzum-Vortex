import {
  type ReferenceChoiceInputValues,
  type PermittedApplicationsRead,
  type PermittedApplication,
  type InstalledRuntimeContext,
  createStoredPageCapabilityService,
} from "@vortex/platform/server";
import {
  type IdentitySession,
  type OrganizationSelectionCandidate,
  sameId,
} from "@vortex/platform/schema";
import { loadInstalledContext, requestDependencies } from "./installed-context";
import { platformPermissionSource } from "../platform-permission-source";
import { withContributedPlacements } from "./contributed-placements";

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
