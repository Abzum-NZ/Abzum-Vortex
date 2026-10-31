"use client";

import { useState, type ReactElement } from "react";
import { Button } from "../components/button";
import { ChevronsDown, RotateCcw } from "lucide-react";
import { useRecordChoicePager } from "../controls/use-record-choice-pager";
import { StudioReferencePicker } from "./studio-reference-picker";
import { StudioHelp } from "./studio-field";

/** One record a record reference can point at: its identity and the title the person reads. */
export type StudioRecordChoice = Readonly<{ recordId: string; label: string }>;

/**
 * One page of the records of a record type, read from the builder's preview of the saved draft
 * with their preview access, or why none can be read.
 */
export type StudioRecordPage =
  | Readonly<{ kind: "available"; records: readonly StudioRecordChoice[]; next?: string }>
  /** The record type is not in the saved draft yet. */
  | Readonly<{ kind: "not_saved" }>
  /** The saved draft has no query that lists these records by their title. */
  | Readonly<{ kind: "no_list" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/**
 * Reads one page of records of a draft record type (`<module>:<record>`), after a keyset
 * continuation token. Each page holds at most 40 records.
 */
export type StudioRecordReader = (
  request: Readonly<{
    recordType: string;
    after?: string;
  }>,
  signal?: AbortSignal,
) => Promise<StudioRecordPage>;

type RecordValue = Readonly<{ recordType: string; recordId: string }>;

type Refusal = Exclude<StudioRecordPage["kind"], "available">;

const refusalNote = (kind: Refusal): string => {
  switch (kind) {
    case "not_saved":
      return "These records are not in the saved draft yet. Save, then pick a record.";
    case "no_list":
      return "No list of these records can be read: the record type needs a query with no inputs and no grouping.";
    case "refused":
      return "You may not read these records.";
    case "temporarily_unavailable":
      return "The records could not be read just now.";
  }
};

/**
 * A record reference: the record type first, from the draft, then one of its records, read page
 * by page (40 at a time) from the builder's preview of the saved draft with their preview access.
 */
export function StudioRecordReferenceControl({
  id,
  value,
  onChange,
  recordTypes,
  read,
  disabled,
}: Readonly<{
  id: string;
  value: RecordValue | undefined;
  onChange: (value: RecordValue | undefined) => void;
  recordTypes: readonly Readonly<{ key: string; label: string }>[];
  read: StudioRecordReader | null;
  disabled: boolean;
}>): ReactElement {
  const [recordType, setRecordType] = useState(value?.recordType ?? "");
  const [seen, setSeen] = useState(value?.recordType);
  if (value !== undefined && value.recordType !== seen) {
    setSeen(value.recordType);
    setRecordType(value.recordType);
  }
  const recordId = value?.recordType === recordType ? value.recordId : undefined;

  return (
    <div className="space-y-2">
      <StudioReferencePicker
        id={`${id}-record-type`}
        aria-label="Kind of record"
        disabled={disabled}
        value={recordType}
        unset={
          recordTypes.length === 0
            ? "This application has no record types yet"
            : "Choose a record type"
        }
        options={recordTypes.map((type) => ({ value: type.key, label: type.label }))}
        onChange={(next) => {
          setRecordType(next);
          if (value !== undefined) onChange(undefined);
        }}
      />
      {recordType !== "" &&
        (read === null ? (
          <p role="status" className="text-sm text-muted-foreground">
            Records can&apos;t be read here.
          </p>
        ) : (
          <StudioRecordChoices
            key={recordType}
            id={id}
            recordType={recordType}
            recordId={recordId}
            read={read}
            disabled={disabled}
            onPick={(next) => onChange(next === "" ? undefined : { recordType, recordId: next })}
          />
        ))}
    </div>
  );
}

/** The records of one record type, paged by the one record-choice pager; remounted to try again. */
function StudioRecordChoices(
  props: Readonly<{
    id: string;
    recordType: string;
    recordId: string | undefined;
    read: StudioRecordReader;
    disabled: boolean;
    onPick: (recordId: string) => void;
  }>,
): ReactElement {
  const [attempt, setAttempt] = useState(0);
  return (
    <StudioRecordChoicesPage
      key={attempt}
      {...props}
      onRetry={() => setAttempt((count) => count + 1)}
    />
  );
}

function StudioRecordChoicesPage({
  id,
  recordType,
  recordId,
  read,
  disabled,
  onPick,
  onRetry,
}: Readonly<{
  id: string;
  recordType: string;
  recordId: string | undefined;
  read: StudioRecordReader;
  disabled: boolean;
  onPick: (recordId: string) => void;
  onRetry: () => void;
}>): ReactElement {
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const pager = useRecordChoicePager<StudioRecordChoice>({
    open: true,
    search: "",
    read: async (_search, after) => {
      const page = await read({ recordType, ...(after === undefined ? {} : { after }) });
      if (page.kind !== "available") {
        setRefusal(page.kind);
        return page.kind === "temporarily_unavailable" ? undefined : { items: [] };
      }
      setRefusal(null);
      return { items: page.records, ...(page.next === undefined ? {} : { next: page.next }) };
    },
  });
  const settled = !pager.loading && !pager.failed;
  const known =
    recordId === undefined || pager.items.some((record) => record.recordId === recordId);
  const note = pager.failed
    ? "The records could not be read just now."
    : refusal !== null
      ? refusalNote(refusal)
      : settled && pager.items.length === 0
        ? "There are no records of this type you may read yet."
        : undefined;
  const retry = pager.failed || refusal === "temporarily_unavailable";
  return (
    <>
      <StudioReferencePicker
        id={id}
        aria-label="Record"
        value={recordId ?? ""}
        disabled={disabled || pager.loading}
        aria-invalid={!known && settled && pager.next === undefined}
        unset={pager.loading ? "Reading records" : "Choose a record"}
        options={[
          ...(!known && recordId !== undefined
            ? [
                {
                  value: recordId,
                  label:
                    settled && pager.next === undefined
                      ? "The chosen record (you may not read it now)"
                      : "The chosen record (show more records to find it)",
                  disabled: true,
                },
              ]
            : []),
          ...pager.items.map((record) => ({ value: record.recordId, label: record.label })),
        ]}
        onChange={onPick}
      />
      {note !== undefined && <StudioHelp hint={note} />}
      <div className="flex flex-wrap gap-1">
        {pager.next !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={pager.loadMore}
          >
            <ChevronsDown />
            Show more records
          </Button>
        )}
        {retry && (
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onRetry}>
            <RotateCcw />
            Try again
          </Button>
        )}
      </div>
    </>
  );
}
