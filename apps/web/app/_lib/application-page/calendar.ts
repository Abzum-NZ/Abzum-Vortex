import type {
  readCurrentOrganizationRuntimeSettingsAfterAuthorization,
  createProtectedQueryService,
  HumanOrganizationRequestResult,
} from "@vortex/platform/server";
import {
  projectCalendarPlacement,
  type CalendarPlacementContract,
  type RecordLinkResolver,
} from "@vortex/platform/server";
import type { IdentitySession, OrganizationSelectionCandidate } from "@vortex/platform/schema";
import type { collectPlacements } from "./placement-helpers";
import { first } from "./placement-helpers";
import type { findModuleQuery } from "./query-helpers";
import { logPlacementFailure } from "./query-helpers";
import type { ApplicationPageLoaderAddress, PageDataState, SearchParameters } from "./types";

export const readCalendarPlacement = async (input: {
  readCalendarSettings: () => Promise<
    HumanOrganizationRequestResult<{
      settings: Awaited<
        ReturnType<typeof readCurrentOrganizationRuntimeSettingsAfterAuthorization>
      >;
      accessVersion: number;
    }>
  >;
  address: ApplicationPageLoaderAddress;
  placementId: string;
  data: Record<string, PageDataState>;
  page: Parameters<typeof collectPlacements>[0];
  bound: NonNullable<ReturnType<typeof findModuleQuery>>;
  calendarContract: CalendarPlacementContract;
  parameters: SearchParameters;
  queries: ReturnType<typeof createProtectedQueryService>;
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
  resolveRecordLinks: RecordLinkResolver;
}): Promise<void> => {
  const {
    readCalendarSettings,
    address,
    placementId,
    data,
    page,
    bound,
    calendarContract,
    parameters,
    queries,
    session,
    selection,
    resolveRecordLinks,
  } = input;
  let organizationSettings: Awaited<ReturnType<typeof readCalendarSettings>>;
  try {
    organizationSettings = await readCalendarSettings();
  } catch {
    logPlacementFailure(address, placementId, "calendar_time_zone_unavailable");
    data[placementId] = { status: "error" };
    return;
  }
  if (
    organizationSettings.kind !== "available" ||
    organizationSettings.value.accessVersion !== page.accessVersion ||
    organizationSettings.value.settings === undefined
  ) {
    logPlacementFailure(
      address,
      placementId,
      organizationSettings.kind === "unavailable"
        ? "calendar_settings_invalid"
        : "calendar_time_zone_unavailable",
    );
    data[placementId] =
      organizationSettings.kind === "unavailable"
        ? { status: "refused", reason: "not_permitted" }
        : { status: "error" };
    return;
  }
  const projection = await projectCalendarPlacement({
    bound,
    contract: calendarContract,
    timeZone: organizationSettings.value.settings.timeZone,
    requestedView: first(parameters[`view.${placementId}`]),
    requestedDate: first(parameters[`date.${placementId}`]),
    queries,
    session,
    selection,
    resolveRecordLinks,
  });
  if (projection.outcome === "ready") {
    data[placementId] = { status: "ready", values: projection.values };
    return;
  }
  logPlacementFailure(address, placementId, projection.cause);
  data[placementId] =
    projection.outcome === "unavailable"
      ? { status: "error" }
      : { status: "refused", reason: "not_permitted" };
};
