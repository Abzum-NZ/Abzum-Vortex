"use server";

import type { ApplicationSwitcherData } from "@vortex/ui";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { loadApplicationSearch } from "../../../_lib/application-search";
import { loadPermittedApplicationsAtAddress } from "../../../_lib/organization-context";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import { readApplicationReleaseAdoption } from "../../../_lib/application-release-adoption";
import {
  matchesLiteralSearchText,
  runtimePreviewOf,
  splitSearchFilters,
} from "@vortex/platform/server";
import { mapWebError } from "../../../_lib/web-error-mapper";

type ApplicationSearchView = Awaited<ReturnType<typeof loadApplicationSearch>>;

/** Rechecks the session, addressed installation and adoption authority when the account menu opens. */
export async function readReleaseAdoptionAction(
  tenantShortName: string,
  organizationShortName: string,
  applicationKey: string,
): Promise<
  | Readonly<{
      state: "available";
      offer?: Readonly<{
        version: string;
        offeredReleaseRevision: number;
        installedReleaseRevision: number;
      }>;
    }>
  | Readonly<{ state: "unavailable" | "temporarily_unavailable" }>
> {
  if (
    [tenantShortName, organizationShortName, applicationKey].some(
      (value) => typeof value !== "string" || value.length === 0,
    )
  ) {
    console.error("[application-frame] adoption read refused: malformed address");
    return { state: "unavailable" };
  }
  try {
    const resolution = await resolveIdentitySession();
    if (resolution.kind !== "active") {
      console.error(`[application-frame] adoption read refused: session ${resolution.kind}`);
      return {
        state:
          resolution.kind === "temporarily_unavailable" ? "temporarily_unavailable" : "unavailable",
      };
    }
    const addressed = await resolveApplicationAddress(
      resolution.session,
      tenantShortName,
      organizationShortName,
      applicationKey,
    );
    if (addressed.kind !== "application_page") {
      console.error(`[application-frame] adoption read refused: address ${addressed.kind}`);
      return {
        state:
          addressed.kind === "temporarily_unavailable" ? "temporarily_unavailable" : "unavailable",
      };
    }
    const context = addressed.installedContext;
    if (context === undefined) throw new Error("APPLICATION_RELEASE_ADOPTION_CONTEXT_MISSING");
    if (runtimePreviewOf(context) !== undefined) return { state: "available" };
    const target = await readApplicationReleaseAdoption(resolution.session, {
      organizationId: context.organizationId,
      applicationRootId: context.applicationRootId,
    });
    return {
      state: "available",
      ...(target === undefined ||
      target.currentReleaseRevision <= context.applicationReleaseRevision
        ? {}
        : {
            offer: {
              version: target.currentReleaseVersion,
              offeredReleaseRevision: target.currentReleaseRevision,
              installedReleaseRevision: context.applicationReleaseRevision,
            },
          }),
    };
  } catch (error) {
    return mapWebError(error, {
      route: "application-frame",
      operation: "read_release_adoption",
      code: "APPLICATION_RELEASE_ADOPTION_READ_FAILED",
      fallback: { state: "temporarily_unavailable" },
    });
  }
}

/** Reads the viewer's permitted application links on switcher intent or open. */
export async function readApplicationSwitcherAction(
  tenantShortName: string,
  organizationShortName: string,
): Promise<ApplicationSwitcherData> {
  if ([tenantShortName, organizationShortName].some((value) => typeof value !== "string")) {
    console.error("[application-frame] switcher refused: malformed address");
    return { state: "unavailable", applications: [] };
  }
  const resolution = await resolveIdentitySession();
  if (resolution.kind !== "active") {
    console.error(`[application-frame] switcher refused: session ${resolution.kind}`);
    return { state: "unavailable", applications: [] };
  }
  try {
    const read = await loadPermittedApplicationsAtAddress(
      resolution.session,
      tenantShortName,
      organizationShortName,
    );
    if (read.kind === "temporarily_unavailable")
      console.error(
        `[application-shell] permitted applications unavailable: cause=${read.cause ?? "cause_not_provided"}`,
      );
    return {
      state:
        read.kind === "available"
          ? "available"
          : read.kind === "temporarily_unavailable"
            ? "temporarily_unavailable"
            : "unavailable",
      applications:
        read.kind === "available"
          ? read.applications.map((candidate) => ({
              key: candidate.key,
              name: candidate.name,
              icon: candidate.icon,
              href: `/${encodeURIComponent(tenantShortName)}/${encodeURIComponent(organizationShortName)}/${encodeURIComponent(candidate.key)}/${encodeURIComponent(candidate.homePageKey)}`,
            }))
          : [],
    };
  } catch (error) {
    console.error("[application-shell] permitted applications failed", error);
    return { state: "temporarily_unavailable", applications: [] };
  }
}

