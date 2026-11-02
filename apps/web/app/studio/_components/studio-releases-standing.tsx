"use client";
import { Icon } from "@vortex/ui";
import type { VortexIconName } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@vortex/ui/components/item";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";
import { NavigationLink } from "@vortex/ui/routing";
import type { ApplicationReleaseStanding } from "../../_lib/application-release-adoption";

/**
 * Where the application stands in the builder's organisation, in plain words. Installing and
 * upgrading are the top bar's controls (shown only to people who may use them), so this says what
 * is waiting and never offers them; `reviewRoles` is the one action that is not the top bar's.
 */
const standingWords = (
  standing: ApplicationReleaseStanding,
): Readonly<{
  icon: VortexIconName;
  headline: string;
  text: string;
  reviewRoles?: string;
}> | null => {
  switch (standing.kind) {
    case "system":
      return standing.installedVersion === standing.version
        ? {
            icon: "shield-check",
            headline: "System application",
            text: `Version ${standing.version} is live in your organisation.`,
          }
        : {
            icon: "clock",
            headline: "A newer version is waiting",
            text: `Your organisation runs version ${standing.installedVersion}; version ${standing.version} is waiting. Upgrade it in the App Store.`,
          };
    case "live":
      return {
        icon: "check",
        headline: "Live in your organisation",
        text: `Version ${standing.version} is live in your organisation.${standing.rolesWaiting ? " Role changes are waiting for you to accept them." : ""}`,
        ...(standing.rolesWaiting ? { reviewRoles: "Review role changes" } : {}),
      };
    case "waiting":
      return {
        icon: "clock",
        headline: "A newer version is waiting",
        text: `Your organisation runs version ${standing.installedVersion}; version ${standing.version} is waiting.${standing.mayInstall ? " Upgrade it from the top bar." : ""}`,
      };
    case "not_installed":
      return {
        icon: "package-plus",
        headline: "Not installed yet",
        text: `Version ${standing.version} is not installed in your organisation, so people cannot open it yet.${standing.mayInstall ? " Install it from the top bar." : ""}`,
      };
    case "unknown":
      return standing.appStoreHref === undefined
        ? null
        : {
            icon: "info",
            headline: "Installation",
            text: "Someone who manages applications installs or upgrades it in the App Store.",
          };
    case "not_published":
      return null;
  }
};

/** The App Store page that shows the application, when where it stands names one. */
export const appStoreHrefOf = (standing: ApplicationReleaseStanding): string | undefined =>
  "appStoreHref" in standing ? standing.appStoreHref : undefined;

/**
 * Where the application stands, as one row above the Releases tabs. Nothing shows before the
 * first publish (the empty history says so) or until the standing is read.
 */
export function StudioReleasesStanding({
  standing,
  actionPending,
  onReviewRoles,
}: Readonly<{
  /** Null until the standing is read. */
  standing: ApplicationReleaseStanding | null;
  actionPending: boolean;
  onReviewRoles: () => void;
}>) {
  const words = standing === null ? null : standingWords(standing);
  if (standing === null || words === null) return null;
  const href = appStoreHrefOf(standing);
  return (
    <Item variant="outline" size="sm" role="group" aria-label="Installation">
      <ItemMedia variant="icon">
        <Icon name={words.icon} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{words.headline}</ItemTitle>
        <ItemDescription>{words.text}</ItemDescription>
      </ItemContent>
      <ItemActions>
        {words.reviewRoles === undefined ? null : (
          <Button type="button" size="sm" disabled={actionPending} onClick={onReviewRoles}>
            {words.reviewRoles}
          </Button>
        )}
        {href === undefined ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  nativeButton={false}
                  render={<NavigationLink href={href} aria-label="View in the App Store" />}
                />
              }
            >
              <Icon name="app-window" />
            </TooltipTrigger>
            <TooltipContent>View in the App Store</TooltipContent>
          </Tooltip>
        )}
      </ItemActions>
    </Item>
  );
}
