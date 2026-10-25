import "server-only";

import type { JsonValue } from "../../catalogue/common";
import { projectCalendarPlacement, type CalendarPlacementContract } from "../calendar-query";
import { addressParameter } from "../records-table-state";
import {
  firstParameter,
  logPlacementFailure,
  type PlacementModule,
  type PlacementQuery,
  type PlacementReadEntry,
} from "./shared";
import type { PlacementReadInput } from "./types";

/**
 * A calendar placement: the events of its bound query in the window its address names, in the
 * organisation's time zone, read under the same access the page was projected with.
 */
export const readCalendar = async (
  read: PlacementReadInput,
  placement: PlacementReadEntry,
  bound: Readonly<{ module: PlacementModule; query: PlacementQuery }>,
  contract: CalendarPlacementContract,
  inputValues: Readonly<Record<string, JsonValue>>,
): Promise<void> => {
  const { placementId } = placement;
  const { address, data } = read;
  let organizationSettings: Awaited<ReturnType<typeof read.services.readCalendarSettings>>;
  try {
    organizationSettings = await read.services.readCalendarSettings();
  } catch {
    logPlacementFailure(address, placementId, "calendar_time_zone_unavailable");
    data[placementId] = { status: "error" };
    return;
  }
  if (
    organizationSettings.kind !== "available" ||
    (read.accessVersion !== undefined &&
      organizationSettings.value.accessVersion !== read.accessVersion) ||
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
    contract,
    timeZone: organizationSettings.value.settings.timeZone,
    inputValues,
    requestedView: firstParameter(read.parameters[addressParameter("calendar", placementId)]),
    requestedDate: firstParameter(read.parameters[addressParameter("date", placementId)]),
    queries: read.services.queries,
    session: read.session,
    selection: read.selection,
    resolveRecordLinks: read.services.resolveRecordLinks,
  });
  if (projection.outcome === "ready") {
    data[placementId] = { status: "ready", values: projection.values };
    return;
  }
  logPlacementFailure(address, placementId, projection.cause);
  if (projection.cause === "calendar_range_unsupported") {
    data[placementId] = {
      status: "awaiting_input",
      message: "This period is outside the supported calendar range. Choose a different period.",
    };
    return;
  }
  data[placementId] =
    projection.outcome === "unavailable"
      ? { status: "error" }
      : { status: "refused", reason: "not_permitted" };
};
