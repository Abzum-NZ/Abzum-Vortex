import "server-only";

import { z } from "zod";
import {
  selectedOrganizationScopeSchema,
  type SelectedOrganizationScope,
} from "../access/identity-access";
import { jsonValueSchema } from "../catalogue/common";
import { fieldIdSchema, recordIdSchema, revisionSchema } from "../catalogue/identifiers";
import { sameId } from "../catalogue/runtime-primitives";
import { activeApplicationInstallationEvidenceSchema } from "../files/storage";
import {
  viewerSafeRecordLinkIdentitySchema,
  viewerSafeRecordLinkTitleSchema,
  type ViewerSafeRecordLinkIdentity,
} from "../records/record-links";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import { protectedQueryRowCapabilitiesSchema } from "./protected-query-contracts";

const unavailable = { outcome: "unavailable" } as const;
const contractError = (code: string, cause?: unknown): Error =>
  Object.assign(new Error(code, { cause }), { code });

const viewerSafeRecordLinkReadFieldsCommandSchema = z
  .object({
    identity: viewerSafeRecordLinkIdentitySchema,
    /** The exact Application revision already checked by App's installed-context loader. */
    applicationReleaseRevision: revisionSchema,
    /** Field IDs declared by the trusted caller for the exact installed Module release. */
    fieldIds: z
      .array(fieldIdSchema)
      .min(1)
      .max(20)
      .superRefine((fieldIds, context) => {
        const seen = new Set<string>();
        for (const [index, fieldId] of fieldIds.entries()) {
          const normalizedFieldId = fieldId.toLowerCase();
          if (seen.has(normalizedFieldId))
            context.addIssue({
              code: "custom",
              path: [index],
              message: "Each requested field ID must be unique",
            });
          seen.add(normalizedFieldId);
        }
      }),
  })
  .strict();

const readableRecordSchema = z
  .object({
    outcome: z.literal("allowed"),
    recordId: z.string().uuid(),
    concurrencyNumber: revisionSchema,
    values: z.record(fieldIdSchema, jsonValueSchema),
  })
  .strict();
const refusedRecordSchema = z.object({ outcome: z.literal("refused") }).strict();

type RecordLinkReadRow = DatabaseRow & {
  readonly active_installation: unknown;
  readonly result: unknown;
  readonly capabilities: unknown;
};

const viewerSafeRecordLinkFieldValuesSchema = z
  .record(fieldIdSchema, jsonValueSchema)
  .superRefine((values, context) => {
    const fieldIds = Object.keys(values);
    if (fieldIds.length < 1 || fieldIds.length > 20)
      context.addIssue({
        code: "custom",
        message: "A selected-record read returns between 1 and 20 fields",
      });
    const normalizedFieldIds = fieldIds.map((fieldId) => fieldId.toLowerCase());
    if (new Set(normalizedFieldIds).size !== normalizedFieldIds.length)
      context.addIssue({
        code: "custom",
        message: "A selected-record read returns each field ID once",
      });
  });

export const viewerSafeRecordLinkFieldsReadResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("read"),
      values: viewerSafeRecordLinkFieldValuesSchema,
    })
    .strict(),
  z.object({ outcome: z.literal("unavailable") }).strict(),
]);

export type ViewerSafeRecordLinkFieldsReadResult = z.infer<
  typeof viewerSafeRecordLinkFieldsReadResultSchema
>;

const currentInstallationMatches = (
  candidate: unknown,
  scope: SelectedOrganizationScope,
  identity: ViewerSafeRecordLinkIdentity,
  applicationReleaseRevision: number,
): boolean => {
  const installation = activeApplicationInstallationEvidenceSchema.safeParse(candidate);
  if (!installation.success)
    throw contractError("RECORD_LINK_INSTALLATION_INVALID", installation.error);
  return (
    installation.success &&
    sameId(scope.organizationId, identity.organizationId) &&
    scope.applicationRootId !== undefined &&
    sameId(scope.applicationRootId, identity.applicationRootId) &&
    sameId(installation.data.organizationId, identity.organizationId) &&
    sameId(installation.data.applicationRootId, identity.applicationRootId) &&
    installation.data.applicationReleaseRevision === applicationReleaseRevision &&
    installation.data.moduleBindings.some(
      (binding) =>
        sameId(binding.moduleRootId, identity.moduleRootId) &&
        binding.moduleReleaseRevision === identity.moduleReleaseRevision,
    )
  );
};

