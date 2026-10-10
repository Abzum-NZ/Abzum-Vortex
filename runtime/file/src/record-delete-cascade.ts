import "server-only";

type RecordDeleteCascadeTransaction = Readonly<{
  query: <Row extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>>(
    strings: TemplateStringsArray,
    ...values: readonly (string | number | boolean | Date | Uint8Array | null)[]
  ) => Promise<readonly Row[]>;
}>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Settles the File half of one already-prepared HUMAN Record deletion. The
 * protected database entry point derives the pending receipt and every owner
 * from the current transaction; this boundary accepts only the command id and
 * never returns File identities or metadata to the Record caller.
 */
export const applyRecordOwnedFileDeleteCascade = async (
  transaction: RecordDeleteCascadeTransaction,
  commandId: string,
): Promise<void> => {
  const rows = await transaction.query<{ readonly result: unknown }>`
    select vortex_file.apply_record_owned_file_delete_cascade_internal(
      ${commandId}::uuid
    ) as result
  `;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row === undefined ||
    !isPlainObject(row.result) ||
    Object.keys(row.result).length !== 1 ||
    row.result.outcome !== "settled"
  ) {
    throw new Error("RECORD_LIFECYCLE_RESULT_INVALID");
  }
};
