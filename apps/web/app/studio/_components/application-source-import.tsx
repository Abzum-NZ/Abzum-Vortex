"use client";
import { Button } from "@vortex/ui/components/button";
import { TechnicalDetails, ViewSource } from "@vortex/ui/components/technical-details";
import { Input } from "@vortex/ui/components/input";
import { Textarea } from "@vortex/ui/components/textarea";
import { StudioField } from "./studio-field";
import { summarizeSourceChange } from "../_lib/source-change-summary";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@vortex/ui/components/table";
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
  onApply: (expected: StudioApplicationSourceImportSnapshot, source: ApplicationSourceDocument) =>
    "applied" | "unchanged" | "stale";
}>;

const inputClass = "w-full";

const candidateFingerprint = async (source: ApplicationSourceDocument): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(source)));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

/** What the imported file would change, by area and item name; the source itself is only under View source. */
function SourceChangeTable({ current, next }: { current: ApplicationSourceDocument; next: ApplicationSourceDocument }) {
  const rows = summarizeSourceChange(current, next);
  if (rows.length === 0) return <p>The file matches your draft. Nothing would change.</p>;
  return <Table>
    <TableHeader><TableRow><TableHead>Area</TableHead><TableHead>Item</TableHead><TableHead>Change</TableHead></TableRow></TableHeader>
    <TableBody>{rows.map((row, index) => <TableRow key={`${row.area}:${row.item}:${index}`}>
      <TableCell>{row.area}</TableCell><TableCell>{row.item}</TableCell><TableCell>{row.change}</TableCell>
    </TableRow>)}</TableBody>
  </Table>;
}