/** Run the exact Record read behind the current-installation gate. */
const readProtectedRecord = (
  transaction: RequestDatabaseTransaction,
  identity: ViewerSafeRecordLinkIdentity,
  applicationReleaseRevision: number,
) => transaction.query<RecordLinkReadRow>`
  with active_installation as materialized (
    select vortex_definition.read_current_active_installation() as value
  ), verified_installation as materialized (
    select value
    from active_installation
    where pg_catalog.lower(value ->> 'organizationId') =
        pg_catalog.lower(${identity.organizationId}::text)
      and pg_catalog.lower(value ->> 'applicationRootId') =
        pg_catalog.lower(${identity.applicationRootId}::text)
      and (value ->> 'applicationReleaseRevision')::bigint =
        ${applicationReleaseRevision}::bigint
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements(value -> 'moduleBindings') as binding(value)
        where pg_catalog.lower(binding.value ->> 'moduleRootId') =
            pg_catalog.lower(${identity.moduleRootId}::text)
          and (binding.value ->> 'moduleReleaseRevision')::bigint =
            ${identity.moduleReleaseRevision}::bigint
          and binding.value ->> 'state' = 'active'
      )
  ), current_record as materialized (
    select vortex_record.read_record(
      ${identity.recordTypeId}::uuid,
      ${identity.recordId}::uuid
    ) as value
    from verified_installation
  )
  select
    active_installation.value as active_installation,
    coalesce(current_record.value -> 'record',
      pg_catalog.jsonb_build_object('outcome', 'refused')) as result,
    current_record.value -> 'capabilities' as capabilities
  from active_installation
  left join current_record on true
`;

const viewerSafeRecordValuesReadCommandSchema = z
  .object({
    identity: viewerSafeRecordLinkIdentitySchema,
    /** The exact Application revision already checked by App's installed-context loader. */
    applicationReleaseRevision: revisionSchema,
  })
  .strict();

/** The fields the viewer may read of one record, by field ID; a withheld field is absent. */
export type ViewerSafeRecordValuesReadResult =
  | Readonly<{ outcome: "read"; values: Readonly<Record<string, z.infer<typeof jsonValueSchema>>> }>
  | Readonly<{ outcome: "unavailable" }>;

/**
 * The current protected Record projection of one record behind the exact current-installation
 * gate: the values of the fields the viewer may read, or unavailable for a record the viewer may
 * not read, a foreign record and a missing one alike.
 */
const readValues = async (
  transaction: RequestDatabaseTransaction,
  scopeCandidate: unknown,
  commandCandidate: unknown,
): Promise<ViewerSafeRecordValuesReadResult> => {
  const scope = selectedOrganizationScopeSchema.safeParse(scopeCandidate);
  const command = viewerSafeRecordValuesReadCommandSchema.safeParse(commandCandidate);
  if (!scope.success || !command.success) return unavailable;
  if (
    scope.data.applicationRootId === undefined ||
    !sameId(scope.data.organizationId, command.data.identity.organizationId) ||
    !sameId(scope.data.applicationRootId, command.data.identity.applicationRootId)
  )
    return unavailable;

  const rows = await readProtectedRecord(
    transaction,
    command.data.identity,
    command.data.applicationReleaseRevision,
  );
  if (rows.length !== 1 || rows[0] === undefined)
    throw contractError("RECORD_LINK_READ_ROW_INVALID", rows.length);

  const row = rows[0];
  if (
    !currentInstallationMatches(
      row.active_installation,
      scope.data,
      command.data.identity,
      command.data.applicationReleaseRevision,
    )
  )
    return unavailable;

  if (refusedRecordSchema.safeParse(row.result).success) return unavailable;
  const record = readableRecordSchema.safeParse(row.result);
  const capabilities = protectedQueryRowCapabilitiesSchema.safeParse(row.capabilities);
  if (!record.success) throw contractError("RECORD_LINK_READ_RESULT_INVALID", record.error);
  if (!capabilities.success)
    throw contractError("RECORD_LINK_READ_CAPABILITIES_INVALID", capabilities.error);
  if (!sameId(record.data.recordId, command.data.identity.recordId))
    throw contractError("RECORD_LINK_READ_IDENTITY_INVALID");
  return { outcome: "read", values: record.data.values };
};

/**
 * Reads only the requested values from the current protected Record projection. The trusted
 * caller supplies IDs from the exact installed Module release; Query still validates the list,
 * installation identity and current Record authority before returning any values. The caller
 * must resolve the target and fields from the installed release; these inputs select a read but
 * never grant authority.
 */
