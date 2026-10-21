import "server-only";

import { redirect } from "next/navigation";
import type { DisplaySemanticEvent } from "@vortex/ui";
import { applicationLauncherOpenEventId } from "@vortex/platform/server";
import { continueSessionOrEnd } from "../../../auth/_lib/session-redirect";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import {
  applicationPageAddressPath as addressPath,
  organizationAddressPath as launcherPath,
} from "../../../_lib/address-paths";

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
): Promise<void> => {
  if (event?.event !== "row_action" || typeof event.recordId !== "string") return;
  if (event.eventId !== applicationLauncherOpenEventId) {
    console.error(
      `[launcher] open refused: ROW_ACTION_EVENT_UNKNOWN eventId=${String(event.eventId)}`,
    );
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
