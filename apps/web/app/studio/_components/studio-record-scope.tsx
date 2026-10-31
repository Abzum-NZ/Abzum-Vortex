"use client";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { StudioReferencePicker } from "@vortex/ui/studio";
import { StudioField } from "./studio-field";

type RecordType = ApplicationSourceDocument["body"]["modules"][number]["record_types"][number];
type RecordScope = NonNullable<
  ApplicationSourceDocument["body"]["modules"][number]["permissions"][number]["record_scope"]
>;

/**
 * The one record-scope control: all records, or owned records when the record type has ownership.
 * A Read or Named permission also offers directly shared records; a standard Create or Update
 * permission does not, because sharing cannot grant either a new record or its changes here.
 * A relationship or saved-condition scope needs its own authoring control and is never flattened.
 */
export function StudioRecordScopeField({
  record,
  scope,
  allowShared,
  disabled,
  hint,
  onChange,
}: Readonly<{
  record: RecordType | undefined;
  scope: RecordScope;
  /** Whether directly shared records are a scope this permission kind understands. */
  allowShared: boolean;
  disabled: boolean;
  hint?: string | undefined;
  onChange: (scope: RecordScope) => void;
}>) {
  const routes = scope.routes;
  const ownershipAvailable = record !== undefined && record.ownership_mode !== "none";
  const kinds = routes.map((route) => route.kind);
  const unsupported =
    scope.saved_condition !== undefined ||
    kinds.some((kind) => kind === "relationship") ||
    (!allowShared &&
      !(kinds.length === 1 && (kinds[0] === "all_records" || kinds[0] === "ownership")));
  const value = unsupported ? "advanced" : routes.length > 1 ? "ownership_and_share" : kinds[0]!;
  return (
    <StudioField {...(hint === undefined ? {} : { hint })} label="Record scope">
      {(control) => (
        <StudioReferencePicker
          {...control}
          disabled={disabled || unsupported}
          value={value}
          options={[
            { value: "all_records", label: "All records" },
            ...(ownershipAvailable ? [{ value: "ownership", label: "Owned records" }] : []),
            ...(allowShared && ownershipAvailable
              ? [{ value: "ownership_and_share", label: "Owned or directly shared records" }]
              : []),
            ...(allowShared ? [{ value: "direct_share", label: "Directly shared records" }] : []),
            ...(unsupported
              ? [{ value: "advanced", label: "Relationship or saved condition scope" }]
              : []),
          ]}
          onChange={(next) =>
            onChange({
              routes:
                next === "ownership_and_share"
                  ? [{ kind: "ownership" }, { kind: "direct_share" }]
                  : [{ kind: next as "all_records" | "ownership" | "direct_share" }],
            })
          }
        />
      )}
    </StudioField>
  );
}
