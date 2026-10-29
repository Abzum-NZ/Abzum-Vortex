import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  createInstalledContextLoader,
  readAddressedApplicationAtAddress,
  requireInstalledRuntimeContext,
  resolvePermittedApplicationAddress,
} from "@vortex/platform/server";
import { sameId, type IdentitySession } from "@vortex/platform/schema";
import {
  searchInstalledApplication,
  sealApplicationSearchCursor,
  openApplicationSearchCursor,
} from "@vortex/platform/server";
import { createApplicationPageLinkReader } from "./application-page-link";
import { applicationPageAddressPath } from "./address-paths";
import {
  humanOrganizationRequestDependencies,
  humanOrganizationRequestsFor,
} from "./server-composition";
import { mapWebError } from "./web-error-mapper";
import { getQueryContinuationKey } from "./query-continuation-key";
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
const positionSchema = z.object({ score: z.number().int().nonnegative(), id: z.uuid() }).strict();
const scanStateSchema = z
  .object({
    scan: positionSchema.nullable(),
    held: z.array(positionSchema).max(200),
    done: z.boolean(),
  })
  .strict();
const cursorSchema = z
  .object({
    query: z.string(),
    count: z.number().int().min(0).max(199),
    cursor: z
      .object({
        after: positionSchema.nullable(),
        types: z.record(z.uuid(), scanStateSchema),
      })
      .strict(),
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
      .update(JSON.stringify([session.identityId, address, expression]))
      .digest("hex");
    let after: z.infer<typeof cursorSchema> | undefined;
    const invalidCursor = {
      kind: "refused",
      expression: expression ?? "",
      reason: "The search continuation is invalid. Run the search again.",
    } as const;
    if (cursor !== undefined) {
      if (cursor.length > 1_000_000) return invalidCursor;
      try {
        const opened = openApplicationSearchCursor(getQueryContinuationKey(), cursor);
        if (opened.kind !== "opened") return invalidCursor;
        const parsed = cursorSchema.safeParse(opened.payload);
        if (!parsed.success || parsed.data.query !== query) return invalidCursor;
        after = parsed.data;
      } catch (error) {
        console.error("[application-search] invalid continuation", error);
        return invalidCursor;
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
        const context = requireInstalledRuntimeContext(
          await createInstalledContextLoader(transaction, scope).load(),
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
        const allowedRecordTypeIds = new Set<string>();
        const permittedPages = new Map<string, boolean>();
        for (const entry of configuration.recordTypes) {
          if (entry.recordType.state !== "resolved") continue;
          const page = application.content.pages.find((candidate) =>
            sameId(candidate.pageId, entry.targetPageId),
          );
          if (page === undefined) continue;
          let permitted = permittedPages.get(page.key);
          if (permitted === undefined) {
            const link = await createApplicationPageLinkReader(address).read(session, {
              kind: "page",
              applicationKey: address.applicationKey,
              pageKey: page.key,
            });
            permitted =
              link.availability === "available" &&
              sameId(link.organizationId, context.organizationId) &&
              sameId(link.applicationRootId, context.applicationRootId) &&
              link.applicationReleaseRevision === application.releaseRevision &&
              link.contentFingerprint === application.contentFingerprint &&
              link.resolutionFingerprint === application.resolutionFingerprint;
            permittedPages.set(page.key, permitted);
          }
          if (permitted)
            allowedRecordTypeIds.add(String(entry.recordType.recordTypeId).toLowerCase());
        }
        const result = await searchInstalledApplication({
          transaction,
          allowedRecordTypeIds,
          ...(after === undefined ? {} : { cursor: after.cursor }),
          limit: Math.min(40, 200 - (after?.count ?? 0)),
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
          ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
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
    const results: { href: string; title: string; subtitle?: string; score: number; id: string }[] =
      [];
    for (const match of result.matches) {
      const page = result.pages.find((candidate) => sameId(candidate.pageId, match.targetPageId));
      if (page === undefined) throw new Error("SEARCH_PAGE_MISSING");
      results.push({
        href: `${applicationPageAddressPath(address.tenantShortName, address.organizationShortName, address.applicationKey, page.key)}?record_id=${encodeURIComponent(match.recordId)}`,
        title: match.title,
        score: match.rank,
        id: match.recordId,
        ...(match.subtitle === undefined ? {} : { subtitle: match.subtitle }),
      });
    }
    const count = (after?.count ?? 0) + results.length;
    const next =
      count < 200 && result.cursor !== undefined
        ? sealApplicationSearchCursor(getQueryContinuationKey(), {
            query,
            cursor: result.cursor,
            count,
          })
        : undefined;
    return {
      kind: "available",
      expression: expression!,
      results: results.map((result) => ({
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
