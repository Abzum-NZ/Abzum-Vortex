import type { ApplicationPageModel } from "../../../../../../_lib/application-page";

/**
 * The application page a Records table request addresses, with the record the page was opened for.
 * The server resolves both again: the record is an address candidate, never authority.
 */
export const recordsTableAddress = (model: ApplicationPageModel) => ({
  tenantShortName: model.invocation.tenantShortName,
  organizationShortName: model.invocation.organizationShortName,
  applicationKey: model.invocation.applicationKey,
  pageKey: model.invocation.pageKey,
  ...(model.subject === undefined ? {} : { pageRecordId: model.subject.recordId }),
});