export function ApplicationSourceImport({ disabled, readSnapshot, onApply }: Props) {
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
    };
  }, []);


  const replaceText = (value: string) => {
    epoch.current += 1;
    acceptedReview.current = null;
    setReviewed(null);
    setDiagnostics(null);
    busy.current = null;
    setOperation(null);
    raw.current = value;
    setText(value);
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
    if (file.size > maximumApplicationSourceImportBytes) {
      setMessage("The JSON source must be at most 2 MiB. Your existing input is preserved.");
      return;
    }
    busy.current = "reading";
    setOperation("reading");
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
      if (!parsed.success) { setMessage("The review could not be verified. What you typed is kept."); return; }
      const result = parsed.data;
      if (result.kind !== "available" && result.kind !== "validation_failed" && result.kind !== "identity_conflict") {
        setMessage(result.kind === "conflict" ? "The saved draft changed. Reopen explicitly before reviewing again."
          : result.kind === "invalid" ? "The source failed draft validation. What you typed is kept."
            : result.kind === "refused" ? "The current draft read was refused. What you typed is kept."
              : "The review is unavailable. What you typed is kept.");
        return;
      }
      if (!sameId(result.organizationId, snapshot.organizationId) || !sameId(result.rootId, snapshot.rootId) ||
        result.key !== snapshot.key || result.rootAlias !== snapshot.rootAlias ||
        result.draftRevision !== snapshot.draftRevision || result.savedSourceFingerprint !== snapshot.savedSourceFingerprint) {
        setMessage("The review does not match this source and draft. What you typed is kept.");
        return;
      }
      const submittedFingerprint = await candidateFingerprint(candidate.source);
      if (!responseIsCurrent()) return;
      if (result.candidateSourceFingerprint !== submittedFingerprint) {
        setMessage("The review does not match the submitted source. What you typed is kept.");
        return;
      }
      if (result.kind === "identity_conflict") {
        const names = result.conflicts.map((conflict) => `${conflict.kind.replaceAll("_", " ")} “${conflict.name}”`).join(", ");
        setMessage(`This file gives names already used in this application to different components: ${names}. Keep each existing component's original id when editing its name, or choose a name that has never been used. Your draft is unchanged.`);
        return;
      }
      if (result.kind === "validation_failed") {
        if (!result.validation.errors.every((error) => error.location === undefined ||
          (error.location.documentKind === "application" && error.location.documentKey === snapshot.key))) {
          setMessage("The validation locations do not match this Application. What you typed is kept.");
          return;
        }
        setDiagnostics({ snapshot, text: submittedText, epoch: requestEpoch, validation: result.validation });
        setMessage("The file has problems. Fix the issues listed below and check it again. What you typed is kept.");
        return;
      }
      if (result.source.key !== snapshot.key || result.source.root_alias !== snapshot.rootAlias ||
        canonicalJson(result.source) !== canonicalJson(candidate.source)) {
        setMessage("The review does not match this source and draft. What you typed is kept.");
        return;
      }
      const next: ReviewedSource = { snapshot, text: submittedText, epoch: requestEpoch,
        source: result.source, fingerprint: result.candidateSourceFingerprint };
      acceptedReview.current = next;
      setReviewed(next);
      setMessage("Checked. Review what will change below, then apply it to your draft.");
    } catch {
      if (responseIsCurrent())
        setMessage("The review could not be completed. What you typed is kept.");
    } finally {
      if (active.current && epoch.current === requestEpoch) {
        busy.current = null;
        setOperation(null);
      }
    }
  };

  const apply = async () => {
    const candidate = acceptedReview.current;
    const isCurrent = () => candidate !== null && active.current && !disabled && busy.current === null &&
      candidate.epoch === epoch.current && candidate.text === raw.current &&
      sameStudioApplicationSourceImportSnapshot(candidate.snapshot, readSnapshot());
    if (candidate === null || !isCurrent()) {
      setMessage("The check is out of date. What you typed is kept; check it again.");
      return;
    }
    if (canonicalJson(candidate.source) === canonicalJson(candidate.snapshot.source)) {
      setMessage("Your draft already matches this file. Nothing was changed.");
      return;
    }
    if (!await confirm({
      title: "Replace the draft with the imported file?",
      description: "The imported file replaces your current draft. Undo brings your draft back.",
      confirmLabel: "Replace the draft",
    })) return;
    if (!isCurrent()) { setMessage("The draft changed, so nothing was replaced."); return; }
    const result = onApply(candidate.snapshot, candidate.source);
    if (result === "applied") {
      replaceText("");
      setMessage("Imported. Your draft is the imported file now.");
    } else setMessage(result === "unchanged" ? "Your draft already matches this file. Nothing was changed."
      : "The editor changed. What you typed is kept; review again.");
  };

  return <section className="space-y-3 rounded-xl border bg-card text-card-foreground border-border p-4" aria-label="Import an application file" aria-busy={operation !== null}>
    <h3 className="font-semibold">Import an application file</h3>
    <p>Choose an exported application file, or paste its contents (up to 2 MiB). It must be for this same application.
      You see what would change before anything is replaced. Importing does not publish or install anything.</p>
    <Button type="button" variant="outline" disabled={disabled || operation !== null} onClick={() => {
      const snapshot = readSnapshot();
      if (snapshot === null) return;
      // Export the authored document verbatim: ids own identities, names are mutable aliases.
      const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot.source, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${snapshot.key}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }}>Export source</Button>
    <p className="text-sm text-muted-foreground">When changing component names in the file, keep their original ids.</p>
    <StudioField label="Application file">
      {(control) => <Input {...control} ref={fileInput} type="file" accept=".json,application/json" disabled={disabled}
        onChange={(event) => { void readFile(event); }} />}
    </StudioField>
    <StudioField label="Or paste the file contents">
      {(control) => <Textarea {...control} className={`${inputClass} min-h-48 font-mono text-sm`} value={text} disabled={disabled}
        onChange={(event) => {
          if (disabled || readSnapshot() === null) return;
          replaceText(event.target.value);
          setMessage("The file changed. Check it again before replacing the draft.");
        }} />}
    </StudioField>
    {reviewed !== null && <div className="space-y-2">
      <p>Replacing the draft replaces everything in it, including permissions, access groups, pages and flows.
        Checking the file does not decide whether it can be published.</p>
      <SourceChangeTable current={reviewed.snapshot.source} next={reviewed.source} />
      <TechnicalDetails title="View source">
        <p className="break-all">Fingerprint of the file: <code>{reviewed.fingerprint}</code></p>
        <ViewSource value={reviewed.snapshot.source} title="Current draft" />
        <ViewSource value={reviewed.source} title="Imported file" />
      </TechnicalDetails>
    </div>}
    {diagnosticsCurrent && diagnostics !== null && <div role="status" aria-live="polite" className="space-y-2">
      <h3 className="font-semibold">Problems found in the file</h3>
      <ul className="space-y-3">
        {diagnostics.validation.errors.map((error, index) => <li key={`${error.code}:${index}`}>
          <p className="font-medium">{error.message}</p>
          <p>{error.guidance}</p>
          <TechnicalDetails>
            <p className="break-all">Where: {error.location?.documentKey ?? diagnostics.snapshot.key}
              {error.location?.segments.map((segment, segmentIndex) =>
                <span key={segmentIndex}> · {segment.kind}: {segment.key}</span>)}</p>
            <p>Code: <code>{error.code}</code></p>
          </TechnicalDetails>
        </li>)}
      </ul>
    </div>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={disabled || operation !== null || text.length === 0}
        onClick={() => { void review(); }}>Check the file</Button>
      <Button type="button" disabled={disabled || operation !== null || reviewed === null}
        onClick={apply}>Replace the draft</Button>
      <Button type="button" disabled={text.length === 0 && operation === null}
        onClick={() => {
          replaceText("");
          if (fileInput.current !== null) fileInput.current.value = "";
          setMessage("Cleared. Your draft is unchanged.");
        }}>Clear</Button>
    </div>
    <p role="status" aria-live="polite">{message}</p>
    {confirmDialog}
  </section>;
}
