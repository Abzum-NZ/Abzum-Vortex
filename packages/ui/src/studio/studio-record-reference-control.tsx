"use client";

import { useEffect, useState, type ReactElement } from "react";
import { Button } from "../components/button";
import { NativeSelect, NativeSelectOption } from "../components/native-select";

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
export type StudioRecordReader = (request: Readonly<{
  recordType: string;
  after?: string;
}>) => Promise<StudioRecordPage>;

type RecordValue = Readonly<{ recordType: string; recordId: string }>;

type Loaded =
  | Readonly<{ state: "loading" }>
  | Readonly<{ state: "failed" }>
  | Readonly<{ state: "read"; page: StudioRecordPage }>;

const pageNote = (page: StudioRecordPage): string | undefined => {
  switch (page.kind) {
    case "available": return page.records.length === 0 ? "There are no records of this type you may read yet." : undefined;
    case "not_saved": return "These records are not in the saved draft yet. Save, then pick a record.";
    case "no_list": return "No list of these records can be read: the record type needs a query with no inputs and no grouping.";
    case "refused": return "You may not read these records.";
    case "temporarily_unavailable": return "The records could not be read just now.";
  }
};

/**
 * A record reference: the record type first, from the draft, then one of its records, read page
 * by page (40 at a time) from the builder's preview of the saved draft with their preview access.
 */
export function StudioRecordReferenceControl({ id, value, onChange, recordTypes, read, disabled }: Readonly<{
  id: string;
  value: RecordValue | undefined;
  onChange: (value: RecordValue | undefined) => void;
  recordTypes: readonly Readonly<{ key: string; label: string }>[];
  read: StudioRecordReader | null;
  disabled: boolean;
}>): ReactElement {
  const [recordType, setRecordType] = useState(value?.recordType ?? "");
  const [seen, setSeen] = useState(value?.recordType);
  if (value !== undefined && value.recordType !== seen) { setSeen(value.recordType); setRecordType(value.recordType); }
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [records, setRecords] = useState<readonly StudioRecordChoice[]>([]);
  const [attempt, setAttempt] = useState(0);
  const recordId = value?.recordType === recordType ? value.recordId : undefined;

  useEffect(() => {
    if (read === null || recordType === "") return;
    let cancelled = false;
    setLoaded({ state: "loading" });
    setRecords([]);
    read({ recordType }).then(
      (page) => {
        if (cancelled) return;
        setLoaded({ state: "read", page });
        if (page.kind === "available") setRecords(page.records);
      },
      (error: unknown) => {
        console.error(`[studio] record choices could not be read: setting=${id}`, error);
        if (!cancelled) setLoaded({ state: "failed" });
      });
    return () => { cancelled = true; };
  }, [read, recordType, id, attempt]);

  const more = async (after: string) => {
    if (read === null) return;
    try {
      const page = await read({ recordType, after });
      setLoaded({ state: "read", page });
      if (page.kind === "available")
        setRecords((previous) => [...previous, ...page.records.filter((record) =>
          !previous.some((known) => known.recordId === record.recordId))]);
    } catch (error) {
      console.error(`[studio] more record choices could not be read: setting=${id}`, error);
      setLoaded({ state: "failed" });
    }
  };

  const known = recordId === undefined || records.some((record) => record.recordId === recordId);
  const shown = records;
  const note = loaded.state === "failed" ? "The records could not be read just now."
    : loaded.state === "read" ? pageNote(loaded.page) : undefined;
  const next = loaded.state === "read" && loaded.page.kind === "available" ? loaded.page.next : undefined;
  const retry = loaded.state === "failed" || (loaded.state === "read" && loaded.page.kind === "temporarily_unavailable");

  return <div className="space-y-2">
    <NativeSelect id={`${id}-record-type`} className="w-full" aria-label="Kind of record" disabled={disabled}
      value={recordType} onChange={(event) => { setRecordType(event.target.value); if (value !== undefined) onChange(undefined); }}>
      <NativeSelectOption value="">
        {recordTypes.length === 0 ? "This application has no record types yet" : "Choose the kind of record…"}
      </NativeSelectOption>
      {recordType === "" || recordTypes.some((type) => type.key === recordType) ? null
        : <NativeSelectOption value={recordType}>{`${recordType} (not offered here)`}</NativeSelectOption>}
      {recordTypes.map((type) => <NativeSelectOption key={type.key} value={type.key}>{type.label}</NativeSelectOption>)}
    </NativeSelect>
    {recordType !== "" && (read === null
      ? <p role="status" className="text-sm text-muted-foreground">Records can't be read here.</p>
      : <>
          <NativeSelect id={id} className="w-full" aria-label="Record" value={recordId ?? ""}
            disabled={disabled || loaded.state === "loading"}
            aria-invalid={!known && loaded.state === "read" && next === undefined}
            onChange={(event) => onChange(event.target.value === "" ? undefined
              : { recordType, recordId: event.target.value })}>
            <NativeSelectOption value="">{loaded.state === "loading" ? "Reading the records…" : "Choose a record…"}</NativeSelectOption>
            {known ? null : <NativeSelectOption value={recordId}>
              {loaded.state === "read" && next === undefined ? "The chosen record (you may not read it now)"
                : "The chosen record (show more records to find it)"}</NativeSelectOption>}
            {shown.map((record) => <NativeSelectOption key={record.recordId} value={record.recordId}>{record.label}</NativeSelectOption>)}
          </NativeSelect>
          {note !== undefined && <p role="status" className="text-sm text-muted-foreground">{note}</p>}
          <div className="flex flex-wrap gap-2">
            {next !== undefined && <Button type="button" variant="outline" size="sm" disabled={disabled}
              onClick={() => { void more(next); }}>Show more records</Button>}
            {retry && <Button type="button" variant="outline" size="sm" disabled={disabled}
              onClick={() => setAttempt((count) => count + 1)}>Try again</Button>}
          </div>
        </>)}
  </div>;
}
