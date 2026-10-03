import "server-only";

import { requireInstalledRuntimeContext, type InstalledRuntimeContext } from "@vortex/app";
import {
  LINK_TILES_BLOCK_RELEASE,
  builderKeySchema,
  safeHttpsUrlSchema,
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
  type ProtectedQueryRowCapabilities,
} from "@vortex/query";
import type { RecordsTableQueryRunner } from "./records-table-query";

type Settings = Readonly<Record<string, BlockPropertyValueV2Contract>>;
type TextCell = Readonly<{ kind: "text"; text: string }>;
type LinkCell = Readonly<{ kind: "link"; address: string; label: string }>;
type LinkRow = Readonly<{
  recordId: string;
  revision: number;
  capabilities: ProtectedQueryRowCapabilities;
  cells: Readonly<Record<string, TextCell | LinkCell>>;
}>;
export type ProjectedLinkTilesValues = Readonly<{
  kind: "list";
  headingKey: string;
  secondaryKey?: string;
  rows: readonly LinkRow[];
}>;
export type LinkTilesQueryResolution =
  | Readonly<{ status: "ready"; values: ProjectedLinkTilesValues }>
  | Readonly<{ status: "refused"; reason: "not_permitted" }>
  | Readonly<{ status: "error" }>;
export type LinkTilesQueryBinding = Readonly<{
  command: ProtectedQueryCommand;
  moduleReleaseVersion: string;
  recordTypeId: string;
  mapping: Readonly<{
    label: Readonly<{ key: string; fieldId: string }>;
    address: Readonly<{ key: string; fieldId: string }>;
    description?: Readonly<{ key: string; fieldId: string }>;
  }>;
}>;

const REFUSED = Object.freeze({ status: "refused", reason: "not_permitted" } as const);
const ERROR = Object.freeze({ status: "error" } as const);
const maximumPages = 50;
const maximumRows = 10_000;

const cellKey = (settings: Settings, property: string, fallback: string): string | undefined => {
  const value = Object.hasOwn(settings, property) ? settings[property] : undefined;
  if (value !== undefined && value.kind !== "text") return undefined;
  const parsed = builderKeySchema.safeParse(value?.kind === "text" ? value.value : fallback);
  return parsed.success ? parsed.data : undefined;
};

/** Maps declared cell keys to selected fields of one exact installed ordinary Query. */
export const buildLinkTilesQueryBinding = (
  candidateContext: InstalledRuntimeContext,
  queryId: string,
  settings: Settings,
  inputValues: Readonly<Record<string, JsonValue>>,
): LinkTilesQueryBinding | undefined => {
  let context: InstalledRuntimeContext;
  try {
    context = requireInstalledRuntimeContext(candidateContext);
  } catch {
    return undefined;
  }
  if (validateComponentSettings(settings, LINK_TILES_BLOCK_RELEASE.properties).length !== 0)
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
  const targetModules = context.releaseSet.modules.filter((module) =>
    sameId(module.rootId, target.moduleRootId),
  );
  if (targetModules.length !== 1) return undefined;
  const records = targetModules.flatMap((module) => module.content.recordTypes.filter((record) =>
    sameId(record.recordTypeId, target.recordTypeId),
  ));
  const record = records[0];
  if (records.length !== 1 || record === undefined) return undefined;
  if (
    new Set(record.fields.map((field) => field.fieldId.toLowerCase())).size !== record.fields.length ||
    new Set(record.fields.map((field) => field.key)).size !== record.fields.length
  ) return undefined;
  const labelKey = cellKey(settings, "label_key", "label");
  const addressKey = cellKey(settings, "address_key", "address");
  const descriptionKey = cellKey(settings, "description_key", "description");
  if (
    labelKey === undefined || addressKey === undefined || descriptionKey === undefined ||
    new Set([labelKey, addressKey, descriptionKey]).size !== 3
  ) return undefined;
  const label = record.fields.find((field) => field.key === labelKey);
  const address = record.fields.find((field) => field.key === addressKey);
  const description = record.fields.find((field) => field.key === descriptionKey);
  if (
    label === undefined || (label.type !== "text" && label.type !== "long_text") ||
    address === undefined || address.type !== "web_address" ||
    (Object.hasOwn(settings, "description_key") && description === undefined) ||
    (description !== undefined && description.type !== "text" && description.type !== "long_text")
  ) return undefined;
  const fields = [label, address, ...(description === undefined ? [] : [description])];
  const selected = new Set(query.selectedFieldIds.map((id) => id.toLowerCase()));
  if (
    fields.some((field) => !selected.has(field.fieldId.toLowerCase())) ||
    Object.keys(inputValues).some((key) => !query.inputs.some((input) => input.key === key))
  ) return undefined;
  const command = protectedQueryCommandSchema.safeParse({
    moduleRootId: bound.module.rootId,
    queryId: query.queryId,
    inputValues,
    requestedFieldIds: fields.map((field) => field.fieldId.toLowerCase()),
    requestedSystemFieldKeys: [],
    sort: [],
    sortableFieldIds: [],
    filterableFieldIds: [],
    searchableFieldIds: [],
    pageSize: query.pageSize,
  });
  if (!command.success) return undefined;
  return Object.freeze({
    command: command.data,
    moduleReleaseVersion: bound.module.releaseVersion,
    recordTypeId: record.recordTypeId,
    mapping: Object.freeze({
      label: Object.freeze({ key: labelKey, fieldId: label.fieldId }),
      address: Object.freeze({ key: addressKey, fieldId: address.fieldId }),
      ...(description === undefined ? {} : {
        description: Object.freeze({ key: descriptionKey, fieldId: description.fieldId }),
      }),
    }),
  });
};

