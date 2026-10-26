import "server-only";

import {
  requireInstalledRuntimeContext,
  type InstalledRuntimeContext,
} from "../definition/installed-runtime-context";
import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import { safeHttpsUrlSchema, type JsonValue } from "../catalogue/common";
import { builderKeySchema } from "../catalogue/identifiers";
import { describeFailure, sameId } from "../catalogue/runtime-primitives";
import { validateComponentSettings } from "../definition/application-composition/block-property-schema";
import type { BlockPropertyValueContract } from "../definition/application-composition/block-property-values";
import {
  viewerSafeRecordLinkIdentitySchema,
  viewerSafeRecordLinkResultSchema,
  type ViewerSafeRecordLinkIdentity,
  type ViewerSafeRecordLinkResult,
} from "../records/record-links";
import {
  projectedLinkTilesSchema,
  type ProjectedLinkTileTarget,
  type ProjectedLinkTiles,
} from "./application-page-link-tiles";
import {
  applicationPageLinkResultSchema,
  applicationPageLinkSelectorSchema,
  type ApplicationPageLinkSelector,
  type ApplicationPageLinkResult,
} from "./application-page-links";
import { LINK_TILES_BLOCK_RELEASE } from "../definition/application-composition-catalogue";
import {
  protectedQueryCommandSchema,
  protectedQueryPageSchema,
  type ProtectedQueryCommand,
} from "../queries/protected-query-contracts";
import type { RecordsTableQueryRunner } from "./records-table-query";

type Settings = Readonly<Record<string, BlockPropertyValueContract>>;
export type LinkTilesQueryResolution =
  | Readonly<{ status: "ready"; values: ProjectedLinkTiles }>
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
  pinFields: Readonly<Record<PinField, string>>;
  applicationFields: Readonly<{ application_key: string; page_key: string }>;
}>;

const pinFields = [
  "target_kind",
  "open_behaviour",
  "organization_id",
  "application_root_id",
  "module_root_id",
  "module_release_revision",
  "record_type_id",
  "storage_contract_id",
  "record_id",
] as const;
type PinField = (typeof pinFields)[number];
type ProtectedRecordLinkReader = (
  session: IdentitySession,
  identities: readonly ViewerSafeRecordLinkIdentity[],
) => Promise<readonly ViewerSafeRecordLinkResult[]>;

type ProtectedApplicationPageLinkReader = (
  session: IdentitySession,
  selectors: readonly ApplicationPageLinkSelector[],
) => Promise<readonly ApplicationPageLinkResult[]>;

const REFUSED = Object.freeze({ status: "refused", reason: "not_permitted" } as const);
const ERROR = Object.freeze({ status: "error" } as const);

const projectionError = (stage: string, cause: unknown): typeof ERROR => {
  console.error(
    `[page] link tile target projection failed: stage=${stage} cause=${describeFailure(cause)}`,
  );
  return ERROR;
};
const refusedBecause = (code: string): typeof REFUSED => {
  console.error(`[page] link tile query refused LINK_TILES_${code}`);
  return REFUSED;
};

const cellKey = (settings: Settings, property: string): string | undefined => {
  const value = Object.hasOwn(settings, property) ? settings[property] : undefined;
  if (value?.kind !== "text") return undefined;
  const parsed = builderKeySchema.safeParse(value.value);
  return parsed.success ? parsed.data : undefined;
};

/** The display columns (label, address, description) mapped to selected fields of one exact installed ordinary Query. */
type SourceBinding = Omit<LinkTilesQueryBinding, "pinFields" | "applicationFields">;

