"use client";

import { FieldDescription } from "../components/field";
import { useState, type ReactElement } from "react";
import { Alert, AlertDescription } from "../components/alert";
import { Button } from "../components/button";
import { ChevronsDown, RotateCcw } from "lucide-react";
import { useRecordChoicePager } from "../controls/use-record-choice-pager";
import { StudioReferencePicker } from "./studio-reference-picker";
import type { StudioRecordChoice, StudioRecordPage, StudioRecordReader } from "./studio-setting-model";

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
  label,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: Readonly<{
  id: string;
  /** The name of the setting or input this picks for: both pickers are named after it. */
  label: string;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: boolean | undefined;
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
        id={id}
        aria-label={`${label}: kind of record`}
        {...(recordType === "" ? { "aria-describedby": describedBy, "aria-invalid": invalid } : {})}
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
          <Alert variant="warning" role="status">
            <AlertDescription>Records can&apos;t be read here.</AlertDescription>
          </Alert>
        ) : (
          <StudioRecordChoices
            key={recordType}
            id={`${id}-record`}
            label={label}
            recordType={recordType}
            recordId={recordId}
            read={read}
            disabled={disabled}
            aria-describedby={describedBy}
            aria-invalid={invalid}
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
    label: string;
    recordType: string;
    recordId: string | undefined;
    read: StudioRecordReader;
    disabled: boolean;
    "aria-describedby"?: string | undefined;
    "aria-invalid"?: boolean | undefined;
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
  label,
  recordType,
  recordId,
  read,
  disabled,
  onPick,
  onRetry,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: Readonly<{
  id: string;
  label: string;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: boolean | undefined;
  recordType: string;
  recordId: string | undefined;
  read: StudioRecordReader;
  disabled: boolean;
  onPick: (recordId: string) => void;
  onRetry: () => void;
}>): ReactElement {
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [search, setSearch] = useState("");
  // The chosen record as a page or a search last listed it, kept by its title while the list holds
  // other records.
  const [picked, setPicked] = useState<StudioRecordChoice | undefined>(undefined);
  const pager = useRecordChoicePager<StudioRecordChoice>({
    open: true,
    search,
    read: async (text, after, signal) => {
      const page = await read(
        {
          recordType,
          ...(after === undefined ? {} : { after }),
          ...(text === "" ? {} : { search: text }),
        },
        signal,
      );
      if (page.kind !== "available") {
        setRefusal(page.kind);
        return page.kind === "temporarily_unavailable" ? undefined : { items: [] };
      }
      setRefusal(null);
      return { items: page.records, ...(page.next === undefined ? {} : { next: page.next }) };
    },
  });
  // The chosen record is known by its title once any page or search lists it.
  const listed = pager.items.find((record) => record.recordId === recordId);
  const relabelled = picked?.recordId !== listed?.recordId || picked?.label !== listed?.label;
  if (listed !== undefined && relabelled) setPicked(listed);
  const settled = !pager.loading && !pager.failed;
  const searching = search.trim() !== "";
  const heldPick = picked?.recordId === recordId ? picked : undefined;
  const known =
    recordId === undefined ||
    searching ||
    heldPick !== undefined ||
    pager.items.some((record) => record.recordId === recordId);
  const note = pager.failed
    ? "The records could not be read just now."
    : refusal !== null
      ? refusalNote(refusal)
      : settled && pager.items.length === 0 && !searching
        ? "There are no records of this type you may read yet."
        : undefined;
  const retry = pager.failed || refusal === "temporarily_unavailable";
  return (
    <>
      <StudioReferencePicker
        id={id}
        aria-label={`${label}: record`}
        value={recordId ?? ""}
        disabled={disabled}
        onSearch={setSearch}
        status={pager.loading ? "Searching…" : "No record matches that search."}
        // Inside the list, so the next page continues the search typed there.
        footer={(backToSearch) =>
          pager.next !== undefined && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full"
              disabled={disabled}
              onClick={() => {
                pager.loadMore();
                backToSearch();
              }}
            >
              <ChevronsDown />
              Show more records
            </Button>
          )
        }
        aria-describedby={describedBy}
        aria-invalid={invalid === true || (!known && settled && pager.next === undefined)}
        unset={pager.loading && pager.items.length === 0 ? "Reading records" : "Choose a record"}
        options={[
          ...(heldPick !== undefined &&
          !searching &&
          !pager.items.some((r) => r.recordId === recordId)
            ? [{ value: heldPick.recordId, label: heldPick.label }]
            : []),
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
      {note !== undefined &&
        (pager.failed || refusal !== null ? (
          <Alert variant="warning" role="status">
            <AlertDescription>{note}</AlertDescription>
          </Alert>
        ) : (
          <FieldDescription>{note}</FieldDescription>
        ))}
      {retry && (
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onRetry}>
          <RotateCcw />
          Try again
        </Button>
      )}
    </>
  );
}
