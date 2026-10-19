import { isRecord } from "@vortex/platform/schema";
import type { ControlSemanticEvent, RecordChoicePage } from "@vortex/ui";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";

/**
 * Reads one page of the records a link field (or a Records table's link filter) on this page may
 * point at, for the picker that asked.
 * The server projects the page again under the person, so only a link input they can use is read
 * for. A changed release reloads the page; any other failure rejects, and the picker says so.
 */
export const requestRecordChoices = async (
  model: ApplicationPageModel,
  placementId: string,
  event: Pick<
    Extract<ControlSemanticEvent, { event: "records_requested" }>,
    "search" | "continuationToken"
  > & {
    /** For a Records table's link filter: the filter field whose target records are offered. */
    fieldId?: string;
  },
  reload: () => void,
): Promise<RecordChoicePage> => {
  const application = model.invocation;
  const response = await fetch("/api/record-choices", {
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
      ...(event.fieldId === undefined ? {} : { fieldId: event.fieldId }),
      installationRevision: application.installationRevision,
      releaseKey: application.releaseKey,
      ...(model.subject === undefined ? {} : { subjectRecordId: model.subject.recordId }),
      ...(event.search === undefined ? {} : { search: event.search }),
      ...(event.continuationToken === undefined
        ? {}
        : { continuationToken: event.continuationToken }),
    }),
  });
  const body: unknown = await response.json();
  if (isRecord(body) && body.kind === "reload") {
    reload();
    throw new Error("RECORD_CHOICES_RELEASE_CHANGED");
  }
  if (!response.ok || !isRecord(body) || body.kind !== "completed")
    throw new Error(`RECORD_CHOICES_UNAVAILABLE: ${response.status}`);
  return {
    choices: Array.isArray(body.choices) ? body.choices : [],
    ...(typeof body.nextContinuationToken === "string"
      ? { nextContinuationToken: body.nextContinuationToken }
      : {}),
  } as RecordChoicePage;
};