const buildSourceBinding = (
  candidateContext: InstalledRuntimeContext,
  queryId: string,
  settings: Settings,
  inputValues: Readonly<Record<string, JsonValue>>,
): SourceBinding | undefined => {
  let context: InstalledRuntimeContext;
  try {
    context = requireInstalledRuntimeContext(candidateContext);
  } catch (error) {
    console.error(
      `[page] link tile binding refused LINK_TILES_CONTEXT_NOT_INSTALLED: ${describeFailure(error)}`,
    );
    return undefined;
  }
  const matches = context.releaseSet.modules.flatMap((module) =>
    module.content.queries.flatMap((query) =>
      sameId(query.queryId, queryId) ? [{ module, query }] : [],
    ),
  );
  const bound = matches[0];
  if (matches.length !== 1 || bound === undefined) return undefined;
  const query = bound.query;
  const target = query.recordType;
  if (
    target.state !== "resolved" ||
    query.groupByFieldIds.length !== 0 ||
    query.aggregates.length !== 0
  )
    return undefined;
  const targetModules = context.releaseSet.modules.filter((module) =>
    sameId(module.rootId, target.moduleRootId),
  );
  if (targetModules.length !== 1) return undefined;
  const records = targetModules.flatMap((module) =>
    module.content.recordTypes.filter((record) => sameId(record.recordTypeId, target.recordTypeId)),
  );
  const record = records[0];
  if (records.length !== 1 || record === undefined) return undefined;
  if (
    new Set(record.fields.map((field) => field.fieldId.toLowerCase())).size !==
      record.fields.length ||
    new Set(record.fields.map((field) => field.key)).size !== record.fields.length
  )
    return undefined;
  const labelKey = cellKey(settings, "label_key");
  const addressKey = cellKey(settings, "address_key");
  const descriptionKey = cellKey(settings, "description_key");
  if (
    labelKey === undefined ||
    addressKey === undefined ||
    descriptionKey === undefined ||
    new Set([labelKey, addressKey, descriptionKey]).size !== 3
  )
    return undefined;
  const label = record.fields.find((field) => field.key === labelKey);
  const address = record.fields.find((field) => field.key === addressKey);
  const description = record.fields.find((field) => field.key === descriptionKey);
  if (
    label === undefined ||
    (label.type !== "text" && label.type !== "long_text") ||
    address === undefined ||
    address.type !== "web_address" ||
    (Object.hasOwn(settings, "description_key") && description === undefined) ||
    (description !== undefined && description.type !== "text" && description.type !== "long_text")
  )
    return undefined;
  const fields = [label, address, ...(description === undefined ? [] : [description])];
  const selected = new Set(query.selectedFieldIds.map((id) => id.toLowerCase()));
  if (
    fields.some((field) => !selected.has(field.fieldId.toLowerCase())) ||
    Object.keys(inputValues).some((key) => !query.inputs.some((input) => input.key === key))
  )
    return undefined;
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
      ...(description === undefined
        ? {}
        : {
            description: Object.freeze({ key: descriptionKey, fieldId: description.fieldId }),
          }),
    }),
  });
};

/** Completes a bounded read through current human Query authority; never returns partial rows. */
export const createLinkTilesQueryResolver = (
  runner: RecordsTableQueryRunner,
  readRecordLink?: ProtectedRecordLinkReader,
  readApplicationPageLink?: ProtectedApplicationPageLinkReader,
) => ({
  resolve: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    candidateContext: InstalledRuntimeContext,
    queryId: string,
    settings: Settings,
    inputValues: Readonly<Record<string, JsonValue>>,
  ): Promise<LinkTilesQueryResolution> =>
    resolveLinkTiles(
      runner,
      readRecordLink,
      readApplicationPageLink,
      session,
      selection,
      candidateContext,
      queryId,
      settings,
      inputValues,
    ),
});