const readFields = async (
  transaction: RequestDatabaseTransaction,
  scopeCandidate: unknown,
  commandCandidate: unknown,
): Promise<ViewerSafeRecordLinkFieldsReadResult> => {
  const command = viewerSafeRecordLinkReadFieldsCommandSchema.safeParse(commandCandidate);
  if (!command.success) return unavailable;
  const record = await readValues(transaction, scopeCandidate, {
    identity: command.data.identity,
    applicationReleaseRevision: command.data.applicationReleaseRevision,
  });
  if (record.outcome !== "read") return unavailable;

  const values: Record<string, z.infer<typeof jsonValueSchema>> = {};
  for (const fieldId of command.data.fieldIds) {
    const matchingEntries = Object.entries(record.values).filter(([candidateFieldId]) =>
      sameId(candidateFieldId, fieldId),
    );
    if (matchingEntries.length !== 1) return unavailable;
    const matchingEntry = matchingEntries[0];
    if (matchingEntry === undefined) throw contractError("RECORD_LINK_READ_FIELD_INVALID");
    values[fieldId] = matchingEntry[1];
  }

  return viewerSafeRecordLinkFieldsReadResultSchema.parse({ outcome: "read", values });
};

/** The bounds of one titles read, matching `vortex_record.read_record_titles`. */
export const viewerSafeRecordLinkTitleTypeLimit = 20;
export const viewerSafeRecordLinkTitleRecordLimit = 200;

const viewerSafeRecordLinkTitleTargetSchema = z
  .object({
    identity: viewerSafeRecordLinkIdentitySchema.omit({ recordId: true }),
    titleFieldId: fieldIdSchema,
    /** The linked records of this one record type. */
    recordIds: z.array(recordIdSchema).min(1),
  })
  .strict();

const viewerSafeRecordLinkTitlesCommandSchema = z
  .object({
    /** The exact Application revision already checked by App's installed-context loader. */
    applicationReleaseRevision: revisionSchema,
    /** One entry per target record type; the whole read is a single statement. */
    targets: z
      .array(viewerSafeRecordLinkTitleTargetSchema)
      .min(1)
      .max(viewerSafeRecordLinkTitleTypeLimit),
  })
  .strict()
  .refine(
    (command) =>
      command.targets.reduce((total, target) => total + target.recordIds.length, 0) <=
      viewerSafeRecordLinkTitleRecordLimit,
  );

export type ViewerSafeRecordLinkTitlesCommand = z.input<
  typeof viewerSafeRecordLinkTitlesCommandSchema
>;

type RecordLinkTitlesRow = DatabaseRow & {
  readonly active_installation: unknown;
  readonly record_type_id: string;
  readonly record_id: string;
  readonly result: unknown;
};

/** The key of a linked record's title in a titles read: lower-case record type and record identity. */
export const viewerSafeRecordLinkTitleKey = (recordTypeId: string, recordId: string): string =>
  `${recordTypeId.toLowerCase()}:${recordId.toLowerCase()}`;

/** The titles of the linked records of every requested record type. */
export type ViewerSafeRecordLinkTitlesReadResult =
  | Readonly<{
      outcome: "read";
      /**
       * A record the viewer may read and whose title field is readable, keyed by
       * `viewerSafeRecordLinkTitleKey`; every other record is absent.
       */
      titles: ReadonlyMap<string, z.infer<typeof viewerSafeRecordLinkTitleSchema>>;
    }>
  | Readonly<{ outcome: "unavailable" }>;

/**
 * Reads the configured title of the linked records of every target record type in one statement
 * behind the same exact current-installation gate as the single read, through the same protected
 * Record projection. A record the viewer may not read, or whose title field is withheld, is simply
 * absent from the result, so a caller cannot tell it from a record that does not exist.
 */
