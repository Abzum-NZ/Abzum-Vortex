import { isRecord, type JsonValue } from "@vortex/platform/schema";
import type { ChoiceOption, ControlSemanticEvent, RecordChoicePage } from "@vortex/ui";
import { postJson } from "../../../../../../_lib/post-json";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";

/**
 * The pages read in this page session, by the inputs that asked: reopening a picker with the same
 * inputs is answered at once. A new page model (a navigation, a refresh or a release change) starts
 * with none, and a changed driving field changes the inputs, so a stale page is never served.
 */
export type FieldOptionsPage =
  RecordChoicePage | Readonly<{ options: readonly ChoiceOption[]; nextContinuationToken?: string }>;
const pagesBySession = new WeakMap<ApplicationPageModel, Map<string, FieldOptionsPage>>();

/**
 * Reads one page of the records a link field (or a Records table's link picker) on this page may
 * point at, for the picker that asked.
 * The server projects the page again under the person, so only a link input they can use is read
 * for. A changed release reloads the page; any other failure rejects, and the picker says so.
 */
export const requestFieldOptions = async (
  model: ApplicationPageModel,
  placementId: string,
  event: Pick<
    Extract<ControlSemanticEvent, { event: "options_requested" }>,
    "search" | "continuationToken"
  > & {
    /** For a Records table's link picker: the field whose target records are offered, and why. */
    fieldId?: string;
    purpose?: "filter" | "edit";
    /** For a dependent link field: the record chosen in the field it depends on. */
    parentRecordId?: string;
    /** For a field whose options a flow works out: the form's draft, by field key. */
    draft?: Readonly<Record<string, JsonValue>>;
  },
  reload: () => void,
): Promise<FieldOptionsPage> => {
  const cached = pagesBySession.get(model) ?? new Map<string, FieldOptionsPage>();
  pagesBySession.set(model, cached);
  const cacheKey = JSON.stringify([
    placementId.toLowerCase(),
    event.fieldId?.toLowerCase() ?? null,
    event.purpose ?? null,
    event.parentRecordId?.toLowerCase() ?? null,
    event.draft ?? null,
    event.search ?? null,
    event.continuationToken ?? null,
  ]);
  const held = cached.get(cacheKey);
  if (held !== undefined) return held;
  const application = model.invocation;
  const response = await postJson("/api/field-options", {
    tenantShortName: application.tenantShortName,
    organizationShortName: application.organizationShortName,
    applicationKey: application.applicationKey,
    pageKey: application.pageKey,
    placementId,
    ...(event.fieldId === undefined ? {} : { fieldId: event.fieldId }),
    ...(event.purpose === undefined ? {} : { purpose: event.purpose }),
    ...(event.parentRecordId === undefined ? {} : { parentRecordId: event.parentRecordId }),
    ...(event.draft === undefined ? {} : { draft: event.draft }),
    installationRevision: application.installationRevision,
    releaseKey: application.releaseKey,
    ...(model.subject === undefined ? {} : { subjectRecordId: model.subject.recordId }),
    ...(event.search === undefined ? {} : { search: event.search }),
    ...(event.continuationToken === undefined
      ? {}
      : { continuationToken: event.continuationToken }),
  });
  const body: unknown = response.body;
  if (isRecord(body) && body.kind === "reload") {
    reload();
    throw new Error("FIELD_OPTIONS_RELEASE_CHANGED");
  }
  if (!response.ok || !isRecord(body) || body.kind !== "completed")
    throw new Error(`FIELD_OPTIONS_UNAVAILABLE: ${response.status}`);
  const next =
    typeof body.nextContinuationToken === "string"
      ? { nextContinuationToken: body.nextContinuationToken }
      : {};
  const page = (
    Array.isArray(body.options)
      ? { options: body.options, ...next }
      : { choices: Array.isArray(body.choices) ? body.choices : [], ...next }
  ) as FieldOptionsPage;
  cached.set(cacheKey, page);
  return page;
};
