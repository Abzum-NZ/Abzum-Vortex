import "server-only";

import { redirect } from "next/navigation";
import type { DisplaySemanticEvent } from "@vortex/ui";
import {
  isRecord,
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  walkPageComposition,
} from "@vortex/platform/schema";
import { continueSessionOrEnd } from "../../../auth/_lib/session-redirect";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import {
  applicationPageAddressPath as addressPath,
  organizationAddressPath as launcherPath,
} from "../../../_lib/address-paths";

/** Read the event identities authored on the launcher placements of this compiled page. */
export const applicationLauncherEventIds = (composition: unknown): readonly string[] => {
  const eventIds: string[] = [];
  walkPageComposition(composition, ({ props, vortex }) => {
    if (
      isRecord(vortex.block) &&
      vortex.block.blockId ===
        PLATFORM_BLOCK_RELEASE_IDENTITIES.APPLICATION_LAUNCHER_BLOCK_RELEASE.blockId
    ) {
      if (typeof props.row_action_event_id !== "string" || props.row_action_event_id.length === 0)
        throw new Error("APPLICATION_LAUNCHER_EVENT_ID_MISSING");
      eventIds.push(props.row_action_event_id);
    }
    return undefined;
  });
  return eventIds;
};

/**
 * Tile activation is the launcher block's declared `row_action` event. It opens only when the event
 * carries the launcher's open identity; a forged or missing one is refused and logged. A
 * query-bound tile sends only its application key; the organisation launcher may send the application's stable identity.
 * This resolves either identity against the signed-in person's current permitted applications
 * before opening it, so a withdrawn or refused application is never opened from stale page data or
 * a crafted value.
 */
export const openPermittedApplication = async (
  tenantShortName: string,
  organizationShortName: string,
  event: DisplaySemanticEvent,
  declaredEventIds: readonly string[],
): Promise<void> => {
  if (event?.event !== "row_action" || typeof event.recordId !== "string") return;
  if (!declaredEventIds.includes(event.eventId)) {
    console.error("[launcher] open refused: ROW_ACTION_EVENT_UNKNOWN");
    return;
  }
  const chooser = launcherPath(tenantShortName, organizationShortName);
  const currentIdentity = await continueSessionOrEnd(await resolveIdentitySession());
  if (currentIdentity.kind === "temporarily_unavailable") redirect(chooser);

  const rechecked = await resolveApplicationAddress(
    currentIdentity.session,
    tenantShortName,
    organizationShortName,
  );
  if (rechecked.kind !== "organization_launcher") redirect(chooser);
  const application = rechecked.read.applications.find(
    (candidate) =>
      candidate.key === event.recordId || candidate.applicationRootId === event.recordId,
  );
  if (application === undefined) redirect(chooser);
  redirect(
    addressPath(tenantShortName, organizationShortName, application.key, application.homePageKey),
  );
};