const readTitles = async (
  transaction: RequestDatabaseTransaction,
  scopeCandidate: unknown,
  commandCandidate: unknown,
): Promise<ViewerSafeRecordLinkTitlesReadResult> => {
  const scope = selectedOrganizationScopeSchema.safeParse(scopeCandidate);
  const command = viewerSafeRecordLinkTitlesCommandSchema.safeParse(commandCandidate);
  if (!scope.success || !command.success) return unavailable;
  const { applicationReleaseRevision, targets } = command.data;
  const first = targets[0]!;
  const applicationRootId = scope.data.applicationRootId;
  if (
    applicationRootId === undefined ||
    targets.some(
      ({ identity }) =>
        !sameId(scope.data.organizationId, identity.organizationId) ||
        !sameId(applicationRootId, identity.applicationRootId),
    )
  )
    return unavailable;

  const targetsJson = JSON.stringify(
    targets.map(({ identity, titleFieldId, recordIds }) => ({
      moduleRootId: identity.moduleRootId,
      moduleReleaseRevision: identity.moduleReleaseRevision,
      recordTypeId: identity.recordTypeId,
      titleFieldId,
      recordIds,
    })),
  );
  const rows = await transaction.query<RecordLinkTitlesRow>`
    with active_installation as materialized (
      select vortex_definition.read_current_active_installation() as value
    ), requested as materialized (
      select ${targetsJson}::text::jsonb as value
    ), verified_installation as materialized (
      select active_installation.value
      from active_installation
      where pg_catalog.lower(active_installation.value ->> 'organizationId') =
          pg_catalog.lower(${first.identity.organizationId}::text)
        and pg_catalog.lower(active_installation.value ->> 'applicationRootId') =
          pg_catalog.lower(${first.identity.applicationRootId}::text)
        and (active_installation.value ->> 'applicationReleaseRevision')::bigint =
          ${applicationReleaseRevision}::bigint
        and not exists (
          select 1
          from requested
          cross join lateral pg_catalog.jsonb_array_elements(requested.value) as target(value)
          where not exists (
            select 1
            from pg_catalog.jsonb_array_elements(active_installation.value -> 'moduleBindings')
              as binding(value)
            where pg_catalog.lower(binding.value ->> 'moduleRootId') =
                pg_catalog.lower(target.value ->> 'moduleRootId')
              and (binding.value ->> 'moduleReleaseRevision')::bigint =
                (target.value ->> 'moduleReleaseRevision')::bigint
              and binding.value ->> 'state' = 'active'
          )
        )
    ), linked as materialized (
      select (target.value ->> 'recordTypeId')::uuid as record_type_id,
        link.record_id::uuid as record_id
      from requested
      cross join lateral pg_catalog.jsonb_array_elements(requested.value) as target(value)
      cross join lateral pg_catalog.jsonb_array_elements_text(target.value -> 'recordIds')
        as link(record_id)
    ), titles as materialized (
      select title.record_type_id, title.record_id, title.result
      from verified_installation
      cross join lateral vortex_record.read_record_titles((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'recordTypeId', target.value -> 'recordTypeId',
          'titleFieldId', target.value -> 'titleFieldId',
          'recordIds', target.value -> 'recordIds'
        ))
        from requested
        cross join lateral pg_catalog.jsonb_array_elements(requested.value) as target(value)
      )) as title
    )
    select
      active_installation.value as active_installation,
      linked.record_type_id::text as record_type_id,
      linked.record_id::text as record_id,
      titles.result as result
    from active_installation
    cross join linked
    left join titles
      on titles.record_type_id = linked.record_type_id and titles.record_id = linked.record_id
  `;
  const head = rows[0];
  if (head === undefined) throw contractError("RECORD_LINK_READ_ROW_INVALID", rows.length);
  for (const { identity, recordIds } of targets) {
    if (
      !currentInstallationMatches(
        head.active_installation,
        scope.data,
        { ...identity, recordId: recordIds[0]! },
        applicationReleaseRevision,
      )
    )
      return unavailable;
  }

  const titleFieldByType = new Map(
    targets.map((target) => [target.identity.recordTypeId.toLowerCase(), target.titleFieldId]),
  );
  const titles = new Map<string, z.infer<typeof viewerSafeRecordLinkTitleSchema>>();
  for (const row of rows) {
    if (refusedRecordSchema.safeParse(row.result).success) continue;
    const record = readableRecordSchema.safeParse(row.result);
    if (!record.success) throw contractError("RECORD_LINK_READ_RESULT_INVALID", record.error);
    if (!sameId(record.data.recordId, row.record_id))
      throw contractError("RECORD_LINK_READ_IDENTITY_INVALID");
    const titleFieldId = titleFieldByType.get(row.record_type_id.toLowerCase());
    if (titleFieldId === undefined) throw contractError("RECORD_LINK_READ_IDENTITY_INVALID");
    const entries = Object.entries(record.data.values).filter(([fieldId]) =>
      sameId(fieldId, titleFieldId),
    );
    if (entries.length !== 1) continue;
    const title = viewerSafeRecordLinkTitleSchema.safeParse(entries[0]?.[1]);
    if (!title.success) throw contractError("RECORD_LINK_READ_TITLE_INVALID", title.error);
    titles.set(viewerSafeRecordLinkTitleKey(row.record_type_id, row.record_id), title.data);
  }
  return { outcome: "read", titles };
};

/** One uncached protected Query reader for a target record's title, selected fields or readable values. */
export const createViewerSafeRecordLinkReadService = () =>
  Object.freeze({ readFields, readValues, readTitles });

export type ViewerSafeRecordLinkReadService = ReturnType<
  typeof createViewerSafeRecordLinkReadService
>;
