"use client";

import { useEffect, useState } from "react";
import { applicationSourceDocumentV2Schema, type ApplicationSourceDocumentV2 } from "@vortex/contracts";
import type { StudioApplicationSearchMetadata } from "../../_lib/studio-application-draft";

type SearchSource = NonNullable<ApplicationSourceDocumentV2["body"]["search"]>;
type SearchEntry = SearchSource["record_types"][number];

/** A local buffer commits once to immutable draft history; choices never become authored metadata. */
export function ApplicationSearchEditor({ source, metadata, disabled, onPendingChange, onApply, onRefresh }: {
  source: ApplicationSourceDocumentV2;
  metadata: StudioApplicationSearchMetadata | null;
  disabled: boolean;
  onPendingChange(pending: boolean): void;
  onApply(expected: ApplicationSourceDocumentV2, search: SearchSource | undefined): boolean;
  onRefresh(): void;
}) {
  const [buffer, setBuffer] = useState<SearchSource | undefined>(() => structuredClone(source.body.search));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    setBuffer(structuredClone(source.body.search)); setPending(false); setMessage(""); onPendingChange(false);
  }, [source, onPendingChange]);
  const edit = (search: SearchSource | undefined) => {
    setBuffer(search); setPending(true); onPendingChange(true); setMessage("");
  };
  const updateEntry = (index: number, update: (entry: SearchEntry) => SearchEntry) => {
    if (buffer === undefined) return;
    edit({ ...buffer, record_types: buffer.record_types.map((entry, item) => item === index ? update(entry) : entry) });
  };
  const choices = metadata?.records ?? [];
  const addRecord = (reference: string) => {
    const record = choices.find((record) => record.reference === reference);
    const page = source.body.pages.find((page) => page.type === "detail" && page.record_type === reference);
    if (record === undefined || record.fields[0] === undefined || page === undefined ||
        buffer?.record_types.some((entry) => choices.find((choice) => choice.reference === entry.record_type)?.recordTypeId === record.recordTypeId)) return;
    edit({ enabled: buffer?.enabled ?? true, record_types: [...buffer?.record_types ?? [], {
      record_type: reference, fields: [{ field: record.fields[0].reference, priority: "normal" }],
      title_field: record.fields[0].reference, target_page: page.key,
    }] });
  };
  const apply = () => {
    const candidate = structuredClone(source);
    if (buffer === undefined) delete candidate.body.search;
    else candidate.body.search = buffer;
    const parsed = applicationSourceDocumentV2Schema.safeParse(candidate);
    if (!parsed.success) { setMessage("Choose searchable fields, a title and a compatible Page before applying."); return; }
    if (!onApply(source, parsed.data.body.search)) { setMessage("The draft or choices changed. Refresh before applying."); return; }
    setPending(false); onPendingChange(false); setMessage("Search applied to local history. Save and publish explicitly to use it.");
  };
  return <section aria-label="Application Search configuration" className="space-y-4 rounded-lg border p-4">
    <h2 className="text-lg font-semibold">Search</h2>
    <p>Choose published searchable fields and the Page a result opens. Changes stay in this draft until saved and published.</p>
    <button type="button" disabled={disabled || pending} onClick={onRefresh}>Refresh published choices</button>
    {metadata === null ? <p>Save the draft and refresh to load current published choices.</p> : null}
    <fieldset disabled={disabled || metadata === null} className="space-y-4">
      <label className="flex gap-2"><input type="checkbox" checked={buffer?.enabled ?? false}
        disabled={buffer === undefined} onChange={(event) => buffer === undefined ? undefined : edit({ ...buffer, enabled: event.target.checked })} /> Enable Search</label>
      <label>Searchable record type
        <select value="" onChange={(event) => addRecord(event.target.value)} disabled={(buffer?.record_types.length ?? 0) >= 20}>
          <option value="">Add a record type</option>
          {choices.filter((record) => !buffer?.record_types.some((entry) => entry.record_type === record.reference ||
              choices.find((choice) => choice.reference === entry.record_type)?.recordTypeId === record.recordTypeId) &&
            source.body.pages.some((page) => page.type === "detail" && page.record_type === record.reference))
            .map((record) => <option key={record.reference} value={record.reference}>{record.label}</option>)}
        </select>
      </label>
      {buffer?.record_types.map((entry, index) => {
        const record = choices.find((record) => record.reference === entry.record_type);
        return <section key={entry.record_type} className="space-y-2 rounded border p-3">
          <h3>{record?.label ?? "Published choices unavailable"}</h3>
          {(record?.fields ?? []).map((field) => {
            const selected = entry.fields.find((item) => item.field === field.reference);
            return <div key={field.reference} className="flex gap-3">
              <label><input type="checkbox" checked={selected !== undefined} onChange={(event) => updateEntry(index, (current) => ({ ...current,
                fields: event.target.checked ? [...current.fields, { field: field.reference, priority: "normal" }] : current.fields.filter((item) => item.field !== field.reference) }))} /> {field.label} — Searchable</label>
              <select aria-label={`${field.label} priority`} disabled={selected === undefined} value={selected?.priority ?? "normal"}
                onChange={(event) => updateEntry(index, (current) => ({ ...current, fields: current.fields.map((item) => item.field === field.reference
                  ? { ...item, priority: event.target.value as "first" | "normal" | "last" } : item) }))}>
                <option value="first">First</option><option value="normal">Normal</option><option value="last">Last</option>
              </select>
            </div>;
          })}
          <label>Title <select value={entry.title_field} onChange={(event) => updateEntry(index, (current) => ({ ...current, title_field: event.target.value }))}>
            {(record?.fields ?? []).map((field) => <option key={field.reference} value={field.reference}>{field.label}</option>)}
          </select></label>
          <label>Subtitle <select value={entry.subtitle_field ?? ""} onChange={(event) => updateEntry(index, (current) => {
            const { subtitle_field: _previous, ...rest } = current;
            return event.target.value === "" ? rest : { ...rest, subtitle_field: event.target.value };
          })}><option value="">None</option>
            {(record?.fields ?? []).map((field) => <option key={field.reference} value={field.reference}>{field.label}</option>)}
          </select></label>
          <label>Open page <select value={entry.target_page} onChange={(event) => updateEntry(index, (current) => ({ ...current, target_page: event.target.value }))}>
            {source.body.pages.filter((page) => page.type === "detail" && page.record_type === entry.record_type)
              .map((page) => <option key={page.id} value={page.key}>{page.name}</option>)}
          </select></label>
          <button type="button" onClick={() => {
            if (buffer === undefined) return;
            if (buffer.record_types.length === 1) edit(undefined);
            else edit({ ...buffer, record_types: buffer.record_types.filter((_, item) => item !== index) });
          }}>Remove record type</button>
        </section>;
      })}
      <button type="button" disabled={!pending} onClick={apply}>Apply Search</button>
      <button type="button" disabled={!pending} onClick={() => { setBuffer(structuredClone(source.body.search)); setPending(false); onPendingChange(false); }}>Discard Search edits</button>
    </fieldset>
    {source.body.search === undefined ? null : <button type="button" disabled={disabled} onClick={() => {
      if (onApply(source, undefined)) { setPending(false); onPendingChange(false); }
    }}>Remove Search configuration</button>}
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
