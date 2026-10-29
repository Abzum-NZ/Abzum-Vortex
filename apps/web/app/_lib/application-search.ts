import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  createHumanInstalledPageBundleContextLoader,
  readAddressedApplicationAtAddress,
  requireInstalledRuntimeContext,
  resolvePermittedApplicationAddress,
} from "@vortex/platform/server";
import { sameId, type IdentitySession } from "@vortex/platform/schema";
import { searchInstalledApplication } from "@vortex/platform/server";
import { createApplicationPageLinkReader } from "./application-page-link";
import { applicationPageAddressPath } from "./address-paths";
import {
  humanOrganizationRequestDependencies,
  humanOrganizationRequestsFor,
} from "./server-composition";
import { mapWebError } from "./web-error-mapper";
import { platformPermissionSource } from "./platform-permission-source";

type ApplicationSearchView =
  | Readonly<{ kind: "disabled" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "refused"; expression: string; reason: string }>
  | Readonly<{
      kind: "available";
      expression: string;
      results: readonly Readonly<{ href: string; title: string; subtitle?: string }>[];
      more: boolean;
      cursor?: string;
    }>;
const unavailable = { kind: "unavailable" } as const;
const cursorSchema = z
  .object({
    query: z.string(),
    score: z.number(),
    id: z.uuid(),
    count: z.number().int().min(1).max(160),
  })
  .strict();
