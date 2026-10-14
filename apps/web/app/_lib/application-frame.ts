import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import {
  DEFAULT_PLATFORM_THEME_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
  type ProjectedNavigation,
} from "@vortex/platform/server";
import {
  sameId,
  splitProjectedPage,
  type ApplicationShell,
  type PlatformBlockRelease,
  type ProjectedApplicationFrame,
} from "@vortex/platform/schema";
import type { ApplicationAccount, PlatformThemeTokens, FieldInputControlReleaseMap } from "@vortex/ui";
import { resolveIdentitySessionWithEmail } from "../auth/_lib/session-server";
import { resolveApplicationAddress } from "./application-address";
import { loadApplicationSearch } from "./application-search";
import { loadPermittedApplicationsAtAddress } from "./organization-context";
import { platformBlockReleasesFor } from "./platform-block-releases";
import { requestAddressHeader } from "./request-address";
import { readPageProjections } from "./application-page/load";
import { pageSubjectParameter } from "./application-page/placement-helpers";
import type { ApplicationPageModel } from "./application-page";

type ApplicationSearchView = Awaited<ReturnType<typeof loadApplicationSearch>>;

/** Everything the application frame shows, decided on the server for the signed-in viewer. */
export type ApplicationFrameModel = Readonly<{
  frame: ProjectedApplicationFrame;
  /** Every shell of the installed release, so a page with another shell can replace the frame. */
  shells: readonly ApplicationShell[];
  theme: ApplicationPageModel["theme"];
  navigation: ProjectedNavigation;
  application: Readonly<{
    tenantShortName: string;
    organizationShortName: string;
    key: string;
    name: string;
    homePageKey: string;
  }>;
  /** The pages the viewer may open, for the current page's menu state and breadcrumb. */
  pages: readonly Readonly<{ pageId: string; key: string; name: string }>[];
  applicationSwitcherState: "available" | "unavailable" | "temporarily_unavailable";
  applications: readonly Readonly<{ key: string; name: string; href: string }>[];
  account: ApplicationAccount;
  search: ApplicationSearchView;
  platformBlockReleases: readonly PlatformBlockRelease[];
  fieldInputControlReleases: FieldInputControlReleaseMap;
  platformThemeTokens: PlatformThemeTokens;
}>;

/** The page key and query the request addresses inside this application, when it names one page. */
const addressedPage = async (
  tenantShortName: string,
  organizationShortName: string,
  applicationKey: string,
): Promise<Readonly<{ pageKey: string; query: URLSearchParams }> | undefined> => {
  const address = (await headers()).get(requestAddressHeader);
  if (address === null) return undefined;
  const url = new URL(address, "http://address.invalid");
  // Addresses are built with encoded segments, so the route's parameters are compared encoded.
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const [tenant, organization, application, pageSegment] = segments;
  // A page key is a builder key, which encodes to itself; any other segment names no page.
  const pageKey =
    pageSegment !== undefined && encodeURIComponent(pageSegment) === pageSegment
      ? pageSegment
      : undefined;
  return segments.length === 4 &&
    tenant === encodeURIComponent(tenantShortName) &&
    organization === encodeURIComponent(organizationShortName) &&
    application === encodeURIComponent(applicationKey) &&
    pageKey !== undefined
    ? { pageKey, query: url.searchParams }
    : undefined;
};

/**
 * The viewer's application frame for one application address. It is the shell part of the same
 * projection the addressed page renders from (one read per request, shared with the page), so the
 * frame shows exactly the shell placements the page would. Without a page address, or when the page
 * is not shown to this viewer, there is no frame and the page renders its own state.
 */
