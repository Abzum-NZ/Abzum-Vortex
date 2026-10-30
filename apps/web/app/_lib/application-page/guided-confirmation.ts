import "server-only";

import {
  createPageSubjectReader,
  createStoredPageCapabilityService,
  pageSubjectType,
  type BoundHumanOrganizationRequest,
} from "@vortex/platform/server";
import { sameId, type IdentitySession } from "@vortex/platform/schema";
import { prepareRuntimePreviewPage } from "../runtime-preview-demand";
import { platformPermissionSource } from "../platform-permission-source";
import { collectPlacements } from "./placement-helpers";
import { withContributedPlacements } from "./contributed-placements";
import { projectGuidedForm } from "./guided-form-projection";
import { loadInstalledContext, requestDependencies } from "./installed-context";
import type { ApplicationPageLoaderAddress } from "./types";

/** Reads only the current evidence needed to confirm a guided submission. */
export const loadGuidedConfirmation = async (
  session: IdentitySession,
  address: ApplicationPageLoaderAddress,
  guided: Readonly<{ pageKey: string; pageId: string }>,
  subject: Readonly<{ recordId: string; revision: number }> | undefined,
  boundRequest?: BoundHumanOrganizationRequest,
) => {
  const dependencies = {
    ...requestDependencies(),
    ...(boundRequest === undefined ? {} : { boundRequest }),
  };
  const selection = {
    organizationId: address.read.organizationId,
    applicationRootId: address.application.applicationRootId,
    ...(address.application.previewInstallationId === undefined
      ? {}
      : { previewInstallationId: address.application.previewInstallationId }),
  };
  const carried = address.installedContext;
  const loaded =
    carried !== undefined &&
    sameId(carried.organizationId, selection.organizationId) &&
    sameId(carried.applicationRootId, selection.applicationRootId)
      ? { kind: "available" as const, value: carried }
      : await loadInstalledContext(session, dependencies, selection);
  if (loaded.kind !== "available") return undefined;
  const context = loaded.value;
  const application = context.releaseSet.application;
  const definition = application.content.pages.find(
    (page) => page.key === guided.pageKey && sameId(page.pageId, guided.pageId),
  );
  if (definition?.type !== "guided_form") return undefined;
  const ready = await prepareRuntimePreviewPage(
    session,
    context,
    definition,
    subject !== undefined,
  );
  if (ready.kind !== "ready") return undefined;
  const projected = await createStoredPageCapabilityService({
    ...dependencies,
    context,
    permissions: platformPermissionSource,
    selection: {
      pageId: guided.pageId,
      ...(subject === undefined ? {} : { subjectRecordId: subject.recordId }),
    },
  }).project(session, selection);
  if (projected.kind !== "available" || projected.value === undefined) return undefined;
  const demand = await prepareRuntimePreviewPage(
    session,
    context,
    definition,
    false,
    projected.value,
  );
  if (demand.kind !== "ready") return undefined;
  const page = withContributedPlacements(projected.value, context, definition);
  const subjectType = pageSubjectType(definition);
  if (subject !== undefined && subjectType === undefined) return undefined;
  const subjectRow =
    subject === undefined || subjectType === undefined
      ? undefined
      : await createPageSubjectReader(dependencies).read(session, selection, {
          recordTypeId: String(subjectType.recordTypeId),
          recordId: subject.recordId,
        });
  const currentSubject =
    subjectRow?.kind === "read" && subjectRow.row.revision !== undefined
      ? { recordId: String(subjectRow.row.recordId), revision: subjectRow.row.revision }
      : undefined;
  const draft = await projectGuidedForm({
    context,
    pageDefinition: definition,
    page,
    parameters: subject === undefined ? {} : { record_id: subject.recordId },
    session,
    selection,
    subjectRow,
    subject: currentSubject,
    dateTimeZones: {},
    ...(boundRequest === undefined ? {} : { boundRequest }),
  });
  if (draft.kind !== "projected") return undefined;
  const bindings: Record<string, { event: string; bindingId: string }[]> = {};
  for (const { placementId } of collectPlacements(page)) {
    const held = application.content.flowBindings.filter((binding) =>
      sameId(binding.controlId, placementId),
    );
    if (held.length > 0)
      bindings[placementId] = held.map((binding) => ({
        event: binding.event,
        bindingId: String(binding.bindingId),
      }));
  }
  return {
    page,
    pageId: String(definition.pageId),
    guidedForm: draft.guidedForm,
    ...(currentSubject === undefined ? {} : { subject: currentSubject }),
    bindings,
  };
};
