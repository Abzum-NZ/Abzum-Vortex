import "server-only";

import { requireInstalledRuntimeContext, type InstalledRuntimeContext } from "@vortex/app";
import {
  LINK_TILES_BLOCK_RELEASE,
  RECORD_PIN_LINK_TILES_BLOCK_RELEASE,
  APPLICATION_PAGE_LINK_TILES_BLOCK_RELEASE,
  applicationPageLinkResultSchema,
  applicationPageLinkSelectorSchema,
  projectedApplicationPageLinkTilesSchema,
  type ApplicationPageLinkSelector,
  type ApplicationPageLinkResult,
  type ApplicationPageLinkTileTarget,
  type ProjectedApplicationPageLinkTiles,
  projectedRecordPinTilesSchema,
  viewerSafeRecordLinkIdentitySchema,
  viewerSafeRecordLinkResultSchema,
  builderKeySchema,
  safeHttpsUrlSchema,
  sameId,
  validateComponentSettings,
  type BlockPropertyValueV2Contract,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
  type ProjectedRecordPinTiles,
  type ViewerSafeRecordLinkIdentity,
  type ViewerSafeRecordLinkResult,
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
  | Readonly<{ status: "ready"; values: ProjectedLinkTilesValues | ProjectedRecordPinTiles | ProjectedApplicationPageLinkTiles }>
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
  pinFields?: Readonly<Record<PinField, string>>;
  applicationFields?: Readonly<{ application_key: string; page_key: string }>;
}>;

const pinFields = ["target_kind", "open_behaviour", "organization_id", "application_root_id",
  "module_root_id", "module_release_revision", "record_type_id", "storage_contract_id", "record_id"] as const;
type PinField = (typeof pinFields)[number];
type ProtectedRecordLinkReader = (
  session: IdentitySession, identity: ViewerSafeRecordLinkIdentity,
) => Promise<ViewerSafeRecordLinkResult>;

