"use client";
import { NavigationLink } from "@vortex/ui/routing";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { Skeleton } from "@vortex/ui/components/skeleton";
import type { ApplicationReleaseStanding } from "../../_lib/application-release-adoption";
import { StudioPanelShell } from "./studio-frame";

/** The one wording of how a system application advances. */
const systemRefreshMessage = "System applications move forward through the platform refresh.";

/**
 * Where the application stands in the builder's organisation, in plain words. `install` names the
 * action that moves the organisation to the published version (run here, over the editor) and
 * `link` the App Store page that shows the application.
 */
const standingWords = (
  standing: ApplicationReleaseStanding,
): Readonly<{
  headline: string;
  text: string;
  install?: string;
  link?: Readonly<{ label: string; href: string }>;
}> => {
  const viewInStore = (href: string) => ({ label: "View in the App Store", href });
  switch (standing.kind) {
    case "system":
      return {
        headline: "System application",
        text: `Latest published version: ${standing.version}. Installed version: ${standing.installedVersion}. ${systemRefreshMessage}`,
      };
    case "live":
      return {
        headline: "Live in your organisation",
        text: `Version ${standing.version} is live in your organisation.${standing.rolesWaiting ? " Role changes are waiting for you to accept them." : ""}`,
        ...(standing.rolesWaiting ? { install: "Review role changes" } : {}),
        link: viewInStore(standing.appStoreHref),
      };
    case "waiting":
      return {
        headline: "A newer version is waiting",
        text: `Your organisation runs version ${standing.installedVersion}; version ${standing.version} is waiting. Upgrade to use it.`,
        install: "Upgrade",
        link: viewInStore(standing.appStoreHref),
      };
    case "not_installed":
      return {
        headline: "Not installed yet",
        text: `Version ${standing.version} is not installed in your organisation, so people cannot open it yet.`,
        install: "Install",
        link: viewInStore(standing.appStoreHref),
      };
    case "not_published":
      return {
        headline: "Draft only",
        text: "Publish from the top bar to create the first version.",
      };
    case "unknown":
      return {
        headline: "Installation",
        text: "Someone who manages applications installs or upgrades it in the App Store.",
        ...(standing.appStoreHref === undefined
          ? {}
          : { link: viewInStore(standing.appStoreHref) }),
      };
  }
};

/**
 * The Releases tab's panel: where the application stands in the organisation and the one action
 * that moves it forward. The history itself is the centre; Publish is the top bar's button.
 */
export function StudioReleasesPanel({
  hidden,
  standing,
  installPending,
  onInstall,
}: Readonly<{
  hidden: boolean;
  /** Null until the standing is read. */
  standing: ApplicationReleaseStanding | null;
  installPending: boolean;
  onInstall: () => void;
}>) {
  const words = standing === null ? null : standingWords(standing);
  return (
    <StudioPanelShell title="Releases" hidden={hidden}>
      {words === null ? (
        <div className="space-y-2" role="status" aria-label="Reading where the application stands">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : (
        <section aria-label="Installation" className="space-y-3">
          <Badge variant="outline">{words.headline}</Badge>
          <p className="text-sm text-muted-foreground">{words.text}</p>
          <div className="flex flex-wrap gap-2">
            {words.install === undefined ? null : (
              <Button type="button" size="sm" disabled={installPending} onClick={onInstall}>
                {words.install}
              </Button>
            )}
            {words.link === undefined ? null : (
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<NavigationLink href={words.link.href} />}
              >
                {words.link.label}
              </Button>
            )}
          </div>
        </section>
      )}
    </StudioPanelShell>
  );
}