export const loadApplicationFrame = cache(
  async (
    tenantShortName: string,
    organizationShortName: string,
    applicationKey: string,
  ): Promise<ApplicationFrameModel | undefined> => {
    const addressed = await addressedPage(tenantShortName, organizationShortName, applicationKey);
    if (addressed === undefined) return undefined;
    const { resolution, email } = await resolveIdentitySessionWithEmail();
    if (resolution.kind !== "active" || email === undefined) return undefined;
    const session = resolution.session;
    const resolved = await resolveApplicationAddress(
      session,
      tenantShortName,
      organizationShortName,
      applicationKey,
      addressed.pageKey,
    );
    if (resolved.kind !== "application_page" || resolved.installedContext === undefined)
      return undefined;
    const context = resolved.installedContext;
    const content = context.releaseSet.application.content;
    const pageDefinition = content.pages.find((page) => page.key === resolved.pageKey);
    if (pageDefinition === undefined) return undefined;
    const subject = addressed.query.get(pageSubjectParameter) ?? undefined;
    const { projectedPageRead, navigationRead } = readPageProjections(
      session,
      context,
      pageDefinition.pageId,
      subject,
    );
    const [projected, navigation] = await Promise.all([projectedPageRead, navigationRead]);
    if (projected.kind !== "available" || projected.value === undefined) return undefined;
    if (navigation.kind !== "available") return undefined;

    const shellId =
      "shellId" in pageDefinition.composition ? pageDefinition.composition.shellId : undefined;
    const shell =
      shellId === undefined
        ? undefined
        : content.shells.find((candidate) => sameId(candidate.shellId, shellId));
    if (shellId !== undefined && shell === undefined)
      throw new Error(`Compiled page '${pageDefinition.key}' references missing shell '${shellId}'`);
    const { frame } = splitProjectedPage(projected.value, shell);

    const switcherRead =
      shell?.presentation.topBar.applicationSwitcher === true
        ? await loadPermittedApplicationsAtAddress(session, tenantShortName, organizationShortName)
        : undefined;
    if (switcherRead?.kind === "temporarily_unavailable")
      console.error(
        `[application-shell] permitted applications unavailable: cause=${switcherRead.cause ?? "cause_not_provided"}`,
      );
    const switcherApplications =
      switcherRead?.kind === "available"
        ? switcherRead.applications
        : switcherRead === undefined
          ? resolved.read.applications
          : [];

    const query = addressed.query.getAll("q");
    const expression = query.length === 1 ? (query[0] === "" ? undefined : query[0]) : query.length === 0 ? undefined : "";
    const search: ApplicationSearchView =
      expression === undefined
        ? content.search?.enabled === true
          ? { kind: "available", expression: "", results: [], more: false }
          : { kind: "disabled" }
        : await loadApplicationSearch(
            session,
            { tenantShortName, organizationShortName, applicationKey: resolved.application.key },
            expression,
          );

    const permittedKeys = new Set(resolved.application.pageKeys);
    const applicationPath = (key: string, pageKey: string) =>
      `/${encodeURIComponent(tenantShortName)}/${encodeURIComponent(organizationShortName)}/${encodeURIComponent(key)}/${encodeURIComponent(pageKey)}`;
    return {
      frame,
      shells: content.shells,
      theme: content.theme,
      navigation: navigation.value,
      application: {
        tenantShortName,
        organizationShortName,
        key: resolved.application.key,
        name: resolved.application.name,
        homePageKey: resolved.application.homePageKey,
      },
      pages: content.pages
        .filter((page) => permittedKeys.has(page.key))
        .map((page) => ({ pageId: page.pageId, key: page.key, name: page.name })),
      applicationSwitcherState:
        switcherRead === undefined || switcherRead.kind === "available"
          ? "available"
          : switcherRead.kind === "temporarily_unavailable"
            ? "temporarily_unavailable"
            : "unavailable",
      applications: switcherApplications.map((candidate) => ({
        key: candidate.key,
        name: candidate.name,
        href: applicationPath(candidate.key, candidate.homePageKey),
      })),
      account:
        resolved.read.accountDisplayName === undefined
          ? { email }
          : { email, displayName: resolved.read.accountDisplayName },
      search,
      platformBlockReleases: platformBlockReleasesFor(content.shells),
      fieldInputControlReleases: FIELD_INPUT_CONTROL_RELEASES,
      platformThemeTokens: DEFAULT_PLATFORM_THEME_RELEASE.tokens,
    };
  },
);