type ProtectedApplicationPageLinkReader = (
  session: IdentitySession, selector: ApplicationPageLinkSelector,
) => Promise<ApplicationPageLinkResult>;

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
  releaseVersion: string = LINK_TILES_BLOCK_RELEASE.releaseVersion,
): LinkTilesQueryBinding | undefined => {
  if (releaseVersion === RECORD_PIN_LINK_TILES_BLOCK_RELEASE.releaseVersion ||
      releaseVersion === APPLICATION_PAGE_LINK_TILES_BLOCK_RELEASE.releaseVersion)
    return buildRecordPinBinding(candidateContext, queryId, settings, inputValues, releaseVersion);
  if (releaseVersion !== LINK_TILES_BLOCK_RELEASE.releaseVersion) return undefined;
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
export const createLinkTilesQueryResolver = (
  runner: RecordsTableQueryRunner, readRecordLink?: ProtectedRecordLinkReader,
  readApplicationPageLink?: ProtectedApplicationPageLinkReader,
) => ({
  async resolve(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    candidateContext: InstalledRuntimeContext,
    queryId: string,
    settings: Settings,
    inputValues: Readonly<Record<string, JsonValue>>,
    releaseVersion: string = LINK_TILES_BLOCK_RELEASE.releaseVersion,
  ): Promise<LinkTilesQueryResolution> {
    if (releaseVersion === RECORD_PIN_LINK_TILES_BLOCK_RELEASE.releaseVersion ||
        releaseVersion === APPLICATION_PAGE_LINK_TILES_BLOCK_RELEASE.releaseVersion)
      return resolveRecordPins(runner, readRecordLink, session, selection, candidateContext,
        queryId, settings, inputValues, releaseVersion, readApplicationPageLink);
    if (releaseVersion !== LINK_TILES_BLOCK_RELEASE.releaseVersion) return REFUSED;
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

/** The fresh release requires explicit unique selected keys; the old mapping remains unchanged. */
function buildRecordPinBinding(
  candidateContext: InstalledRuntimeContext, queryId: string, settings: Settings,
  inputValues: Readonly<Record<string, JsonValue>>,
  releaseVersion: string = RECORD_PIN_LINK_TILES_BLOCK_RELEASE.releaseVersion,
): LinkTilesQueryBinding | undefined {
  let context: InstalledRuntimeContext;
  try { context = requireInstalledRuntimeContext(candidateContext); } catch { return undefined; }
  const appPage = releaseVersion === APPLICATION_PAGE_LINK_TILES_BLOCK_RELEASE.releaseVersion;
  if (!appPage && releaseVersion !== RECORD_PIN_LINK_TILES_BLOCK_RELEASE.releaseVersion) return undefined;
  const release = appPage ? APPLICATION_PAGE_LINK_TILES_BLOCK_RELEASE : RECORD_PIN_LINK_TILES_BLOCK_RELEASE;
  if (validateComponentSettings(settings, release.properties).length !== 0)
    return undefined;
  const externalSettings = Object.fromEntries(Object.entries(settings).filter(([key]) =>
    LINK_TILES_BLOCK_RELEASE.properties.some((property) => property.key === key),
  ));
  const base = buildLinkTilesQueryBinding(context, queryId, externalSettings, inputValues);
  if (base === undefined) return undefined;
  const queries = context.releaseSet.modules.flatMap((module) => module.content.queries.filter((query) =>
    sameId(module.rootId, base.command.moduleRootId) && sameId(query.queryId, queryId),
  ));
  const query = queries[0];
  if (queries.length !== 1 || query === undefined || query.recordType.state !== "resolved") return undefined;
  const sourceModuleRootId = query.recordType.moduleRootId;
  const records = context.releaseSet.modules.filter((module) => sameId(module.rootId, sourceModuleRootId))
    .flatMap((module) => module.content.recordTypes.filter((record) => sameId(record.recordTypeId, base.recordTypeId)));
  const record = records[0];
  if (records.length !== 1 || record === undefined) return undefined;
  const selected = new Set(query.selectedFieldIds.map((id) => id.toLowerCase()));
  const mapping: Partial<Record<PinField, string>> = {};
  for (const name of pinFields) {
    const setting = settings[`${name}_key`];
    const key = setting?.kind === "text" ? builderKeySchema.safeParse(setting.value) : undefined;
    if (key === undefined || !key.success) return undefined;
    const field = record.fields.find((candidate) => candidate.key === key.data);
    if (field === undefined || !selected.has(field.fieldId.toLowerCase())) return undefined;
    if (name === "target_kind" || name === "open_behaviour") {
      if (field.type !== "choice") return undefined;
      const required = name === "target_kind"
        ? appPage ? ["record", "external", "application", "page"] : ["record", "external"]
        : ["replace", "new_page"];
      if (required.some((value) => !field.settings.options.some((option) => option.value === value)))
        return undefined;
    } else if (name === "module_release_revision") {
      if (field.type !== "whole_number") return undefined;
    } else if (field.type !== "text") return undefined;
    mapping[name] = field.fieldId;
  }
  const { target_kind, open_behaviour, organization_id, application_root_id, module_root_id,
    module_release_revision, record_type_id, storage_contract_id, record_id } = mapping;
  if (target_kind === undefined || open_behaviour === undefined || organization_id === undefined ||
      application_root_id === undefined || module_root_id === undefined || module_release_revision === undefined ||
      record_type_id === undefined || storage_contract_id === undefined || record_id === undefined) return undefined;
  const completed: Record<PinField, string> = { target_kind, open_behaviour, organization_id,
    application_root_id, module_root_id, module_release_revision, record_type_id, storage_contract_id, record_id };
  let applicationFields: LinkTilesQueryBinding["applicationFields"];
  if (appPage) {
    const mapped: Partial<Record<"application_key" | "page_key", string>> = {};
    for (const name of ["application_key", "page_key"] as const) {
      const setting = settings[`${name}_key`];
      const key = setting?.kind === "text" ? builderKeySchema.safeParse(setting.value) : undefined;
      if (key?.success !== true) return undefined;
      const field = record.fields.find((candidate) => candidate.key === key.data);
      if (field === undefined || field.type !== "text" || !selected.has(field.fieldId.toLowerCase()))
        return undefined;
      mapped[name] = field.fieldId;
    }
    if (mapped.application_key === undefined || mapped.page_key === undefined) return undefined;
    applicationFields = { application_key: mapped.application_key, page_key: mapped.page_key };
  }
  const fieldIds = [...base.command.requestedFieldIds, ...Object.values(completed),
    ...Object.values(applicationFields ?? {})];
  if (new Set(fieldIds.map((id) => id.toLowerCase())).size !== fieldIds.length) return undefined;
  const command = protectedQueryCommandSchema.safeParse({ ...base.command, requestedFieldIds: fieldIds });
  return command.success ? Object.freeze({ ...base, command: command.data, pinFields: Object.freeze(completed),
    ...(applicationFields === undefined ? {} : { applicationFields: Object.freeze(applicationFields) }),
  }) : undefined;
}

/** Finish the source Query before any target read, so a refused continuation cannot leak partial targets. */
async function resolveRecordPins(
  runner: RecordsTableQueryRunner, readRecordLink: ProtectedRecordLinkReader | undefined,
  session: IdentitySession, selection: OrganizationSelectionCandidate,
  candidateContext: InstalledRuntimeContext, queryId: string, settings: Settings,
  inputValues: Readonly<Record<string, JsonValue>>,
  releaseVersion: string = RECORD_PIN_LINK_TILES_BLOCK_RELEASE.releaseVersion,
  readApplicationPageLink?: ProtectedApplicationPageLinkReader,
): Promise<LinkTilesQueryResolution> {
  try {
    const context = requireInstalledRuntimeContext(candidateContext);
    if (!sameId(selection.organizationId, context.organizationId) ||
        selection.applicationRootId === undefined || !sameId(selection.applicationRootId, context.applicationRootId))
      return REFUSED;
    const appPage = releaseVersion === APPLICATION_PAGE_LINK_TILES_BLOCK_RELEASE.releaseVersion;
    const binding = buildRecordPinBinding(context, queryId, settings, inputValues, releaseVersion);
    if (binding === undefined || binding.pinFields === undefined || readRecordLink === undefined) return REFUSED;
    const requested = new Set(binding.command.requestedFieldIds.map((id) => id.toLowerCase()));
    const records = new Set<string>();
    const cursors = new Set<string>();
    const sourceRows: ReturnType<typeof protectedQueryPageSchema.parse>["rows"] = [];
    let command = binding.command;
    let complete = false;
    for (let index = 0; index < maximumPages; index += 1) {
      const result = await runner.run(session, selection, command);
      if (result.kind === "temporarily_unavailable") return ERROR;
      if (result.kind !== "available") return REFUSED;
      const parsed = protectedQueryPageSchema.safeParse(result.value);
      if (!parsed.success) return REFUSED;
      const page = parsed.data;
      if (!sameId(page.moduleRootId, command.moduleRootId) || !sameId(page.queryId, command.queryId) ||
          page.moduleReleaseVersion !== binding.moduleReleaseVersion || page.rows.length > command.pageSize ||
          sourceRows.length + page.rows.length > maximumRows) return REFUSED;
      for (const row of page.rows) {
        const keys = Object.keys(row.values);
        if (records.has(row.recordId.toLowerCase()) || keys.some((id) => !requested.has(id.toLowerCase())) ||
            new Set(keys.map((id) => id.toLowerCase())).size !== keys.length ||
            Object.keys(row.systemValues ?? {}).length !== 0) return REFUSED;
        records.add(row.recordId.toLowerCase());
        sourceRows.push(row);
      }
      const next = page.nextContinuationToken;
      if (next === undefined) { complete = true; break; }
      if (next.trim() === "" || cursors.has(next) || index + 1 === maximumPages) return REFUSED;
      cursors.add(next);
      const continuation = protectedQueryCommandSchema.safeParse({ ...binding.command, continuationToken: next });
      if (!continuation.success) return REFUSED;
      command = continuation.data;
    }
    if (!complete) return REFUSED;
    const rows: ProjectedApplicationPageLinkTiles["rows"] = [];
    const reads = new Map<string, ViewerSafeRecordLinkResult>();
    for (const source of sourceRows) {
      const value = (id: string | undefined): JsonValue | undefined => id === undefined ? undefined :
        Object.entries(source.values).find(([key]) => sameId(key, id))?.[1];
      const fields = binding.pinFields;
      const kind = value(fields.target_kind);
      // Other declared target kinds retain their prior unrendered residual outcome.
      if (kind !== "record" && kind !== "external" &&
          (!appPage || (kind !== "application" && kind !== "page"))) continue;
      const behaviour = value(fields.open_behaviour);
      let target: ApplicationPageLinkTileTarget = { kind: "unavailable" };
      if (behaviour === "replace" || behaviour === "new_page") {
        if (kind === "external") {
          const address = safeHttpsUrlSchema.safeParse(value(binding.mapping.address.fieldId));
          const label = value(binding.mapping.label.fieldId);
          const description = value(binding.mapping.description?.fieldId);
          if (address.success && (label === undefined || label === null || typeof label === "string") &&
              (description === undefined || description === null || typeof description === "string"))
            target = { kind: "external", address: address.data,
              label: typeof label === "string" && label.trim() !== "" ? label : address.data,
              ...(typeof description === "string" ? { description } : {}), openBehaviour: behaviour };
        } else if (kind === "application" || kind === "page") {
          const mapped = binding.applicationFields;
          const pageKey = value(mapped?.page_key);
          // An Application selector may not silently discard a stored Page selector.
          const selector = applicationPageLinkSelectorSchema.safeParse({
            kind, applicationKey: value(mapped?.application_key),
            ...(kind === "page" ? { pageKey } : pageKey === null || pageKey === undefined || pageKey === ""
              ? {} : { pageKey }),
          });
          if (selector.success && readApplicationPageLink !== undefined) {
            try {
              const read = applicationPageLinkResultSchema.safeParse(
                await readApplicationPageLink(session, selector.data),
              );
              if (read.success && read.data.availability === "available" &&
                  read.data.kind === kind && read.data.applicationKey === selector.data.applicationKey &&
                  sameId(read.data.organizationId, context.organizationId) &&
                  (selector.data.kind !== "page" || read.data.pageKey === selector.data.pageKey))
                target = { ...read.data, openBehaviour: behaviour };
            } catch { /* Every refused or failed target remains the same neutral row. */ }
          }
        } else {
          const identity = viewerSafeRecordLinkIdentitySchema.safeParse({
            organizationId: value(fields.organization_id), applicationRootId: value(fields.application_root_id),
            moduleRootId: value(fields.module_root_id), moduleReleaseRevision: value(fields.module_release_revision),
            recordTypeId: value(fields.record_type_id), storageContractId: value(fields.storage_contract_id),
            recordId: value(fields.record_id),
          });
          if (identity.success && sameId(identity.data.organizationId, context.organizationId)) {
            const cacheKey = JSON.stringify(identity.data);
            let result = reads.get(cacheKey);
            if (result === undefined) {
              try {
                const parsed = viewerSafeRecordLinkResultSchema.safeParse(await readRecordLink(session, identity.data));
                result = parsed.success ? parsed.data : { outcome: "unavailable" };
              } catch { result = { outcome: "unavailable" }; }
              reads.set(cacheKey, result);
            }
            if (result.outcome === "available" &&
                sameId(result.detailAddress.applicationRootId, identity.data.applicationRootId) &&
                sameId(result.detailAddress.recordId, identity.data.recordId))
              target = { kind: "record", title: result.title, detailAddress: result.detailAddress,
                openBehaviour: behaviour, association: {
                  organizationId: identity.data.organizationId, applicationRootId: result.detailAddress.applicationRootId,
                  applicationKey: result.detailAddress.applicationKey, recordTypeId: identity.data.recordTypeId,
                  recordId: identity.data.recordId,
                } };
          }
        }
      }
      rows.push({ sourceRecordId: source.recordId, sourceRevision: source.revision, target });
    }
    const payload = appPage
      ? projectedApplicationPageLinkTilesSchema.safeParse({ kind: "application_page_link_tiles", rows })
      : projectedRecordPinTilesSchema.safeParse({ kind: "record_pin_tiles", rows });
    return payload.success ? { status: "ready", values: payload.data } : REFUSED;
  } catch { return ERROR; }
}
