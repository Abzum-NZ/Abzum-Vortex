import "server-only";

import { z } from "zod";
import { createHumanInstalledRuntimeContextLoader, readAddressedApplicationAtAddress, requireInstalledRuntimeContext, resolvePermittedApplicationAddress } from "@vortex/app";
import { activeApplicationInstallationEvidenceSchema, fieldIdSchema, jsonValueSchema, recordIdSchema, revisionSchema, sameId, type IdentitySession } from "@vortex/contracts";
import type { DatabaseRow } from "@vortex/db";
import { createDatabaseApplicationBoundReleaseSetService } from "@vortex/definition";
import { createActiveApplicationInstallationRepository } from "@vortex/module";
import { protectedQueryRowCapabilitiesSchema } from "@vortex/query";
import { searchConfiguredApplication, searchDocumentSchemaVersion, type ApplicationSearchRecord, type SearchDocument } from "@vortex/search";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { createApplicationPageLinkReader } from "./application-page-link";
import { applicationPageAddressPath } from "./address-paths";
import { humanOrganizationRequestDependencies, humanOrganizationRequestsFor } from "./server-composition";

export type ApplicationSearchView =
  | Readonly<{ kind: "disabled" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "available"; expression: string; results: readonly Readonly<{ href: string; title: string; subtitle?: string }>[]; more: boolean }>;
const unavailable = { kind: "unavailable" } as const;
const recordSchema = z.object({ outcome: z.literal("allowed"), recordId: recordIdSchema,
  concurrencyNumber: revisionSchema, values: z.record(fieldIdSchema, jsonValueSchema) }).strict();

