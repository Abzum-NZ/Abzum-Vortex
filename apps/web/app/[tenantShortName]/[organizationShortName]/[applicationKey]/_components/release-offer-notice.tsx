import { NavigationLink } from "@vortex/ui/routing";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import type { ApplicationReleaseOffer } from "../../../../_lib/application-release-adoption";

/**
 * The platform's notice above an installed Application whose newer published release this
 * organisation has not upgraded to. It is shown only to a person who may manage the organisation's
 * installations, and leads to the App Store page whose Install or upgrade dialog makes the change.
 */
export function ReleaseOfferNotice({
  applicationName,
  offer,
}: Readonly<{ applicationName: string; offer: ApplicationReleaseOffer }>) {
  return (
    <div
      role="status"
      data-vortex-release-offer={offer.version}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-info/50 bg-info/10 px-4 py-2 text-sm text-foreground"
    >
      <Icon name="info" />
      <p className="min-w-0 flex-1">
        <strong>
          Version {offer.version} of {applicationName} is waiting.
        </strong>{" "}
        This organisation runs version {offer.installedVersion}. Upgrade it in the App Store to use
        the new version.
      </p>
      <Button
        variant="outline"
        size="sm"
        nativeButton={false}
        render={<NavigationLink href={offer.appStoreHref} />}
      >
        Upgrade in the App Store
      </Button>
    </div>
  );
}
