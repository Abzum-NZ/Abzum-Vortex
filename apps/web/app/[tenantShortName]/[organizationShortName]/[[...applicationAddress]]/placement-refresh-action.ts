"use server";

import { containedComponentIdSchema } from "@vortex/contracts";
import { z } from "zod";
import { continueSessionOrEnd } from "../../../auth/_lib/session-redirect";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import {
  loadApplicationPagePlacements,
  type ApplicationPagePlacementReadResult,
  type PageDataState,
} from "../../../_lib/application-page";

const placementRefreshAddressSchema = z
  .object({
    tenantShortName: z.string().min(1).max(80),
    organizationShortName: z.string().min(1).max(80),
    applicationKey: z.string().min(1).max(80),
    pageKey: z.string().min(1).max(80),
    search: z.string().max(8_192),
  })
  .strict();

const placementIdsSchema = z
  .array(containedComponentIdSchema)
  .min(1)
  .max(500)
  .transform((placementIds) =>
    [...new Set(placementIds.map((placementId) => placementId.toLowerCase()))],
  );

const unavailablePlacement = Object.freeze({ status: "error" }) satisfies PageDataState;

const searchParametersOf = (
  search: string,
): Readonly<Record<string, string | readonly string[]>> => {
  const parameters: Record<string, string | readonly string[]> = {};
  for (const [name, value] of new URLSearchParams(search)) {
    const current = parameters[name];
    parameters[name] =
      current === undefined
        ? value
        : typeof current === "string"
          ? [current, value]
          : [...current, value];
  }
  return parameters;
};

/** Re-reads only named placements after resolving the viewer's current page authority. */
export async function rereadApplicationPlacements(
  addressInput: unknown,
  placementIdsInput: unknown,
): Promise<ApplicationPagePlacementReadResult> {
  const address = placementRefreshAddressSchema.safeParse(addressInput);
  const placementIds = placementIdsSchema.safeParse(placementIdsInput);
  if (!address.success || !placementIds.success) return { kind: "unavailable" };

  const identity = continueSessionOrEnd(await resolveIdentitySession());
  if (identity.kind === "temporarily_unavailable")
    return { kind: "temporarily_unavailable" };

  const resolved = await resolveApplicationAddress(
    identity.session,
    address.data.tenantShortName,
    address.data.organizationShortName,
    address.data.applicationKey,
    address.data.pageKey,
  );
  if (resolved.kind === "temporarily_unavailable")
    return { kind: "temporarily_unavailable" };
  if (resolved.kind !== "application_page") return { kind: "unavailable" };

  try {
    return await loadApplicationPagePlacements(
      identity.session,
      {
        tenantShortName: address.data.tenantShortName,
        organizationShortName: address.data.organizationShortName,
        read: resolved.read,
        application: resolved.application,
        pageKey: resolved.pageKey,
      },
      searchParametersOf(address.data.search),
      placementIds.data,
    );
  } catch {
    return {
      kind: "available",
      data: Object.fromEntries(
        placementIds.data.map((placementId) => [placementId, unavailablePlacement]),
      ),
      editFormBaselines: Object.fromEntries(
        placementIds.data.map((placementId) => [placementId, null]),
      ),
    };
  }
}
