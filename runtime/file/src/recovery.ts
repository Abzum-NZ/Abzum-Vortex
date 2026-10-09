import "server-only";

type RecordRestoreCascadeTransaction = Readonly<{
  query: <Row extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>>(
    strings: TemplateStringsArray,
    ...values: readonly (string | number | boolean | Date | Uint8Array | null)[]
  ) => Promise<readonly Row[]>;
}>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Settles retained File restores proved by the pending HUMAN Record lifecycle receipt. */
export const applyRecordOwnedFileRestoreCascade = async (
  transaction: RecordRestoreCascadeTransaction,
  commandId: string,
): Promise<void> => {
  const rows = await transaction.query<{ readonly result: unknown }>`
    select vortex_file.apply_record_owned_file_restore_cascade_internal(
      ${commandId}::uuid
    ) as result
  `;
  const result = rows[0]?.result;
  if (
    rows.length !== 1 ||
    !isPlainObject(result) ||
    Object.keys(result).length !== 1 ||
    result.outcome !== "settled"
  )
    throw new Error("RECORD_LIFECYCLE_RESULT_INVALID");
};
