import "server-only";

import { isDeepStrictEqual } from "node:util";
import {
  recordTypeDefinitionSchema,
  type ApplicationRootId,
  type IdentitySession,
  type JsonValue,
  type OrganizationId,
  type RecordTypeDefinition,
} from "../schema";
import type { createHumanOrganizationRequestService } from "../access/index";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import { evaluateRecordCalculations } from "./calculations";
import { operationClock } from "./field-candidate";
import { prepareInitialRecordFieldCandidate } from "./field-values";
import { readOrganizationRuntimeSettings } from "./save-record";
import { evaluateRecordTotals } from "./totals";

type Row = DatabaseRow & { readonly backfill: unknown };

type BackfillPage = Readonly<{
  recordType: unknown;
  fieldIds: readonly string[];
  sources: readonly Readonly<{ relationshipId: string; sourceRecordType: unknown }>[];
  records: readonly Readonly<{
    recordId: string;
    concurrencyNumber: number;
    values: Readonly<Record<string, unknown>>;
  }>[];
  /** Each total's related records, by relationship and then by the related-to record. */
  related: Readonly<Record<string, Readonly<Record<string, readonly Readonly<{ fieldValues: Readonly<Record<string, unknown>> }>[]>>>>;
}>;

type BackfillWrite = Readonly<{
  recordId: string;
  expectedConcurrencyNumber: number;
  values: Readonly<Record<string, JsonValue | null>>;
}>;

/** The page size the database reads; a shorter page is the last. */
const pageSize = 100;

const one = (rows: readonly Row[]): unknown => {
  if (rows.length !== 1) throw new Error("DERIVED_FIELD_BACKFILL_RESULT_INVALID");
  return rows[0]!.backfill;
};

/**
 * The totals and stored calculations one existing record holds, worked out by the same engines a
 * save uses: its totals from its related records, then its calculations from its values and those
 * totals. Undefined when they can't be worked out, for example a total over mixed currencies.
 */
const workOut = (
  recordType: RecordTypeDefinition,
  sources: readonly Readonly<{ relationshipId: string; sourceRecordType: RecordTypeDefinition }>[],
  related: BackfillPage["related"],
  record: BackfillPage["records"][number],
  clock: Readonly<{ instant: string; organizationLocalDate: string }>,
  organizationCurrency: string | undefined,
): Readonly<Record<string, JsonValue>> | string => {
  const initial = prepareInitialRecordFieldCandidate({
    operation: "update",
    recordType,
    submittedValues: {},
    existingValues: record.values,
    ...(organizationCurrency === undefined ? {} : { organizationCurrency }),
  });
  if (!initial.success) return initial.issues.map((issue) => issue.code).join(", ");
  const values: Record<string, JsonValue> = { ...initial.candidate.candidateValues };
  const totals = evaluateRecordTotals({
    recordType,
    relationshipSources: sources.map((source) => ({
      relationshipId: source.relationshipId,
      sourceRecordType: source.sourceRecordType,
      records: related[source.relationshipId.toLowerCase()]?.[record.recordId.toLowerCase()] ?? [],
    })),
  });
  if (!totals.success) return totals.issues.map((issue) => issue.code).join(", ");
  Object.assign(values, totals.setValues);
  for (const fieldId of totals.clearFieldIds) delete values[fieldId];
  const calculations = evaluateRecordCalculations({ recordType, authoritativeFieldValues: values, clock });
  if (!calculations.success) return calculations.issues.map((issue) => issue.code).join(", ");
  Object.assign(values, calculations.setValues);
  for (const fieldId of calculations.clearFieldIds) delete values[fieldId];
  return values;
};

/**
 * Works out the totals and stored calculations that the request's installation has just brought
 * into storage, for every existing record: after an upgrade or installation activates a release,
 * and after a preview is seeded with copies of live records. It is the one backfill of derived
 * fields. The database chooses the record types and fields and locks each page; this applies the
 * engines a save uses and writes back only values that differ. A record whose values can't be
 * worked out keeps them empty, and the cause is logged.
 */