/** The one binding: explicit unique selected keys for the display columns and every target column. */
export function buildLinkTilesQueryBinding(
  candidateContext: InstalledRuntimeContext,
  queryId: string,
  settings: Settings,
  inputValues: Readonly<Record<string, JsonValue>>,
): LinkTilesQueryBinding | undefined {
  let context: InstalledRuntimeContext;
  try {
    context = requireInstalledRuntimeContext(candidateContext);
  } catch (error) {
    console.error(
      `[page] link tile binding refused LINK_TILES_CONTEXT_NOT_INSTALLED: ${describeFailure(error)}`,
    );
    return undefined;
  }
  if (validateComponentSettings(settings, LINK_TILES_BLOCK_RELEASE.properties).length !== 0)
    return undefined;
  const base = buildSourceBinding(context, queryId, settings, inputValues);
  if (base === undefined) return undefined;
  const queries = context.releaseSet.modules.flatMap((module) =>
    module.content.queries.filter(
      (query) => sameId(module.rootId, base.command.moduleRootId) && sameId(query.queryId, queryId),
    ),
  );
  const query = queries[0];
  if (queries.length !== 1 || query === undefined || query.recordType.state !== "resolved")
    return undefined;
  const sourceModuleRootId = query.recordType.moduleRootId;
  const records = context.releaseSet.modules
    .filter((module) => sameId(module.rootId, sourceModuleRootId))
    .flatMap((module) =>
      module.content.recordTypes.filter((record) => sameId(record.recordTypeId, base.recordTypeId)),
    );
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
      const required =
        name === "target_kind"
          ? ["record", "external", "application", "page"]
          : ["replace", "new_page"];
      if (
        required.some((value) => !field.settings.options.some((option) => option.value === value))
      )
        return undefined;
    } else if (name === "module_release_revision") {
      if (field.type !== "whole_number") return undefined;
    } else if (field.type !== "text") return undefined;
    mapping[name] = field.fieldId;
  }
  const {
    target_kind,
    open_behaviour,
    organization_id,
    application_root_id,
    module_root_id,
    module_release_revision,
    record_type_id,
    storage_contract_id,
    record_id,
  } = mapping;
  if (
    target_kind === undefined ||
    open_behaviour === undefined ||
    organization_id === undefined ||
    application_root_id === undefined ||
    module_root_id === undefined ||
    module_release_revision === undefined ||
    record_type_id === undefined ||
    storage_contract_id === undefined ||
    record_id === undefined
  )
    return undefined;
  const completed: Record<PinField, string> = {
    target_kind,
    open_behaviour,
    organization_id,
    application_root_id,
    module_root_id,
    module_release_revision,
    record_type_id,
    storage_contract_id,
    record_id,
  };
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
  const applicationFields = { application_key: mapped.application_key, page_key: mapped.page_key };
  const fieldIds = [
    ...base.command.requestedFieldIds,
    ...Object.values(completed),
    ...Object.values(applicationFields),
  ];
  if (new Set(fieldIds.map((id) => id.toLowerCase())).size !== fieldIds.length) return undefined;
  const command = protectedQueryCommandSchema.safeParse({
    ...base.command,
    requestedFieldIds: fieldIds,
  });
  return command.success
    ? Object.freeze({
        ...base,
        command: command.data,
        pinFields: Object.freeze(completed),
        applicationFields: Object.freeze(applicationFields),
      })
    : undefined;
}

