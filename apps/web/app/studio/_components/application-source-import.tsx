"use client";
import { Button } from "@vortex/ui/components/button";
import { TechnicalDetails, ViewSource } from "@vortex/ui/components/technical-details";
import { Input } from "@vortex/ui/components/input";
import { Textarea } from "@vortex/ui/components/textarea";
import { StudioField } from "./studio-field";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { canonicalJson, sameId, type ApplicationSourceDocument,
  type DefinitionValidationResult } from "@vortex/platform/schema";
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
  source: ApplicationSourceDocument; fingerprint: string;
}>;

type SourceDiagnostics = Readonly<{
  snapshot: StudioApplicationSourceImportSnapshot;
  text: string; epoch: number;
  validation: DefinitionValidationResult;
}>;

type Props = Readonly<{
  disabled: boolean;
  readSnapshot: () => StudioApplicationSourceImportSnapshot | null;
  onPendingChange: (pending: boolean) => void;
  onApply: (expected: StudioApplicationSourceImportSnapshot, source: ApplicationSourceDocument) =>
    "applied" | "unchanged" | "stale";
}>;

const inputClass = "w-full";

const candidateFingerprint = async (source: ApplicationSourceDocument): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(source)));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

export function ApplicationSourceImport({ disabled, readSnapshot, onPendingChange, onApply }: Props) {
  const [confirm, confirmDialog] = useConfirm();
  const [text, setText] = useState("");
  const [operation, setOperation] = useState<"reading" | "reviewing" | null>(null);
  const [reviewed, setReviewed] = useState<ReviewedSource | null>(null);
  const [diagnostics, setDiagnostics] = useState<SourceDiagnostics | null>(null);
  const [message, setMessage] = useState("");
  const raw = useRef("");
  const busy = useRef<"reading" | "reviewing" | null>(null);
  const epoch = useRef(0);
  const active = useRef(false);
  const acceptedReview = useRef<ReviewedSource | null>(null);
  const pendingCallback = useRef(onPendingChange);
  pendingCallback.current = onPendingChange;
  const fileInput = useRef<HTMLInputElement | null>(null);
  const currentDisabled = useRef(disabled);
  currentDisabled.current = disabled;
  const currentSnapshotReader = useRef(readSnapshot);
  currentSnapshotReader.current = readSnapshot;

  // Suppress a previous result in the same render that changes the editor frame.
  const diagnosticsCurrent = diagnostics !== null && active.current && !disabled &&
    diagnostics.epoch === epoch.current && diagnostics.text === raw.current &&
    sameStudioApplicationSourceImportSnapshot(diagnostics.snapshot, readSnapshot());
  useEffect(() => {
    if (diagnostics !== null && !diagnosticsCurrent) setDiagnostics(null);
  }, [diagnostics, diagnosticsCurrent]);

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
    setDiagnostics(null);
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
    const requestEpoch = ++epoch.current;
    acceptedReview.current = null;
    setReviewed(null);
    setDiagnostics(null);
    busy.current = null;
    setOperation(null);
    reportPending();
    if (file.size > maximumApplicationSourceImportBytes) {
      setMessage("The JSON source must be at most 2 MiB. Your existing input is preserved.");
      return;
    }
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
    const requestEpoch = ++epoch.current;
    acceptedReview.current = null;
    setReviewed(null);
    setDiagnostics(null);
    const submittedText = raw.current;
    const candidate = readStudioApplicationSourceImport(submittedText, snapshot.key, snapshot.rootAlias);
    if (candidate.kind !== "valid") { setMessage(candidate.message); return; }
    busy.current = "reviewing";
    setOperation("reviewing");
    reportPending();
    setMessage("Reviewing the source against the current protected draft…");
    const responseIsCurrent = () => active.current && !currentDisabled.current &&
      requestEpoch === epoch.current && raw.current === submittedText &&
      sameStudioApplicationSourceImportSnapshot(snapshot, currentSnapshotReader.current());
    try {
      const response = await reviewStudioApplicationSource(snapshot.organizationId, {
        rootId: snapshot.rootId, expectedDraftRevision: snapshot.draftRevision,
        expectedSavedSourceFingerprint: snapshot.savedSourceFingerprint, source: candidate.source,
      });
      if (!active.current || currentDisabled.current || requestEpoch !== epoch.current || raw.current !== submittedText) return;
      if (!responseIsCurrent()) {
        setMessage("The editor changed. Review again; your JSON input is preserved.");
        return;
      }
      const parsed = studioApplicationSourceReviewResultSchema.safeParse(response);
      if (!parsed.success) { setMessage("The review could not be verified. Your input is preserved."); return; }
      const result = parsed.data;
      if (result.kind !== "available" && result.kind !== "validation_failed") {
        setMessage(result.kind === "conflict" ? "The saved draft changed. Reopen explicitly before reviewing again."
          : result.kind === "invalid" ? "The source failed draft validation. Your input is preserved."
            : result.kind === "refused" ? "The current draft read was refused. Your input is preserved."
              : "The review is unavailable. Your input is preserved.");
        return;
      }
      if (!sameId(result.organizationId, snapshot.organizationId) || !sameId(result.rootId, snapshot.rootId) ||
        result.key !== snapshot.key || result.rootAlias !== snapshot.rootAlias ||
        result.draftRevision !== snapshot.draftRevision || result.savedSourceFingerprint !== snapshot.savedSourceFingerprint) {
        setMessage("The review does not match this source and draft. Your input is preserved.");
        return;
      }
      const submittedFingerprint = await candidateFingerprint(candidate.source);
      if (!responseIsCurrent()) return;
      if (result.candidateSourceFingerprint !== submittedFingerprint) {
        setMessage("The review does not match the submitted source. Your input is preserved.");
        return;
      }
      if (result.kind === "validation_failed") {
        if (!result.validation.errors.every((error) => error.location === undefined ||
          (error.location.documentKind === "application" && error.location.documentKey === snapshot.key))) {
          setMessage("The validation locations do not match this Application. Your input is preserved.");
          return;
        }
        setDiagnostics({ snapshot, text: submittedText, epoch: requestEpoch, validation: result.validation });
        setMessage("The source failed semantic validation. Resolve the displayed issues and review again. Your input is preserved.");
        return;
      }
      if (result.source.key !== snapshot.key || result.source.root_alias !== snapshot.rootAlias ||
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
      if (responseIsCurrent())
        setMessage("The review could not be completed. Your input is preserved.");
    } finally {
      if (active.current && epoch.current === requestEpoch) {
        busy.current = null;
        setOperation(null);
        reportPending();
      }
    }
  };

  const apply = async () => {
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
    if (!await confirm({
      title: "Replace the local source with the reviewed document?",
      description: "Replace this draft's current local source with the reviewed document? Unsaved local changes will be replaced. Save remains a separate action.",
      confirmLabel: "Replace local source",
    })) return;
    if (!isCurrent()) { setMessage("The editor changed. No source was replaced."); return; }
    const result = onApply(candidate.snapshot, candidate.source);
    if (result === "applied") {
      replaceText("");
      setMessage("Source applied to local history. Save the draft explicitly to persist it.");
    } else setMessage(result === "unchanged" ? "This source already matches local history. No change was made."
      : "The editor changed. Your input is preserved; review again.");
  };

  return <section className="space-y-3 rounded-xl border bg-card text-card-foreground border-border p-4" aria-label="Application source import" aria-busy={operation !== null}>
    <h2 className="font-semibold">Import authored Application source</h2>
    <p>Choose a local JSON file or paste source in format 2.0.0, up to 2 MiB. Keep this draft's key and root alias.
      Review the complete source before replacing local history. Import does not publish, install or adopt a release.</p>
    <StudioField label="Local JSON source file">
      {(control) => <Input {...control} ref={fileInput} type="file" accept=".json,application/json" disabled={disabled}
        onChange={(event) => { void readFile(event); }} />}
    </StudioField>
    <StudioField label="Authored Application JSON">
      {(control) => <Textarea {...control} className={`${inputClass} min-h-48 font-mono text-sm`} value={text} disabled={disabled}
        onChange={(event) => {
          if (disabled || readSnapshot() === null) return;
          replaceText(event.target.value);
          setMessage("Input changed. Review this source before applying it.");
        }} />}
    </StudioField>
    {reviewed !== null && <div className="space-y-2">
      <p>Applying replaces the complete current local source, including permissions, roles, dependencies, pages and flows.
        This review does not establish publication eligibility or installed permissions.</p>
      <TechnicalDetails title="View source and technical details">
        <p className="break-all">Reviewed source fingerprint: <code>{reviewed.fingerprint}</code></p>
        <ViewSource value={reviewed.snapshot.source} title="Current local source" />
        <ViewSource value={reviewed.source} title="Complete reviewed replacement source" />
      </TechnicalDetails>
    </div>}
    {diagnosticsCurrent && diagnostics !== null && <div role="status" aria-live="polite" className="space-y-2">
      <h3 className="font-semibold">Source validation issues</h3>
      <ul className="space-y-3">
        {diagnostics.validation.errors.map((error, index) => <li key={`${error.code}:${index}`}>
          <p className="break-all">Application document: {error.location?.documentKey ?? diagnostics.snapshot.key}
            {error.location?.segments.map((segment, segmentIndex) =>
              <span key={segmentIndex}> · {segment.kind}: {segment.key}</span>)}</p>
          <p><code>{error.code}</code>: {error.message}</p>
          <p>{error.guidance}</p>
        </li>)}
      </ul>
    </div>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={disabled || operation !== null || text.length === 0}
        onClick={() => { void review(); }}>Review source</Button>
      <Button type="button" disabled={disabled || operation !== null || reviewed === null}
        onClick={apply}>Apply reviewed source to local history</Button>
      <Button type="button" disabled={text.length === 0 && operation === null}
        onClick={() => {
          replaceText("");
          if (fileInput.current !== null) fileInput.current.value = "";
          setMessage("Unapplied source input discarded. Local history is unchanged.");
        }}>Discard source input or response</Button>
    </div>
    <p role="status" aria-live="polite">{message}</p>
    {confirmDialog}
  </section>;
}