/**
 * Searches one application for the frame's header search when the address's query changes without
 * a new document. Only the expression comes from the browser; the address is rechecked against the
 * signed-in person's own permitted applications by the search read itself.
 */
export async function searchApplicationAction(
  tenantShortName: string,
  organizationShortName: string,
  applicationKey: string,
  expression: string,
  cursor?: string,
): Promise<ApplicationSearchView> {
  if (
    [tenantShortName, organizationShortName, applicationKey, expression].some(
      (value) => typeof value !== "string",
    )
  ) {
    console.error("[application-frame] search refused: malformed address or expression");
    return { kind: "unavailable" };
  }
  const resolution = await resolveIdentitySession();
  if (resolution.kind !== "active") {
    console.error(`[application-frame] search refused: session ${resolution.kind}`);
    return { kind: "unavailable" };
  }
  return loadApplicationSearch(
    resolution.session,
    { tenantShortName, organizationShortName, applicationKey },
    expression,
    cursor,
  );
}

/** Search only applications currently openable by this signed-in viewer. */
export async function searchLauncherAction(
  tenantShortName: string,
  organizationShortName: string,
  expression: string,
  groupKey?: string,
  cursor?: string,
): Promise<
  | { kind: "unavailable" }
  | { kind: "refused"; reason: string }
  | {
      kind: "available";
      groups: {
        key: string;
        title: string;
        results: { href: string; title: string; subtitle?: string }[];
        cursor?: string;
      }[];
    }
> {
  const resolution = await resolveIdentitySession();
  if (resolution.kind !== "active" || expression.length > 2_000) return { kind: "unavailable" };
  const read = await loadPermittedApplicationsAtAddress(
    resolution.session,
    tenantShortName,
    organizationShortName,
  );
  if (read.kind !== "available") return { kind: "unavailable" };
  const split = splitSearchFilters(expression);
  if (split === undefined || (split.literal === "" && split.filters.length === 0))
    return { kind: "refused", reason: "Check the search expression." };
  const groups: {
    key: string;
    title: string;
    results: { href: string; title: string; subtitle?: string }[];
    cursor?: string;
  }[] = [];
  if (groupKey === undefined || groupKey === "applications") {
    const apps =
      split.filters.length > 0
        ? []
        : read.applications.filter((app) => matchesLiteralSearchText(split.literal, app.name));
    if (split.filters.length === 0 && matchesLiteralSearchText(split.literal, "") === undefined)
      return { kind: "refused", reason: "Check the search expression." };
    const start =
      cursor === undefined || groupKey === undefined
        ? 0
        : apps.findIndex((app) => app.key === cursor) + 1;
    if (cursor !== undefined && groupKey === "applications" && start === 0)
      return { kind: "unavailable" };
    const page = apps.slice(start, Math.min(start + 40, 200));
    if (page.length > 0)
      groups.push({
        key: "applications",
        title: "Applications",
        results: page.map((app) => ({
          title: app.name,
          href: `/${encodeURIComponent(tenantShortName)}/${encodeURIComponent(organizationShortName)}/${encodeURIComponent(app.key)}/${encodeURIComponent(app.homePageKey)}`,
        })),
        ...(start + page.length < Math.min(apps.length, 200)
          ? { cursor: page[page.length - 1]!.key }
          : {}),
      });
  }
  let refusal: string | undefined;
  for (const app of read.applications) {
    const key = `records:${app.key}`;
    if (groupKey !== undefined && groupKey !== key) continue;
    const result = await loadApplicationSearch(
      resolution.session,
      { tenantShortName, organizationShortName, applicationKey: app.key },
      expression,
      groupKey === key ? cursor : undefined,
    );
    if (result.kind === "refused") refusal = result.reason;
    if (result.kind === "available" && (result.results.length > 0 || result.cursor !== undefined))
      groups.push({
        key,
        title: app.name,
        results: [...result.results],
        ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
      });
  }
  if (groups.length === 0 && refusal !== undefined) return { kind: "refused", reason: refusal };
  return { kind: "available", groups };
}
