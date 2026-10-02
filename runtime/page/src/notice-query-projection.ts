import "server-only";

import { requireInstalledRuntimeContext, type InstalledRuntimeContext } from "@vortex/app";
import {
  QUERY_NOTICE_BLOCK_RELEASE,
  sameId,
  validateComponentSettings,
  type BlockPropertyValueV2Contract,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
} from "@vortex/contracts";
import {
  protectedQueryCommandSchema,
  protectedQueryPageSchema,
  type ProtectedQueryCommand,
} from "@vortex/query";
import type { RecordsTableQueryRunner } from "./records-table-query";

export type QueryNoticeSeverity = "info" | "success" | "warning" | "critical";
export type ProjectedQueryNotice = Readonly<{
  recordId: string;
  revision: number;
  message: string;
  severity: QueryNoticeSeverity;
  title?: string;
  link?: Readonly<{ label: string; href: string }>;
}>;
export type ProjectedQueryNoticePage = Readonly<{
  kind: "query_notice";
  items: readonly ProjectedQueryNotice[];
  truncated: boolean;
}>;
export type QueryNoticeResolution =
  | Readonly<{ status: "ready"; values: ProjectedQueryNoticePage }>
  | Readonly<{ status: "refused"; reason: "not_permitted" }>
  | Readonly<{ status: "error" }>;

type Settings = Readonly<Record<string, BlockPropertyValueV2Contract>>;
type InstalledModule = InstalledRuntimeContext["releaseSet"]["modules"][number];
type Mapping = Readonly<{
  message: string;
  title?: string;
  severity?: string;
  linkLabel?: string;
  linkHref?: string;
  defaultSeverity: QueryNoticeSeverity;
}>;
export type QueryNoticeQueryBinding = Readonly<{
  command: ProtectedQueryCommand;
  moduleReleaseVersion: string;
  mapping: Mapping;
}>;

const REFUSED = Object.freeze({ status: "refused", reason: "not_permitted" } as const);
const ERROR = Object.freeze({ status: "error" } as const);
const isSeverity = (value: unknown): value is QueryNoticeSeverity =>
  value === "info" || value === "success" || value === "warning" || value === "critical";

const fieldReference = (settings: Settings, key: string): string | undefined => {
  const value = Object.hasOwn(settings, key) ? settings[key] : undefined;
  return value?.kind === "field_reference" ? value.fieldId : undefined;
};

/** Builds only the installed query's declared field projection; it carries no actor authority. */
export const buildQueryNoticeQueryBinding = (
  candidateContext: InstalledRuntimeContext,
  queryId: string,
  settings: Settings,
  inputValues: Readonly<Record<string, JsonValue>>,
): QueryNoticeQueryBinding | undefined => {
  const context = requireInstalledRuntimeContext(candidateContext);
  if (validateComponentSettings(settings, QUERY_NOTICE_BLOCK_RELEASE.properties).length !== 0)
    return undefined;
  const matches = context.releaseSet.modules.flatMap((module) =>
    module.content.queries.flatMap((query) => sameId(query.queryId, queryId) ? [{ module, query }] : []),
  );
  const bound = matches[0];
  if (matches.length !== 1 || bound === undefined) return undefined;
  const query = bound.query;
  const target = query.recordType;
  if (target.state !== "resolved" || query.groupByFieldIds.length !== 0 || query.aggregates.length !== 0)
    return undefined;
  const targetModule: InstalledModule | undefined = context.releaseSet.modules.find((module) =>
    sameId(module.rootId, target.moduleRootId),
  );
  const recordType = targetModule?.content.recordTypes.find((record) =>
    sameId(record.recordTypeId, target.recordTypeId),
  );
  if (recordType === undefined) return undefined;
  const message = fieldReference(settings, "message_field");
  if (message === undefined) return undefined;
  const title = fieldReference(settings, "title_field");
  const severity = fieldReference(settings, "severity_field");
  const linkLabel = fieldReference(settings, "link_label_field");
  const linkHref = fieldReference(settings, "link_href_field");
  const authoredSeverity = settings.severity;
  const severityDeclaration = QUERY_NOTICE_BLOCK_RELEASE.properties.find((property) => property.key === "severity");
  const defaultSeverity = authoredSeverity?.kind === "choice"
    ? authoredSeverity.value
    : severityDeclaration?.defaultValue?.kind === "choice"
      ? severityDeclaration.defaultValue.value
      : undefined;
  if (!isSeverity(defaultSeverity)) return undefined;
  const roles = [
    { id: message, role: "text" },
    ...(title === undefined ? [] : [{ id: title, role: "text" }]),
    ...(severity === undefined ? [] : [{ id: severity, role: "severity" }]),
    ...(linkLabel === undefined ? [] : [{ id: linkLabel, role: "text" }]),
    ...(linkHref === undefined ? [] : [{ id: linkHref, role: "href" }]),
  ];
  const selected = new Set(query.selectedFieldIds.map((id) => id.toLowerCase()));
  for (const role of roles) {
    const field = recordType.fields.find((field) => sameId(field.fieldId, role.id));
    if (field === undefined || !selected.has(role.id.toLowerCase())) return undefined;
    if (role.role === "severity") {
      if (field.type !== "choice" || !field.settings.options.every((option) => isSeverity(option.value)))
        return undefined;
    } else if (role.role === "href") {
      if (field.type !== "text" && field.type !== "web_address") return undefined;
    } else if (field.type !== "text" && field.type !== "long_text") return undefined;
  }
  if (Object.keys(inputValues).some((key) => !query.inputs.some((input) => input.key === key)))
    return undefined;
  const parsed = protectedQueryCommandSchema.safeParse({
    moduleRootId: bound.module.rootId,
    queryId: query.queryId,
    inputValues,
    requestedFieldIds: [...new Set(roles.map((role) => role.id.toLowerCase()))],
    requestedSystemFieldKeys: [],
    sort: [],
    sortableFieldIds: [],
    filterableFieldIds: [],
    searchableFieldIds: [],
    pageSize: query.pageSize,
  });
  if (!parsed.success) return undefined;
  return Object.freeze({
    command: parsed.data,
    moduleReleaseVersion: bound.module.releaseVersion,
    mapping: Object.freeze({
      message,
      ...(title === undefined ? {} : { title }),
      ...(severity === undefined ? {} : { severity }),
      ...(linkLabel === undefined ? {} : { linkLabel }),
      ...(linkHref === undefined ? {} : { linkHref }),
      defaultSeverity,
    }),
  });
};