/** Only the expression comes from the browser; address, release and fields are server-bound. */
export const loadApplicationSearch = async (
  session: IdentitySession,
  address: Readonly<{
    tenantShortName: string;
    organizationShortName: string;
    applicationKey: string;
  }>,
  expression: string | undefined,
  cursor?: string,
): Promise<ApplicationSearchView> => {
  try {
    const query = createHash("sha256")
      .update(JSON.stringify([address, expression]))
      .digest("hex");
    let after: z.infer<typeof cursorSchema> | undefined;
    if (cursor !== undefined) {
      if (cursor.length > 1_000) return unavailable;
      try {
        const parsed = cursorSchema.safeParse(
          JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
        );
        if (!parsed.success || parsed.data.query !== query) return unavailable;
        after = parsed.data;
      } catch (error) {
        console.error("[application-search] invalid continuation", error);
        return unavailable;
      }
    }
    const dependencies = humanOrganizationRequestDependencies();
    const { read } = await readAddressedApplicationAtAddress(
      platformPermissionSource,
      session,
      address.tenantShortName,
      address.organizationShortName,
      dependencies.identityAuthorityId,
      address.applicationKey,
    );
    if (
      read.kind !== "available" ||
      read.tenantShortName !== address.tenantShortName ||
      read.organizationShortName !== address.organizationShortName ||
      read.applications.length !== 1
    )
      return unavailable;
    const target = resolvePermittedApplicationAddress(read, address.applicationKey);
    if (target.kind !== "available" || target.application === null) return unavailable;
    const applicationRootId = target.application.applicationRootId;
    const searched = await humanOrganizationRequestsFor(dependencies).run(
      session,
      { organizationId: read.organizationId, applicationRootId },
      async (transaction, scope) => {
        const scopedApplicationRootId = scope.applicationRootId;
        if (scopedApplicationRootId === undefined) throw new Error("SEARCH_SCOPE_UNAVAILABLE");
        const context = requireInstalledRuntimeContext(
          await createHumanInstalledPageBundleContextLoader({
            transaction,
            scope: {
              organizationId: scope.organizationId,
              organizationAccountId: scope.organizationAccountId,
              applicationRootId: scopedApplicationRootId,
            },
          }).load(),
        );
        const application = context.releaseSet.application;
        if (
          application.definitionKey !== address.applicationKey ||
          !sameId(context.applicationRootId, applicationRootId)
        )
          throw new Error("SEARCH_SCOPE_UNAVAILABLE");
        const configuration = application.content.search;
        if (configuration === undefined || !configuration.enabled)
          return { kind: "disabled" as const };
        if (
          expression !== undefined &&
          (expression.length > 2_000 || expression.trim().length === 0)
        )
          return { kind: "refused" as const };
        if (expression === undefined) return { kind: "ready" as const };
        const result = await searchInstalledApplication({
          transaction,
          scope,
          configuration,
          expression,
          applicationReleaseRevision: context.applicationReleaseRevision,
          modules: context.releaseSet.modules.map((module) => ({
            rootId: module.rootId,
            releaseRevision: module.releaseRevision,
            recordTypeIds: module.content.recordTypes.map((record) => record.recordTypeId),
            recordTypeFields: module.content.recordTypes.map((record) => ({
              recordTypeId: record.recordTypeId,
              fields: record.fields,
            })),
          })),
        });
        if (result.kind !== "available") return result;
        return {
          kind: "searched" as const,
          matches: result.matches,
          pages: application.content.pages,
          revision: application.releaseRevision,
          organizationId: context.organizationId,
          applicationRootId: context.applicationRootId,
          contentFingerprint: application.contentFingerprint,
          resolutionFingerprint: application.resolutionFingerprint,
        };
      },
    );
    if (searched.kind !== "available") return unavailable;
    if (searched.value.kind === "disabled") return { kind: "disabled" };
    if (searched.value.kind === "ready")
      return { kind: "available", expression: "", results: [], more: false };
    if (searched.value.kind === "refused" && searched.value.reason !== undefined)
      return { kind: "refused", expression: expression ?? "", reason: searched.value.reason };
    if (searched.value.kind !== "searched") return unavailable;
    const result = searched.value;
    const links = new Map<
      string,
      Awaited<ReturnType<ReturnType<typeof createApplicationPageLinkReader>["read"]>>
    >();
    const results: { href: string; title: string; subtitle?: string; score: number; id: string }[] =
      [];
    for (const match of result.matches) {
      if (
        after !== undefined &&
        (match.rank > after.score ||
          (match.rank === after.score && match.recordId.localeCompare(after.id) <= 0))
      )
        continue;
      const page = result.pages.find((page) => sameId(page.pageId, match.targetPageId));
      if (page === undefined) continue;
      let link = links.get(page.key);
      if (link === undefined) {
        link = await createApplicationPageLinkReader(address).read(session, {
          kind: "page",
          applicationKey: address.applicationKey,
          pageKey: page.key,
        });
        links.set(page.key, link);
      }
      if (
        link.availability !== "available" ||
        !sameId(link.organizationId, result.organizationId) ||
        !sameId(link.applicationRootId, result.applicationRootId) ||
        link.applicationReleaseRevision !== result.revision ||
        link.contentFingerprint !== result.contentFingerprint ||
        link.resolutionFingerprint !== result.resolutionFingerprint
      )
        continue;
      results.push({
        href: `${applicationPageAddressPath(address.tenantShortName, address.organizationShortName, address.applicationKey, page.key)}?record_id=${encodeURIComponent(match.recordId)}`,
        title: match.title,
        score: match.rank,
        id: match.recordId,
        ...(match.subtitle === undefined ? {} : { subtitle: match.subtitle }),
      });
      if (results.length === 41) break;
    }
    const page = results.slice(0, 40);
    const count = (after?.count ?? 0) + page.length;
    const last = page[page.length - 1];
    const next =
      results.length > 40 && count < 200 && last !== undefined
        ? Buffer.from(JSON.stringify({ query, score: last.score, id: last.id, count })).toString(
            "base64url",
          )
        : undefined;
    return {
      kind: "available",
      expression: expression!,
      results: page.map((result) => ({
        href: result.href,
        title: result.title,
        ...(result.subtitle === undefined ? {} : { subtitle: result.subtitle }),
      })),
      more: next !== undefined,
      ...(next === undefined ? {} : { cursor: next }),
    };
  } catch (error) {
    return mapWebError(error, {
      route: "application-search",
      operation: "search",
      code: "APPLICATION_SEARCH_FAILED",
      fallback: unavailable,
    });
  }
};