/** Only the expression comes from the browser; address, release and fields are server-bound. */
export const loadApplicationSearch = async (
  session: IdentitySession,
  address: Readonly<{ tenantShortName: string; organizationShortName: string; applicationKey: string }>,
  expression: string | undefined,
): Promise<ApplicationSearchView> => {
  try {
    const dependencies = humanOrganizationRequestDependencies();
    const { read } = await readAddressedApplicationAtAddress(session, address.tenantShortName, address.organizationShortName,
      dependencies.identityAuthorityId, address.applicationKey);
    if (read.kind !== "available" || read.tenantShortName !== address.tenantShortName || read.organizationShortName !== address.organizationShortName || read.applications.length !== 1)
      return unavailable;
    const target = resolvePermittedApplicationAddress(read, address.applicationKey);
    if (target.kind !== "available" || target.application === null) return unavailable;
    const applicationRootId = target.application.applicationRootId;
    const searched = await humanOrganizationRequestsFor(dependencies).run(session,
      { organizationId: read.organizationId, applicationRootId }, async (transaction, scope) => {
        const scopedApplicationRootId = scope.applicationRootId;
        if (scopedApplicationRootId === undefined) throw new Error("SEARCH_SCOPE_UNAVAILABLE");
        const context = requireInstalledRuntimeContext(await createHumanInstalledRuntimeContextLoader({
          activeInstallationReader: createActiveApplicationInstallationRepository(transaction),
          releaseSetReader: createDatabaseApplicationBoundReleaseSetService(installedReleaseCatalogue, transaction),
          scope: { organizationId: scope.organizationId, applicationRootId: scopedApplicationRootId },
        }).load());
        const application = context.releaseSet.application;
        if (application.definitionKey !== address.applicationKey || !sameId(context.applicationRootId, applicationRootId))
          throw new Error("SEARCH_SCOPE_UNAVAILABLE");
        const configuration = application.content.search;
        if (configuration === undefined || !configuration.enabled) return { kind: "disabled" as const };
        if (expression !== undefined && (expression.length > 2_000 || expression.trim().length === 0))
          return { kind: "refused" as const };
        if (expression === undefined) return { kind: "ready" as const };
        const candidates: SearchDocument[] = [];
        for (const entry of configuration.recordTypes) {
          if (entry.recordType.state !== "resolved") throw new Error("SEARCH_CONFIGURATION_UNAVAILABLE");
          const rows = await transaction.query<DatabaseRow>`
            select record_id, source_record_version, document_schema_version, entries, content_fingerprint
            from vortex_search.documents
            where organization_id = ${scope.organizationId}::uuid
              and application_root_id = ${scopedApplicationRootId}::uuid
              and record_type_id = ${entry.recordType.recordTypeId}::uuid and not deleted
            order by record_id limit ${1_001 - candidates.length}
          `;
          if (rows.length + candidates.length > 1_000) throw new Error("SEARCH_CANDIDATE_BOUND_EXCEEDED");
          for (const row of rows) {
            if (Number(row.document_schema_version) !== searchDocumentSchemaVersion) throw new Error("SEARCH_DOCUMENT_UNAVAILABLE");
            candidates.push({ kind: "document", schemaVersion: searchDocumentSchemaVersion,
            organisationId: scope.organizationId, applicationRootId: scopedApplicationRootId,
            recordTypeId: entry.recordType.recordTypeId, recordId: String(row.record_id),
            sourceRecordVersion: Number(row.source_record_version), entries: row.entries as SearchDocument["entries"],
            contentFingerprint: String(row.content_fingerprint) });
          }
        }
        const result = await searchConfiguredApplication({ scope, configuration, expression, candidates,
          readCurrentRecord: async (request): Promise<ApplicationSearchRecord | undefined> => {
            const entry = configuration.recordTypes.find((entry) => entry.recordType.state === "resolved" && sameId(entry.recordType.recordTypeId, request.recordTypeId));
            if (entry?.recordType.state !== "resolved" || !sameId(request.organizationId, scope.organizationId) || !sameId(request.applicationRootId, scopedApplicationRootId)) return undefined;
            const recordType = entry.recordType;
            const module = context.releaseSet.modules.find((module) => sameId(module.rootId, recordType.moduleRootId));
            if (module === undefined || !module.content.recordTypes.some((record) => sameId(record.recordTypeId, request.recordTypeId))) return undefined;
            // The exact current installation gates the fixed read in one statement. No table
            // projection, caller field list or System principal supplies Record authority.
            const rows = await transaction.query<DatabaseRow>`
              with active_installation as materialized (
                select vortex_module.read_current_active_installation() as value
              ), verified_installation as materialized (
                select value from active_installation
                where pg_catalog.lower(value ->> 'organizationId') = pg_catalog.lower(${scope.organizationId}::text)
                  and pg_catalog.lower(value ->> 'applicationRootId') = pg_catalog.lower(${scopedApplicationRootId}::text)
                  and (value ->> 'applicationReleaseRevision')::bigint = ${context.applicationReleaseRevision}::bigint
                  and exists (select 1 from pg_catalog.jsonb_array_elements(value -> 'moduleBindings') as binding(value)
                    where pg_catalog.lower(binding.value ->> 'moduleRootId') = pg_catalog.lower(${module.rootId}::text)
                      and (binding.value ->> 'moduleReleaseRevision')::bigint = ${module.releaseRevision}::bigint
                      and binding.value ->> 'state' = 'active')
              )
              select active_installation.value as installation,
                (select vortex_record.read_record(${request.recordTypeId}::uuid, ${request.recordId}::uuid) from verified_installation) as record,
                (select vortex_record.read_record_capabilities(${request.recordTypeId}::uuid, ${request.recordId}::uuid) from verified_installation) as capabilities
              from active_installation
            `;
            if (rows.length !== 1) return undefined;
            const installation = activeApplicationInstallationEvidenceSchema.safeParse(rows[0]?.installation);
            const record = recordSchema.safeParse(rows[0]?.record);
            const capabilities = protectedQueryRowCapabilitiesSchema.safeParse(rows[0]?.capabilities);
            if (!installation.success || !record.success || !capabilities.success || !sameId(record.data.recordId, request.recordId) ||
                installation.data.applicationReleaseRevision !== context.applicationReleaseRevision || !sameId(installation.data.organizationId, scope.organizationId) ||
                !sameId(installation.data.applicationRootId, scopedApplicationRootId)) return undefined;
            const allowedFields = new Set([...entry.fields.map((field) => String(field.fieldId)), String(entry.titleFieldId),
              ...(entry.subtitleFieldId === undefined ? [] : [String(entry.subtitleFieldId)])].map((fieldId) => fieldId.toLowerCase()));
            return { concurrencyNumber: record.data.concurrencyNumber,
              values: Object.fromEntries(Object.entries(record.data.values).filter(([fieldId]) => allowedFields.has(fieldId.toLowerCase()))) };
          },
        });
        if (result.kind !== "available") return result;
        return { kind: "searched" as const, matches: result.matches,
          pages: application.content.pages, revision: application.releaseRevision,
          organizationId: context.organizationId, applicationRootId: context.applicationRootId,
          contentFingerprint: application.contentFingerprint, resolutionFingerprint: application.resolutionFingerprint };
      });
    if (searched.kind !== "available") return unavailable;
    if (searched.value.kind === "disabled") return { kind: "disabled" };
    if (searched.value.kind === "ready") return { kind: "available", expression: "", results: [], more: false };
    if (searched.value.kind !== "searched") return unavailable;
    const result = searched.value;
    const links = new Map<string, Awaited<ReturnType<ReturnType<typeof createApplicationPageLinkReader>["read"]>>>();
    const results: { href: string; title: string; subtitle?: string }[] = [];
    for (const match of result.matches) {
      const page = result.pages.find((page) => sameId(page.pageId, match.targetPageId));
      if (page === undefined) continue;
      let link = links.get(page.key);
      if (link === undefined) {
        link = await createApplicationPageLinkReader(address).read(session, { kind: "page", applicationKey: address.applicationKey, pageKey: page.key });
        links.set(page.key, link);
      }
      if (link.availability !== "available" || !sameId(link.organizationId, result.organizationId) || !sameId(link.applicationRootId, result.applicationRootId) || link.applicationReleaseRevision !== result.revision || link.contentFingerprint !== result.contentFingerprint || link.resolutionFingerprint !== result.resolutionFingerprint) continue;
      results.push({ href: `${applicationPageAddressPath(address.tenantShortName, address.organizationShortName, address.applicationKey, page.key)}?record_id=${encodeURIComponent(match.recordId)}`,
        title: match.title, ...(match.subtitle === undefined ? {} : { subtitle: match.subtitle }) });
      if (results.length === 51) break;
    }
    return { kind: "available", expression: expression!, results: results.slice(0, 50), more: results.length > 50 };
  } catch { return unavailable; }
};
