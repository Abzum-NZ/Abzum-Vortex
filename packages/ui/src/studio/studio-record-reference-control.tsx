"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import { Button } from "../components/button";
import { ChevronsDown, RotateCcw } from "lucide-react";
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

type Loaded =
  | Readonly<{ state: "loading" }>
  | Readonly<{ state: "failed" }>
  | Readonly<{ state: "read"; page: StudioRecordPage }>;

const pageNote = (page: StudioRecordPage): string | undefined => {
  switch (page.kind) {
    case "available":
      return page.records.length === 0
        ? "There are no records of this type you may read yet."
        : undefined;
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
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [records, setRecords] = useState<readonly StudioRecordChoice[]>([]);
  const demand = useRef<AbortController | null>(null);
  const [attempt, setAttempt] = useState(0);
  const recordId = value?.recordType === recordType ? value.recordId : undefined;

  useEffect(() => {
    if (read === null || recordType === "") return;
    let cancelled = false;
    const controller = new AbortController();
    demand.current = controller;
    setLoaded({ state: "loading" });
    setRecords([]);
    read({ recordType }, controller.signal).then(
      (page) => {
        if (cancelled) return;
        setLoaded({ state: "read", page });
        if (page.kind === "available") setRecords(page.records);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        console.error(`[studio] record choices could not be read: setting=${id}`, error);
        if (!cancelled) setLoaded({ state: "failed" });
      },
    );
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [read, recordType, id, attempt]);

  const more = async (after: string) => {
    if (read === null) return;
    const controller = demand.current;
    if (controller === null || controller.signal.aborted) return;
    try {
      const page = await read({ recordType, after }, controller.signal);
      if (controller.signal.aborted) return;
      setLoaded({ state: "read", page });
      if (page.kind === "available")
        setRecords((previous) => [
          ...previous,
          ...page.records.filter(
            (record) => !previous.some((known) => known.recordId === record.recordId),
          ),
        ]);
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error(`[studio] more record choices could not be read: setting=${id}`, error);
      setLoaded({ state: "failed" });
    }
  };

  const known = recordId === undefined || records.some((record) => record.recordId === recordId);
  const shown = records;
  const note =
    loaded.state === "failed"
      ? "The records could not be read just now."
      : loaded.state === "read"
        ? pageNote(loaded.page)
        : undefined;
  const next =
    loaded.state === "read" && loaded.page.kind === "available" ? loaded.page.next : undefined;
  const retry =
    loaded.state === "failed" ||
    (loaded.state === "read" && loaded.page.kind === "temporarily_unavailable");

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
            Records can't be read here.
          </p>
        ) : (
          <>
            <StudioReferencePicker
              id={id}
              aria-label="Record"
              value={recordId ?? ""}
              disabled={disabled || loaded.state === "loading"}
              aria-invalid={!known && loaded.state === "read" && next === undefined}
              unset={loaded.state === "loading" ? "Reading records" : "Choose a record"}
              options={[
                ...(!known && recordId !== undefined
                  ? [
                      {
                        value: recordId,
                        label:
                          loaded.state === "read" && next === undefined
                            ? "The chosen record (you may not read it now)"
                            : "The chosen record (show more records to find it)",
                        disabled: true,
                      },
                    ]
                  : []),
                ...shown.map((record) => ({ value: record.recordId, label: record.label })),
              ]}
              onChange={(next) =>
                onChange(next === "" ? undefined : { recordType, recordId: next })
              }
            />
            {note !== undefined && <StudioHelp hint={note} />}
            <div className="flex flex-wrap gap-1">
              {next !== undefined && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    void more(next);
                  }}
                >
                  <ChevronsDown />
                  Show more records
                </Button>
              )}
              {retry && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => setAttempt((count) => count + 1)}
                >
                  <RotateCcw />
                  Try again
                </Button>
              )}
            </div>
          </>
        ))}
    </div>
  );
}
