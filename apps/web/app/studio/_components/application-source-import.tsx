"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { canonicalJson, sameId, type ApplicationSourceDocumentV2 } from "@vortex/contracts";
import { reviewStudioApplicationSource } from "../actions";
import {
  maximumApplicationSourceImportBytes,
  readStudioApplicationSourceImport,
  sameStudioApplicationSourceImportSnapshot,
  studioApplicationSourceReviewResultSchema,
  type StudioApplicationSourceImportSnapshot,
} from "../_lib/application-source-import";

type ReviewedSource = Readonly<{
  snapshot: StudioApplicationSourceImportSnapshot;
  text: string; epoch: number;
  source: ApplicationSourceDocumentV2; fingerprint: string;
}>;

type Props = Readonly<{
  disabled: boolean;
  readSnapshot: () => StudioApplicationSourceImportSnapshot | null;
  onPendingChange: (pending: boolean) => void;
  onApply: (expected: StudioApplicationSourceImportSnapshot, source: ApplicationSourceDocumentV2) =>
    "applied" | "unchanged" | "stale";
}>;

const inputClass = "w-full rounded border border-border bg-background px-3 py-2 text-foreground";
const buttonClass = "rounded border border-border px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50";

export function ApplicationSourceImport({ disabled, readSnapshot, onPendingChange, onApply }: Props) {
  const [text, setText] = useState("");
  const [operation, setOperation] = useState<"reading" | "reviewing" | null>(null);
  const [reviewed, setReviewed] = useState<ReviewedSource | null>(null);
  const [message, setMessage] = useState("");
  const raw = useRef("");
  const busy = useRef<"reading" | "reviewing" | null>(null);
  const epoch = useRef(0);
  const active = useRef(false);
  const acceptedReview = useRef<ReviewedSource | null>(null);
  const pendingCallback = useRef(onPendingChange);
  pendingCallback.current = onPendingChange;
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      epoch.current += 1;
      pendingCallback.current(false);
    };
  }, []);

  const reportPending = () => pendingCallback.current(raw.current.length > 0 || busy.current !== null);

  const replaceText = (value: string) => {
    epoch.current += 1;
    acceptedReview.current = null;
    setReviewed(null);
    busy.current = null;
    setOperation(null);
    raw.current = value;
    setText(value);
    reportPending();
  };

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // The filename is only a browser input hint, never server provenance or a server path.
    event.target.value = "";
    const snapshot = readSnapshot();
    if (file === undefined || disabled || snapshot === null) return;
    if (file.size > maximumApplicationSourceImportBytes) {
      setMessage("The JSON source must be at most 2 MiB. Your existing input is preserved.");
      return;
    }
    const requestEpoch = ++epoch.current;
    acceptedReview.current = null;
    setReviewed(null);
    busy.current = "reading";
    setOperation("reading");
    reportPending();
    setMessage("Reading the selected local JSON file…");
    try {
      const value = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      if (!active.current || epoch.current !== requestEpoch) return;
      if (!sameStudioApplicationSourceImportSnapshot(snapshot, readSnapshot())) {
        setMessage("The editor changed while reading. Your previous input is preserved.");
        return;
      }
      if (value.length > maximumApplicationSourceImportBytes ||
        new TextEncoder().encode(value).byteLength > maximumApplicationSourceImportBytes) {
        setMessage("The JSON source must be at most 2 MiB. Your previous input is preserved.");
        return;
      }
      raw.current = value;
      setText(value);
      setMessage("File read locally. Review the source before applying it.");
    } catch {
      if (active.current && epoch.current === requestEpoch)
        setMessage("The selected file could not be read. Your previous input is preserved.");
    } finally {
      if (active.current && epoch.current === requestEpoch) {
        busy.current = null;
        setOperation(null);
        reportPending();
      }
    }
  };

  const review = async () => {
    const snapshot = readSnapshot();
    if (disabled || busy.current !== null || snapshot === null) return;
    const submittedText = raw.current;
    const candidate = readStudioApplicationSourceImport(submittedText, snapshot.key, snapshot.rootAlias);
    if (candidate.kind !== "valid") { setMessage(candidate.message); return; }
    const requestEpoch = ++epoch.current;
    acceptedReview.current = null;
    setReviewed(null);
    busy.current = "reviewing";
    setOperation("reviewing");
    reportPending();
    setMessage("Reviewing the source against the current protected draft…");
    try {
      const response = await reviewStudioApplicationSource(snapshot.organizationId, {
        rootId: snapshot.rootId, expectedDraftRevision: snapshot.draftRevision,
        expectedSavedSourceFingerprint: snapshot.savedSourceFingerprint, source: candidate.source,
      });
      if (!active.current || requestEpoch !== epoch.current || raw.current !== submittedText) return;
      if (!sameStudioApplicationSourceImportSnapshot(snapshot, readSnapshot())) {
        setMessage("The editor changed. Review again; your JSON input is preserved.");
        return;
      }
      const parsed = studioApplicationSourceReviewResultSchema.safeParse(response);
      if (!parsed.success) { setMessage("The review could not be verified. Your input is preserved."); return; }
      const result = parsed.data;
      if (result.kind !== "available") {
        setMessage(result.kind === "conflict" ? "The saved draft changed. Reopen explicitly before reviewing again."
          : result.kind === "invalid" ? "The source failed draft validation. Your input is preserved."
            : result.kind === "refused" ? "The current draft read was refused. Your input is preserved."
              : "The review is unavailable. Your input is preserved.");
        return;
      }
      if (!sameId(result.organizationId, snapshot.organizationId) || !sameId(result.rootId, snapshot.rootId) ||
        result.key !== snapshot.key || result.rootAlias !== snapshot.rootAlias ||
        result.draftRevision !== snapshot.draftRevision || result.savedSourceFingerprint !== snapshot.savedSourceFingerprint ||
        result.source.key !== snapshot.key || result.source.root_alias !== snapshot.rootAlias ||
        canonicalJson(result.source) !== canonicalJson(candidate.source)) {
        setMessage("The review does not match this source and draft. Your input is preserved.");
        return;
      }
      const next: ReviewedSource = { snapshot, text: submittedText, epoch: requestEpoch,
        source: result.source, fingerprint: result.candidateSourceFingerprint };
      acceptedReview.current = next;
      setReviewed(next);
      setMessage("Source reviewed for draft editing. Applying it changes local history only.");
    } catch {
      if (active.current && epoch.current === requestEpoch)
        setMessage("The review could not be completed. Your input is preserved.");
    } finally {
      if (active.current && epoch.current === requestEpoch) {
        busy.current = null;
        setOperation(null);
        reportPending();
      }
    }
  };

  const apply = () => {
    const candidate = acceptedReview.current;
    const isCurrent = () => candidate !== null && active.current && !disabled && busy.current === null &&
      candidate.epoch === epoch.current && candidate.text === raw.current &&
      sameStudioApplicationSourceImportSnapshot(candidate.snapshot, readSnapshot());
    if (candidate === null || !isCurrent()) {
      setMessage("The review is no longer current. Your input is preserved; review again.");
      return;
    }
    if (canonicalJson(candidate.source) === canonicalJson(candidate.snapshot.source)) {
      setMessage("This source already matches local history. No change was made.");
      return;
    }
    if (!window.confirm("Replace this draft's current local source with the reviewed document? Unsaved local changes will be replaced. Save remains a separate action.")) return;
    if (!isCurrent()) { setMessage("The editor changed. No source was replaced."); return; }
    const result = onApply(candidate.snapshot, candidate.source);
    if (result === "applied") {
      replaceText("");
      setMessage("Source applied to local history. Save the draft explicitly to persist it.");
    } else setMessage(result === "unchanged" ? "This source already matches local history. No change was made."
      : "The editor changed. Your input is preserved; review again.");
  };

  return <section className="space-y-3 rounded border border-border p-4" aria-label="Application source import" aria-busy={operation !== null}>
    <h2 className="font-semibold">Import authored Application source</h2>
    <p>Choose a local JSON file or paste source in format 2.0.0, up to 2 MiB. Keep this draft's key and root alias.
      Review the complete source before replacing local history. Import does not publish, install or adopt a release.</p>
    <label className="block space-y-1"><span>Local JSON source file</span>
      <input ref={fileInput} className={inputClass} type="file" accept=".json,application/json" disabled={disabled}
        onChange={(event) => { void readFile(event); }} /></label>
    <label className="block space-y-1"><span>Authored Application JSON</span>
      <textarea className={`${inputClass} min-h-48 font-mono text-sm`} value={text} disabled={disabled}
        onChange={(event) => {
          if (disabled || readSnapshot() === null) return;
          replaceText(event.target.value);
          setMessage("Input changed. Review this source before applying it.");
        }} /></label>
    {reviewed !== null && <div className="space-y-2">
      <p className="break-all">Reviewed source fingerprint: {reviewed.fingerprint}</p>
      <p>Applying replaces the complete current local source, including permissions, roles, dependencies, pages and flows.
        This review does not establish publication eligibility or installed permissions.</p>
      <details><summary>Current local source</summary>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-sm">{JSON.stringify(reviewed.snapshot.source, null, 2)}</pre></details>
      <details open><summary>Complete reviewed replacement source</summary>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-sm">{JSON.stringify(reviewed.source, null, 2)}</pre></details>
    </div>}
    <div className="flex flex-wrap gap-2">
      <button className={buttonClass} type="button" disabled={disabled || operation !== null || text.length === 0}
        onClick={() => { void review(); }}>Review source</button>
      <button className={buttonClass} type="button" disabled={disabled || operation !== null || reviewed === null}
        onClick={apply}>Apply reviewed source to local history</button>
      <button className={buttonClass} type="button" disabled={text.length === 0 && operation === null}
        onClick={() => {
          replaceText("");
          if (fileInput.current !== null) fileInput.current.value = "";
          setMessage("Unapplied source input discarded. Local history is unchanged.");
        }}>Discard source input or response</button>
    </div>
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