/** Completes a bounded read through current human Query authority; never returns partial rows. */
export const createLinkTilesQueryResolver = (runner: RecordsTableQueryRunner) => ({
  async resolve(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    candidateContext: InstalledRuntimeContext,
    queryId: string,
    settings: Settings,
    inputValues: Readonly<Record<string, JsonValue>>,
  ): Promise<LinkTilesQueryResolution> {
    let context: InstalledRuntimeContext;
    try {
      context = requireInstalledRuntimeContext(candidateContext);
    } catch {
      return REFUSED;
    }
    try {
      if (
        !sameId(selection.organizationId, context.organizationId) ||
        selection.applicationRootId === undefined ||
        !sameId(selection.applicationRootId, context.applicationRootId)
      ) return REFUSED;
      const binding = buildLinkTilesQueryBinding(context, queryId, settings, inputValues);
      if (binding === undefined) return REFUSED;
      const requested = new Set(binding.command.requestedFieldIds.map((id) => id.toLowerCase()));
      const records = new Set<string>();
      const cursors = new Set<string>();
      const rows: LinkRow[] = [];
      let rowCount = 0;
      let command = binding.command;
      for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
        const result = await runner.run(session, selection, command);
        if (result.kind === "temporarily_unavailable") return ERROR;
        if (result.kind !== "available") return REFUSED;
        const parsed = protectedQueryPageSchema.safeParse(result.value);
        if (!parsed.success) return REFUSED;
        const page = parsed.data;
        rowCount += page.rows.length;
        if (
          !sameId(page.moduleRootId, binding.command.moduleRootId) ||
          !sameId(page.queryId, binding.command.queryId) ||
          page.moduleReleaseVersion !== binding.moduleReleaseVersion ||
          page.rows.length > binding.command.pageSize || rowCount > maximumRows
        ) return REFUSED;
        for (const row of page.rows) {
          const recordId = row.recordId.toLowerCase();
          const keys = Object.keys(row.values);
          if (
            records.has(recordId) ||
            keys.some((id) => !requested.has(id.toLowerCase())) ||
            new Set(keys.map((id) => id.toLowerCase())).size !== keys.length ||
            Object.keys(row.systemValues ?? {}).length !== 0
          ) return REFUSED;
          records.add(recordId);
          const value = (id: string | undefined): JsonValue | undefined => id === undefined
            ? undefined
            : Object.entries(row.values).find(([key]) => sameId(key, id))?.[1];
          const address = value(binding.mapping.address.fieldId);
          // Withheld or null addresses expose neither a tile nor its record metadata.
          if (address === undefined || address === null) continue;
          const safeAddress = safeHttpsUrlSchema.safeParse(address);
          if (!safeAddress.success) return REFUSED;
          const label = value(binding.mapping.label.fieldId);
          const description = value(binding.mapping.description?.fieldId);
          if (
            (label !== undefined && label !== null && typeof label !== "string") ||
            (description !== undefined && description !== null && typeof description !== "string")
          ) return REFUSED;
          const cells: Record<string, TextCell | LinkCell> = {
            [binding.mapping.address.key]: Object.freeze({
              kind: "link",
              address: safeAddress.data,
              label: typeof label === "string" && label.trim() !== "" ? label : safeAddress.data,
            }),
          };
          if (typeof label === "string")
            cells[binding.mapping.label.key] = Object.freeze({ kind: "text", text: label });
          if (typeof description === "string" && binding.mapping.description !== undefined)
            cells[binding.mapping.description.key] = Object.freeze({ kind: "text", text: description });
          rows.push(Object.freeze({
            recordId: row.recordId,
            revision: row.revision,
            capabilities: row.capabilities,
            cells: Object.freeze(cells),
          }));
        }
        const next = page.nextContinuationToken;
        if (next === undefined) return Object.freeze({
          status: "ready",
          values: Object.freeze({
            kind: "list",
            headingKey: binding.mapping.label.key,
            ...(binding.mapping.description === undefined ? {} : {
              secondaryKey: binding.mapping.description.key,
            }),
            rows: Object.freeze(rows),
          }),
        });
        if (next.trim() === "" || cursors.has(next) || pageIndex + 1 === maximumPages)
          return REFUSED;
        cursors.add(next);
        const continuation = protectedQueryCommandSchema.safeParse({ ...binding.command, continuationToken: next });
        if (!continuation.success) return REFUSED;
        command = continuation.data;
      }
      return REFUSED;
    } catch {
      return ERROR;
    }
  },
});
