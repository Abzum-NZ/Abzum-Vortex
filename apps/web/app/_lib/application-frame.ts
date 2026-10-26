import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import {
  DEFAULT_PLATFORM_THEME_RELEASE,
  PREVIEW_SEED_RECORD_BOUND,
  readCurrentOrganizationRuntimeSettingsAfterAuthorization,
  runtimeContextSelection,
  runtimePreviewOf,
  type InstalledRuntimeContext,
} from "@vortex/platform/server";
import {
  type ProjectedNavigation,
  type IdentitySession,
  organizationRuntimeSettingsSchema,
  sameId,
  compiledPageShellId,
  splitProjectedPage,
  type ApplicationShell,
  type PlatformBlockRelease,
  type ProjectedApplicationFrame,
} from "@vortex/platform/schema";
import type {
  ApplicationAccount,
  PlatformThemeTokens,
  FieldInputControlReleaseMap,
} from "@vortex/ui";
import { resolveIdentitySessionWithEmail } from "../auth/_lib/session-server";
import { resolveApplicationAddress } from "./application-address";
import { loadApplicationSearch } from "./application-search";
import { fieldInputControlReleasesFor, platformBlockReleasesFor } from "./platform-block-releases";
import { requestAddressHeader } from "./request-address";
import { readPageProjections } from "./application-page/load";
import { loadOrganizationLauncher } from "./organization-context";
import { humanOrganizationRequests } from "./server-composition";
import { loadStudioCreateAccess } from "./studio-application-draft";
import { pageSubjectParameter } from "./application-page/placement-helpers";
import type { ApplicationPageModel } from "./application-page";

type ApplicationSearchView = Awaited<ReturnType<typeof loadApplicationSearch>>;

/** Everything the application frame shows, decided on the server for the signed-in viewer. */
export type ApplicationFrameModel = Readonly<{
  frame: ProjectedApplicationFrame;
  /** Presentation only; the frame's layout is already projected under the viewer's access. */
  shells: readonly Pick<ApplicationShell, "shellId" | "key" | "name" | "presentation">[];
  theme: ApplicationPageModel["theme"];
  navigation: ProjectedNavigation;
  application: Readonly<{
    tenantShortName: string;
    organizationShortName: string;
    key: string;
    name: string;
    homePageKey: string;
    /** The organisation's display name, shown in the header; the short name is its address. */
    organizationDisplayName: string;
  }>;
  /** The viewer's BCP 47 locale and IANA time zone: their own, else the organisation's. */
  locale: string;
  timeZone: string;
  /** Where the viewer opens Studio; absent unless they may change drafts in this organisation. */
  studioHref?: string;
  /** The pages the viewer may open, for the current page's menu state and breadcrumb. */
  pages: readonly Readonly<{ pageId: string; key: string; name: string }>[];
  account: ApplicationAccount;
  search: ApplicationSearchView;
  platformBlockReleases: readonly PlatformBlockRelease[];
  fieldInputControlReleases: FieldInputControlReleaseMap;
  platformThemeTokens: PlatformThemeTokens;
  /**
   * The draft this address runs as a preview, and where its Studio is; absent for an installed
   * Application. `seedBoundedPages` names, by page key, the record type of each page whose seed
   * reached the preview bound of `seedBound` records.
   */
  preview?: Readonly<{
    draftRevision: number;
    expiresAt: string;
    studioHref: string;
    seedBound: number;
    seedBoundedPages: Readonly<Record<string, string>>;
  }>;
}>;

/**
 * The locale and time zone dates show in for the viewer: those on their own organisation account,
 * else the organisation's. Read once, under the person's own verified request scope.
 */
const readViewerPresentation = async (
  session: IdentitySession,
  context: InstalledRuntimeContext,
): Promise<Readonly<{ locale: string; timeZone: string }>> => {
  const result = await humanOrganizationRequests().run(
    session,
    runtimeContextSelection(context),
    async (transaction) => {
      const rows = await transaction.query<{ language: unknown; time_zone: unknown }>`
        select language, time_zone from vortex_access.read_own_profile()
      `;
      const own = rows[0];
      if (rows.length !== 1 || own === undefined) throw new Error("FRAME_PROFILE_UNAVAILABLE");
      const organization =
        await readCurrentOrganizationRuntimeSettingsAfterAuthorization(transaction);
      const locale =
        own.language === null
          ? organization?.language
          : organizationRuntimeSettingsSchema.shape.language.parse(own.language);
      const timeZone =
        own.time_zone === null
          ? organization?.timeZone
          : organizationRuntimeSettingsSchema.shape.timeZone.parse(own.time_zone);
      if (locale === undefined || timeZone === undefined)
        throw new Error("FRAME_PRESENTATION_SETTINGS_UNAVAILABLE");
      return { locale, timeZone };
    },
  );
  if (result.kind !== "available")
    throw new Error(`FRAME_PRESENTATION_READ_${result.kind.toUpperCase()}`);
  return result.value;
};

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
 * The theme of the application a request addresses, for the loader drawn while the frame is still
 * being composed. It reads what the frame reads (one resolution per request, shared with it); a
 * request that addresses no page the viewer may open has no theme here, and the platform loader is
 * drawn.
 */