/** Finish the source Query before any target read, so a refused continuation cannot leak partial targets. */
async function resolveLinkTiles(
  runner: RecordsTableQueryRunner,
  readRecordLink: ProtectedRecordLinkReader | undefined,
  readApplicationPageLink: ProtectedApplicationPageLinkReader | undefined,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  candidateContext: InstalledRuntimeContext,
  queryId: string,
  settings: Settings,
  inputValues: Readonly<Record<string, JsonValue>>,
): Promise<LinkTilesQueryResolution> {
  try {
    const context = requireInstalledRuntimeContext(candidateContext);
    if (
      !sameId(selection.organizationId, context.organizationId) ||
      selection.applicationRootId === undefined ||
      !sameId(selection.applicationRootId, context.applicationRootId)
    )
      return refusedBecause("LINK_TILES_SELECTION_NOT_CURRENT_APPLICATION");
    const binding = buildLinkTilesQueryBinding(context, queryId, settings, inputValues);
    if (binding === undefined || readRecordLink === undefined)
      return refusedBecause("LINK_TILES_BINDING_NOT_RESOLVED");
    const requested = new Set(binding.command.requestedFieldIds.map((id) => id.toLowerCase()));
    const records = new Set<string>();
    const sourceRows: ReturnType<typeof protectedQueryPageSchema.parse>["rows"] = [];
    {
      const result = await runner.run(session, selection, binding.command);
      if (result.kind === "temporarily_unavailable") return ERROR;
      if (result.kind !== "available") return refusedBecause("LINK_TILES_QUERY_NOT_AVAILABLE");
      const parsed = protectedQueryPageSchema.safeParse(result.value);
      if (!parsed.success) return refusedBecause("LINK_TILES_PAGE_SHAPE_INVALID");
      const page = parsed.data;
      if (
        !sameId(page.moduleRootId, binding.command.moduleRootId) ||
        !sameId(page.queryId, binding.command.queryId) ||
        page.moduleReleaseVersion !== binding.moduleReleaseVersion ||
        page.rows.length > binding.command.pageSize
      )
        return refusedBecause("LINK_TILES_PAGE_SIZE_EXCEEDED");
      // One page of the query's own page size (at most 200); more is refused, never truncated.
      if (page.nextContinuationToken !== undefined)
        return refusedBecause("LINK_TILES_MORE_THAN_ONE_PAGE");
      for (const row of page.rows) {
        const keys = Object.keys(row.values);
        if (
          records.has(row.recordId.toLowerCase()) ||
          keys.some((id) => !requested.has(id.toLowerCase())) ||
          new Set(keys.map((id) => id.toLowerCase())).size !== keys.length ||
          Object.keys(row.systemValues ?? {}).length !== 0
        )
          return refusedBecause("LINK_TILES_ROW_KEYS_INVALID");
        records.add(row.recordId.toLowerCase());
        sourceRows.push(row);
      }
    }
    type TargetReadReference =
      | Readonly<{
          kind: "application_page";
          key: string;
        }>
      | Readonly<{
          kind: "record";
          key: string;
          identity: ViewerSafeRecordLinkIdentity;
        }>;
    const targetReadsBySource = new Map<string, TargetReadReference>();
    const recordIdentities = new Map<string, ViewerSafeRecordLinkIdentity>();
    const applicationPageSelectors = new Map<string, ApplicationPageLinkSelector>();
    const recordIdentityKey = (identity: ViewerSafeRecordLinkIdentity): string =>
      [
        identity.organizationId,
        identity.applicationRootId,
        identity.moduleRootId,
        identity.moduleReleaseRevision,
        identity.recordTypeId,
        identity.storageContractId,
        identity.recordId,
      ]
        .map((value) => String(value).toLowerCase())
        .join(":");

    for (const source of sourceRows) {
      const value = (id: string | undefined): JsonValue | undefined =>
        id === undefined
          ? undefined
          : Object.entries(source.values).find(([key]) => sameId(key, id))?.[1];
      const fields = binding.pinFields;
      const kind = value(fields.target_kind);
      if (kind !== "record" && kind !== "external" && kind !== "application" && kind !== "page")
        continue;
      const behaviour = value(fields.open_behaviour);
      if (behaviour !== "replace" && behaviour !== "new_page") continue;
      if (kind === "external") continue;
      if (kind === "application" || kind === "page") {
        const mapped = binding.applicationFields;
        const pageKey = value(mapped?.page_key);
        const selector = applicationPageLinkSelectorSchema.safeParse({
          kind,
          applicationKey: value(mapped?.application_key),
          ...(kind === "page"
            ? { pageKey }
            : pageKey === null || pageKey === undefined || pageKey === ""
              ? {}
              : { pageKey }),
        });
        if (!selector.success || readApplicationPageLink === undefined) continue;
        const key = JSON.stringify(selector.data);
        applicationPageSelectors.set(key, selector.data);
        targetReadsBySource.set(source.recordId, {
          kind: "application_page",
          key,
        });
        continue;
      }

      const identity = viewerSafeRecordLinkIdentitySchema.safeParse({
        organizationId: value(fields.organization_id),
        applicationRootId: value(fields.application_root_id),
        moduleRootId: value(fields.module_root_id),
        moduleReleaseRevision: value(fields.module_release_revision),
        recordTypeId: value(fields.record_type_id),
        storageContractId: value(fields.storage_contract_id),
        recordId: value(fields.record_id),
      });
      if (!identity.success || !sameId(identity.data.organizationId, context.organizationId))
        continue;
      const key = recordIdentityKey(identity.data);
      recordIdentities.set(key, identity.data);
      targetReadsBySource.set(source.recordId, { kind: "record", key, identity: identity.data });
    }

    const recordReads = new Map<string, ViewerSafeRecordLinkResult>();
    const applicationPageReads = new Map<string, ApplicationPageLinkResult>();
    try {
      const recordBatch = [...recordIdentities.entries()];
      const applicationPageBatch = [...applicationPageSelectors.entries()];
      const [recordResults, applicationPageResults] = await Promise.all([
        recordBatch.length === 0
          ? Promise.resolve([] as readonly ViewerSafeRecordLinkResult[])
          : readRecordLink(
              session,
              recordBatch.map(([, identity]) => identity),
            ),
        applicationPageBatch.length === 0 || readApplicationPageLink === undefined
          ? Promise.resolve([] as readonly ApplicationPageLinkResult[])
          : readApplicationPageLink(
              session,
              applicationPageBatch.map(([, selector]) => selector),
            ),
      ]);
      if (
        !Array.isArray(recordResults) ||
        recordResults.length !== recordBatch.length ||
        !Array.isArray(applicationPageResults) ||
        applicationPageResults.length !== applicationPageBatch.length
      )
        throw new Error("LINK_TILE_TARGET_BATCH_RESULT_COUNT_MISMATCH");

      for (const [index, [key, identity]] of recordBatch.entries()) {
        const parsed = viewerSafeRecordLinkResultSchema.safeParse(recordResults[index]);
        if (!parsed.success) return projectionError("record_target_result_invalid", parsed.error);
        if (
          parsed.data.outcome === "available" &&
          (!sameId(parsed.data.detailAddress.applicationRootId, identity.applicationRootId) ||
            !sameId(parsed.data.detailAddress.recordId, identity.recordId))
        )
          return projectionError(
            "record_target_identity_mismatch",
            new Error("LINK_TILE_RECORD_TARGET_IDENTITY_MISMATCH"),
          );
        recordReads.set(key, parsed.data);
      }

      for (const [index, [key, selector]] of applicationPageBatch.entries()) {
        const parsed = applicationPageLinkResultSchema.safeParse(applicationPageResults[index]);
        if (!parsed.success)
          return projectionError("application_target_result_invalid", parsed.error);
        if (
          parsed.data.availability === "available" &&
          (parsed.data.kind !== selector.kind ||
            parsed.data.applicationKey !== selector.applicationKey ||
            !sameId(parsed.data.organizationId, context.organizationId) ||
            (selector.kind === "page" && parsed.data.pageKey !== selector.pageKey))
        )
          return projectionError(
            "application_target_identity_mismatch",
            new Error("LINK_TILE_TARGET_IDENTITY_MISMATCH"),
          );
        applicationPageReads.set(key, parsed.data);
      }
    } catch (error) {
      return projectionError("target_batch_reader_failed", error);
    }

    const rows: ProjectedLinkTiles["rows"] = [];
    for (const source of sourceRows) {
      const value = (id: string | undefined): JsonValue | undefined =>
        id === undefined
          ? undefined
          : Object.entries(source.values).find(([key]) => sameId(key, id))?.[1];
      const fields = binding.pinFields;
      const kind = value(fields.target_kind);
      // Other declared target kinds retain their prior unrendered residual outcome.
      if (kind !== "record" && kind !== "external" && kind !== "application" && kind !== "page")
        continue;
      const behaviour = value(fields.open_behaviour);
      let target: ProjectedLinkTileTarget = { kind: "unavailable" };
      if (behaviour === "replace" || behaviour === "new_page") {
        if (kind === "external") {
          const address = safeHttpsUrlSchema.safeParse(value(binding.mapping.address.fieldId));
          const label = value(binding.mapping.label.fieldId);
          const description = value(binding.mapping.description?.fieldId);
          if (
            address.success &&
            (label === undefined || label === null || typeof label === "string") &&
            (description === undefined || description === null || typeof description === "string")
          )
            target = {
              kind: "external",
              address: address.data,
              label: typeof label === "string" && label.trim() !== "" ? label : address.data,
              ...(typeof description === "string" ? { description } : {}),
              openBehaviour: behaviour,
            };
        } else if (kind === "application" || kind === "page") {
          const reference = targetReadsBySource.get(source.recordId);
          const result =
            reference?.kind === "application_page"
              ? applicationPageReads.get(reference.key)
              : undefined;
          if (result === undefined && reference?.kind === "application_page")
            return projectionError(
              "application_target_batch_result_missing",
              new Error("LINK_TILE_TARGET_BATCH_RESULT_MISSING"),
            );
          if (result?.availability === "available")
            target = { ...result, openBehaviour: behaviour };
        } else {
          const reference = targetReadsBySource.get(source.recordId);
          const result = reference?.kind === "record" ? recordReads.get(reference.key) : undefined;
          if (result === undefined && reference?.kind === "record")
            return projectionError(
              "record_target_batch_result_missing",
              new Error("LINK_TILE_TARGET_BATCH_RESULT_MISSING"),
            );
          if (
            result?.outcome === "available" &&
            reference?.kind === "record" &&
            sameId(result.detailAddress.applicationRootId, reference.identity.applicationRootId) &&
            sameId(result.detailAddress.recordId, reference.identity.recordId)
          )
            target = {
              kind: "record",
              title: result.title,
              detailAddress: result.detailAddress,
              openBehaviour: behaviour,
              association: {
                organizationId: reference.identity.organizationId,
                applicationRootId: result.detailAddress.applicationRootId,
                applicationKey: result.detailAddress.applicationKey,
                recordTypeId: reference.identity.recordTypeId,
                recordId: reference.identity.recordId,
              },
            };
        }
      }
      rows.push({ sourceRecordId: source.recordId, sourceRevision: source.revision, target });
    }
    const payload = projectedLinkTilesSchema.safeParse({ kind: "link_tiles", rows });
    return payload.success
      ? { status: "ready", values: payload.data }
      : projectionError("projected_tiles_result_invalid", payload.error);
  } catch (error) {
    return projectionError("projection", error);
  }
}