export const backfillDerivedFields = async (
  transaction: RequestDatabaseTransaction,
  issuedAt: string,
): Promise<number> => {
  await transaction.query`set local role vortex_runtime`;
  const listed = one(await transaction.query<Row>`
    select vortex_record.read_derived_field_backfill(null::uuid, null::uuid) as backfill
  `) as { recordTypeIds?: unknown };
  if (!Array.isArray(listed.recordTypeIds)) throw new Error("DERIVED_FIELD_BACKFILL_RESULT_INVALID");
  if (listed.recordTypeIds.length === 0) return 0;
  const settings = await readOrganizationRuntimeSettings(transaction);
  let written = 0;
  for (const recordTypeId of listed.recordTypeIds as string[]) {
    let after: string | null = null;
    for (;;) {
      const page = one(await transaction.query<Row>`
        select vortex_record.read_derived_field_backfill(${recordTypeId}::uuid, ${after}::uuid) as backfill
      `) as BackfillPage;
      if (page.records.length === 0) break;
      const recordType = recordTypeDefinitionSchema.parse(page.recordType);
      const sources = page.sources.map((source) => ({
        relationshipId: source.relationshipId,
        sourceRecordType: recordTypeDefinitionSchema.parse(source.sourceRecordType),
      }));
      const clock = operationClock([recordType], issuedAt, settings?.timeZone);
      if (clock === undefined) throw new Error("DERIVED_FIELD_BACKFILL_CLOCK_UNAVAILABLE");
      const writes: BackfillWrite[] = [];
      for (const record of page.records) {
        const values = workOut(recordType, sources, page.related, record, clock, settings?.currency);
        if (typeof values === "string") {
          console.error(`[record] derived field backfill skipped record ${record.recordId} of ${recordTypeId}: ${values}`);
          continue;
        }
        const changed: Record<string, JsonValue | null> = {};
        for (const fieldId of page.fieldIds) {
          const next = values[fieldId] ?? null;
          if (!isDeepStrictEqual(next, record.values[fieldId] ?? null)) changed[fieldId] = next;
        }
        if (Object.keys(changed).length > 0)
          writes.push({ recordId: record.recordId, expectedConcurrencyNumber: record.concurrencyNumber, values: changed });
      }
      if (writes.length > 0) {
        const applied = one(await transaction.query<Row>`
          select vortex_record.apply_derived_field_backfill(
            ${recordTypeId}::uuid, ${JSON.stringify(writes)}::text::jsonb
          ) as backfill
        `);
        written += Number(applied);
      }
      if (page.records.length < pageSize) break;
      after = page.records[page.records.length - 1]!.recordId;
    }
  }
  return written;
};

/**
 * Works out the derived fields a release brought into storage once an upgrade has activated it,
 * in the upgraded Application's own context. Every upgrade path calls this after its activation
 * commits. The upgrade stands if this fails; the cause is logged.
 */
export const backfillActivatedApplication = async (
  requests: Pick<ReturnType<typeof createHumanOrganizationRequestService>, "runChange">,
  session: IdentitySession,
  target: Readonly<{ organizationId: OrganizationId; applicationRootId: ApplicationRootId }>,
): Promise<void> => {
  const failed = `[record] derived field backfill of application ${target.applicationRootId} failed APPLICATION_RELEASE_DERIVED_FIELD_BACKFILL_FAILED`;
  try {
    const result = await requests.runChange(
      session,
      { organizationId: target.organizationId, applicationRootId: target.applicationRootId },
      (transaction, _scope, issuedAt) => backfillDerivedFields(transaction, issuedAt),
    );
    if (result.kind !== "available") console.error(`${failed}: ${result.kind}`);
  } catch (error) {
    console.error(failed, error);
  }
};