/** One first page through ordinary human Query authority, never a scan or a privileged read. */
export const createQueryNoticeQueryResolver = (runner: RecordsTableQueryRunner) => ({
  async resolve(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    context: InstalledRuntimeContext,
    queryId: string,
    settings: Settings,
    inputValues: Readonly<Record<string, JsonValue>>,
  ): Promise<QueryNoticeResolution> {
    try {
      if (
        !sameId(selection.organizationId, context.organizationId) ||
        selection.applicationRootId === undefined ||
        !sameId(selection.applicationRootId, context.applicationRootId)
      ) return REFUSED;
      const binding = buildQueryNoticeQueryBinding(context, queryId, settings, inputValues);
      if (binding === undefined) return REFUSED;
      const result = await runner.run(session, selection, binding.command);
      if (result.kind === "temporarily_unavailable") return ERROR;
      if (result.kind !== "available") return REFUSED;
      const parsed = protectedQueryPageSchema.safeParse(result.value);
      if (!parsed.success) return REFUSED;
      const page = parsed.data;
      const requested = new Set(binding.command.requestedFieldIds.map((id) => id.toLowerCase()));
      if (
        !sameId(page.moduleRootId, binding.command.moduleRootId) ||
        !sameId(page.queryId, binding.command.queryId) ||
        page.moduleReleaseVersion !== binding.moduleReleaseVersion ||
        page.rows.length > binding.command.pageSize ||
        new Set(page.rows.map((row) => row.recordId.toLowerCase())).size !== page.rows.length ||
        page.rows.some((row) =>
          Object.keys(row.values).some((id) => !requested.has(id.toLowerCase())) ||
          new Set(Object.keys(row.values).map((id) => id.toLowerCase())).size !== Object.keys(row.values).length ||
          Object.keys(row.systemValues ?? {}).length !== 0,
        )
      ) return REFUSED;
      const mapping = binding.mapping;
      const items: ProjectedQueryNotice[] = [];
      for (const row of page.rows) {
        const value = (id: string | undefined): JsonValue | undefined => id === undefined
          ? undefined
          : Object.entries(row.values).find(([key]) => sameId(key, id))?.[1];
        const message = value(mapping.message);
        const severity = mapping.severity === undefined ? mapping.defaultSeverity : value(mapping.severity);
        // Hidden/null or unsupported required content never borrows an authored fallback.
        if (typeof message !== "string" || !isSeverity(severity)) continue;
        const title = value(mapping.title);
        const linkLabel = value(mapping.linkLabel);
        const linkHref = value(mapping.linkHref);
        items.push(Object.freeze({
          recordId: row.recordId,
          revision: row.revision,
          message,
          severity,
          ...(typeof title === "string" ? { title } : {}),
          ...(typeof linkLabel === "string" && typeof linkHref === "string"
            ? { link: Object.freeze({ label: linkLabel, href: linkHref }) }
            : {}),
        }));
      }
      return Object.freeze({
        status: "ready",
        values: Object.freeze({
          kind: "query_notice",
          items: Object.freeze(items),
          truncated: page.nextContinuationToken !== undefined,
        }),
      });
    } catch {
      return ERROR;
    }
  },
});
