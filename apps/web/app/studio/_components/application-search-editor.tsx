"use client";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Button } from "@vortex/ui/components/button";
import { NativeSelect } from "@vortex/ui/components/native-select";

import { useEffect, useState } from "react";
import { applicationSourceDocumentSchema, type ApplicationSourceDocument } from "@vortex/platform/schema";
import type { StudioApplicationSearchMetadata } from "../../_lib/studio-application-draft";

type SearchSource = NonNullable<ApplicationSourceDocument["body"]["search"]>;
type SearchEntry = SearchSource["record_types"][number];

/** A local buffer commits once to immutable draft history; choices never become authored metadata. */
export function ApplicationSearchEditor({ source, metadata, disabled, onPendingChange, onApply, onRefresh }: {
  source: ApplicationSourceDocument;
  metadata: StudioApplicationSearchMetadata | null;
  disabled: boolean;
  onPendingChange(pending: boolean): void;
  onApply(expected: ApplicationSourceDocument, search: SearchSource | undefined): boolean;
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
    const parsed = applicationSourceDocumentSchema.safeParse(candidate);
    if (!parsed.success) { setMessage("Choose searchable fields, a title and a compatible Page before applying."); return; }
    if (!onApply(source, parsed.data.body.search)) { setMessage("The draft or choices changed. Refresh before applying."); return; }
    setPending(false); onPendingChange(false); setMessage("Search applied to local history. Save and publish explicitly to use it.");
  };
  return <section aria-label="Application Search configuration" className="space-y-4 rounded-lg border p-4">
    <h2 className="text-lg font-semibold">Search</h2>
    <p>Choose published searchable fields and the Page a result opens. Changes stay in this draft until saved and published.</p>
    <Button type="button" variant="outline" size="sm" disabled={disabled || pending} onClick={onRefresh}>Refresh published choices</Button>
    {metadata === null ? <p>Save the draft and refresh to load current published choices.</p> : null}
    <fieldset disabled={disabled || metadata === null} className="space-y-4">
      <label className="flex gap-2"><Checkbox checked={buffer?.enabled ?? false}
        disabled={buffer === undefined} onCheckedChange={(checked) => buffer === undefined ? undefined : edit({ ...buffer, enabled: checked })} /> Enable Search</label>
      <label>Searchable record type
        <NativeSelect value="" onChange={(event) => addRecord(event.target.value)} disabled={(buffer?.record_types.length ?? 0) >= 20}>
          <option value="">Add a record type</option>
          {choices.filter((record) => !buffer?.record_types.some((entry) => entry.record_type === record.reference ||
              choices.find((choice) => choice.reference === entry.record_type)?.recordTypeId === record.recordTypeId) &&
            source.body.pages.some((page) => page.type === "detail" && page.record_type === record.reference))
            .map((record) => <option key={record.reference} value={record.reference}>{record.label}</option>)}
        </NativeSelect>
      </label>
      {buffer?.record_types.map((entry, index) => {
        const record = choices.find((record) => record.reference === entry.record_type);
        return <section key={entry.record_type} className="space-y-2 rounded-xl border bg-card text-card-foreground p-3">
          <h3>{record?.label ?? "Published choices unavailable"}</h3>
          {(record?.fields ?? []).map((field) => {
            const selected = entry.fields.find((item) => item.field === field.reference);
            return <div key={field.reference} className="flex gap-3">
              <label><Checkbox checked={selected !== undefined} onCheckedChange={(checked) => updateEntry(index, (current) => ({ ...current,
                fields: checked ? [...current.fields, { field: field.reference, priority: "normal" }] : current.fields.filter((item) => item.field !== field.reference) }))} /> {field.label} — Searchable</label>
              <NativeSelect aria-label={`${field.label} priority`} disabled={selected === undefined} value={selected?.priority ?? "normal"}
                onChange={(event) => updateEntry(index, (current) => ({ ...current, fields: current.fields.map((item) => item.field === field.reference
                  ? { ...item, priority: event.target.value as "first" | "normal" | "last" } : item) }))}>
                <option value="first">First</option><option value="normal">Normal</option><option value="last">Last</option>
              </NativeSelect>
            </div>;
          })}
          <label>Title <NativeSelect value={entry.title_field} onChange={(event) => updateEntry(index, (current) => ({ ...current, title_field: event.target.value }))}>
            {(record?.fields ?? []).map((field) => <option key={field.reference} value={field.reference}>{field.label}</option>)}
          </NativeSelect></label>
          <label>Subtitle <NativeSelect value={entry.subtitle_field ?? ""} onChange={(event) => updateEntry(index, (current) => {
            const { subtitle_field: _previous, ...rest } = current;
            return event.target.value === "" ? rest : { ...rest, subtitle_field: event.target.value };
          })}><option value="">None</option>
            {(record?.fields ?? []).map((field) => <option key={field.reference} value={field.reference}>{field.label}</option>)}
          </NativeSelect></label>
          <label>Open page <NativeSelect value={entry.target_page} onChange={(event) => updateEntry(index, (current) => ({ ...current, target_page: event.target.value }))}>
            {source.body.pages.filter((page) => page.type === "detail" && page.record_type === entry.record_type)
              .map((page) => <option key={page.id} value={page.key}>{page.name}</option>)}
          </NativeSelect></label>
          <Button type="button" variant="outline" size="sm" onClick={() => {
            if (buffer === undefined) return;
            if (buffer.record_types.length === 1) edit(undefined);
            else edit({ ...buffer, record_types: buffer.record_types.filter((_, item) => item !== index) });
          }}>Remove record type</Button>
        </section>;
      })}
      <Button type="button" variant="outline" size="sm" disabled={!pending} onClick={apply}>Apply Search</Button>
      <Button type="button" variant="outline" size="sm" disabled={!pending} onClick={() => { setBuffer(structuredClone(source.body.search)); setPending(false); onPendingChange(false); }}>Discard Search edits</Button>
    </fieldset>
    {source.body.search === undefined ? null : <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => {
      if (onApply(source, undefined)) { setPending(false); onPendingChange(false); }
    }}>Remove Search configuration</Button>}
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