export const loadApplicationStartTheme = cache(
  async (
    tenantShortName: string,
    organizationShortName: string,
    applicationKey: string,
  ): Promise<ApplicationFrameModel["theme"] | undefined> => {
    const addressed = await addressedPage(tenantShortName, organizationShortName, applicationKey);
    if (addressed === undefined) return undefined;
    const { resolution } = await resolveIdentitySessionWithEmail();
    if (resolution.kind !== "active") return undefined;
    const resolved = await resolveApplicationAddress(
      resolution.session,
      tenantShortName,
      organizationShortName,
      applicationKey,
      addressed.pageKey,
    );
    return resolved.kind === "application_page"
      ? resolved.installedContext?.releaseSet.application.content.theme
      : undefined;
  },
);

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
    const shellId = compiledPageShellId(pageDefinition.composition) ?? undefined;
    const shell =
      shellId === undefined
        ? undefined
        : content.shells.find((candidate) => sameId(candidate.shellId, shellId));
    if (shellId !== undefined && shell === undefined)
      throw new Error(
        `Compiled page '${pageDefinition.key}' references missing shell '${shellId}'`,
      );
    const { projectedPageRead, navigationRead } = readPageProjections(
      session,
      context,
      pageDefinition.pageId,
      subject,
      undefined,
      true,
    );
    if (navigationRead === undefined) throw new Error("FRAME_NAVIGATION_NOT_READ");
    const [projected, navigation, presentation, launcher, studioAccess] = await Promise.all([
      projectedPageRead,
      navigationRead,
      readViewerPresentation(session, context),
      loadOrganizationLauncher(session),
      loadStudioCreateAccess(context.organizationId),
    ]);
    if (launcher.kind !== "available")
      throw new Error(`FRAME_ORGANIZATION_LAUNCHER_${launcher.kind.toUpperCase()}`);
    const organization = launcher.entries.find((entry) =>
      sameId(entry.organizationId, context.organizationId),
    );
    if (organization === undefined) throw new Error("FRAME_ORGANIZATION_NOT_LISTED");
    if (projected.kind !== "available" || projected.value === undefined) return undefined;
    if (navigation.kind !== "available") return undefined;

    const { frame } = splitProjectedPage(projected.value, shell);

    const query = addressed.query.getAll("q");
    const expression =
      query.length === 1
        ? query[0] === ""
          ? undefined
          : query[0]
        : query.length === 0
          ? undefined
          : "";
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
    const preview = runtimePreviewOf(context);
    // The pages whose record type's preview seed reached the bound, with that type's plural name.
    const boundedRecordTypes = new Map<string, string>();
    for (const module of context.releaseSet.modules)
      for (const recordType of module.content.recordTypes as readonly Readonly<{
        recordTypeId: string;
        pluralLabel: string;
      }>[])
        if (preview?.seedBoundedRecordTypeIds.some((id) => sameId(id, recordType.recordTypeId)))
          boundedRecordTypes.set(recordType.recordTypeId.toLowerCase(), recordType.pluralLabel);
    const seedBoundedPages: Record<string, string> = {};
    for (const page of content.pages as readonly Readonly<{
      key: string;
      recordType?: Readonly<{ recordTypeId?: string }>;
    }>[]) {
      const label = boundedRecordTypes.get(String(page.recordType?.recordTypeId).toLowerCase());
      if (label !== undefined && permittedKeys.has(page.key)) seedBoundedPages[page.key] = label;
    }
    return {
      frame,
      shells: content.shells.map(({ shellId, key, name, presentation }) => ({
        shellId,
        key,
        name,
        presentation,
      })),
      theme: content.theme,
      navigation: navigation.value,
      application: {
        tenantShortName,
        organizationShortName,
        key: resolved.application.key,
        name: resolved.application.name,
        homePageKey: resolved.application.homePageKey,
        organizationDisplayName: organization.organizationDisplayName,
      },
      ...presentation,
      ...(studioAccess.kind === "available"
        ? { studioHref: `/studio/${encodeURIComponent(studioAccess.organizationId)}` }
        : {}),
      pages: content.pages
        .filter((page) => permittedKeys.has(page.key))
        .map((page) => ({ pageId: page.pageId, key: page.key, name: page.name })),
      account:
        resolved.read.accountDisplayName === undefined
          ? { email }
          : { email, displayName: resolved.read.accountDisplayName },
      search,
      platformBlockReleases: platformBlockReleasesFor(content.shells),
      fieldInputControlReleases: fieldInputControlReleasesFor(
        ...content.shells.map((candidate) => candidate.layout),
      ),
      platformThemeTokens: DEFAULT_PLATFORM_THEME_RELEASE.tokens,
      ...(preview === undefined
        ? {}
        : {
            preview: {
              draftRevision: preview.draftRevision,
              expiresAt: preview.expiresAt,
              seedBound: PREVIEW_SEED_RECORD_BOUND,
              seedBoundedPages,
              studioHref: `/studio/${encodeURIComponent(context.organizationId)}/${encodeURIComponent(context.applicationRootId)}`,
            },
          }),
    };
  },
);
