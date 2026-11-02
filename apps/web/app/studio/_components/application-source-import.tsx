"use client";
import {
  formatBytes,
  canonicalJson,
  sameId,
  summarizeSourceChange,
  type ApplicationSourceDocument,
  type DefinitionValidationResult,
} from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { cn } from "@vortex/ui/lib/utils";
import { StudioInspectorGroup, StudioSourceView } from "@vortex/ui/studio";
import { Icon } from "@vortex/ui";
import { Card, CardContent } from "@vortex/ui/components/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@vortex/ui/components/collapsible";
import { Spinner } from "@vortex/ui/components/spinner";
import { toast } from "@vortex/ui/components/sonner";
import { studioNotice } from "./studio-save-state";
import { Textarea } from "@vortex/ui/components/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vortex/ui/components/dialog";
import { StudioField } from "./studio-field";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vortex/ui/components/table";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";

import { useEffect, useRef, useState } from "react";
import { definitionLimitImportSize, definitionLimits } from "@vortex/platform/schema";
import { reviewStudioApplicationSource } from "../actions";
import {
  readStudioApplicationSourceImport,
  sameStudioApplicationSourceImportSnapshot,
  studioApplicationSourceReviewResultSchema,
  type StudioApplicationSourceImportSnapshot,
  type StudioSourceImportShowMe,
} from "../_lib/application-source-import";

// The import's notices replace one another: a refusal does not stay on screen through a later
// successful check or the replace.
let lastImportNotice: string | undefined;
const importNotice = (
  message: string,
  kind?: "success" | "error" | "info",
  action?: Readonly<{ label: string; onClick: () => void }>,
): void => {
  if (lastImportNotice !== undefined) toast.dismiss(lastImportNotice);
  const id = `studio-source-import-${crypto.randomUUID()}`;
  lastImportNotice = id;
  studioNotice(message, kind, undefined, { id, action });
};

type ReviewedSource = Readonly<{
  snapshot: StudioApplicationSourceImportSnapshot;
  text: string;
  epoch: number;
  source: ApplicationSourceDocument;
  fingerprint: string;
}>;

type SourceDiagnostics = Readonly<{
  snapshot: StudioApplicationSourceImportSnapshot;
  text: string;
  epoch: number;
  validation: DefinitionValidationResult;
}>;

type Props = Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  readSnapshot: () => StudioApplicationSourceImportSnapshot | null;
  /** Opens the place a refusal names in the draft: absent when the draft has no such place. */
  onShowPlace: (
    source: ApplicationSourceDocument,
    place: StudioSourceImportShowMe,
  ) => (() => boolean) | undefined;
  onApply: (
    expected: StudioApplicationSourceImportSnapshot,
    source: ApplicationSourceDocument,
  ) => "applied" | "unchanged" | "stale";
}>;

const fingerprintSourceDocument = async (source: ApplicationSourceDocument): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(source)),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

/** What the imported file would change, by area and item name; the source itself is only under View source. */
function SourceChangeTable({
  current,
  next,
}: {
  current: ApplicationSourceDocument;
  next: ApplicationSourceDocument;
}) {
  const rows = summarizeSourceChange(current, next);
  if (rows.length === 0) return <p>The file matches your draft. Nothing would change.</p>;
  return (
    <div className="overflow-hidden rounded-xl border">
      <Table containerClassName="border-0">
        <TableHeader className="bg-muted/50 text-xs">
          <TableRow>
            <TableHead className="text-foreground">Area</TableHead>
            <TableHead className="text-foreground">Item</TableHead>
            <TableHead className="text-foreground">Change</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={`${row.area}:${row.item}:${index}`}>
              <TableCell>{row.area}</TableCell>
              <TableCell className="whitespace-normal wrap-anywhere">{row.item}</TableCell>
              <TableCell>{row.change}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function ApplicationSourceImport({
  open,
  onOpenChange,
  disabled,
  readSnapshot,
  onShowPlace,
  onApply,
}: Props) {
  const [confirm, confirmDialog] = useConfirm();
  const [text, setText] = useState("");
  const [operation, setOperation] = useState<"reading" | "reviewing" | null>(null);
  const [reviewed, setReviewed] = useState<ReviewedSource | null>(null);
  const [diagnostics, setDiagnostics] = useState<SourceDiagnostics | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
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
  const diagnosticsCurrent =
    diagnostics !== null &&
    active.current &&
    !disabled &&
    diagnostics.epoch === epoch.current &&
    diagnostics.text === raw.current &&
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

  const readFile = async (file: File | undefined) => {
    // The filename is only a browser input hint, never server provenance or a server path.
    const snapshot = readSnapshot();
    if (file === undefined || disabled || snapshot === null) return;
    const requestEpoch = ++epoch.current;
    acceptedReview.current = null;
    setReviewed(null);
    setDiagnostics(null);
    busy.current = null;
    setOperation(null);
    if (file.size > definitionLimits.sourceImportBytes) {
      importNotice(
        `The JSON source must be at most ${definitionLimitImportSize}. Your existing input is preserved.`,
        "error",
      );
      return;
    }
    busy.current = "reading";
    setOperation("reading");
    try {
      const value = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      if (!active.current || epoch.current !== requestEpoch) return;
      if (!sameStudioApplicationSourceImportSnapshot(snapshot, readSnapshot())) {
        importNotice(
          "The editor changed while reading. Your previous input is preserved.",
          "error",
        );
        return;
      }
      if (
        value.length > definitionLimits.sourceImportBytes ||
        new TextEncoder().encode(value).byteLength > definitionLimits.sourceImportBytes
      ) {
        importNotice(
          `The JSON source must be at most ${definitionLimitImportSize}. Your previous input is preserved.`,
          "error",
        );
        return;
      }
      raw.current = value;
      setText(value);
      importNotice("File ready. Check it before replacing the draft.");
    } catch (error) {
      console.error("[studio] application import file could not be read", error);
      if (active.current && epoch.current === requestEpoch)
        importNotice(
          "The selected file could not be read. Your previous input is preserved.",
          "error",
        );
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
    const candidate = readStudioApplicationSourceImport(
      submittedText,
      snapshot.key,
      snapshot.rootAlias,
    );
    if (candidate.kind !== "valid") {
      importNotice(
        candidate.message,
        "error",
        // The problem is in the file; the link opens the same place in the draft, when it has one.
        candidate.showMe !== undefined &&
          onShowPlace(snapshot.source, candidate.showMe) !== undefined
          ? {
              label: "Show me",
              onClick: () => {
                if (onShowPlace(snapshot.source, candidate.showMe!)?.() === true)
                  onOpenChange(false);
              },
            }
          : undefined,
      );
      return;
    }
    busy.current = "reviewing";
    setOperation("reviewing");
    const responseIsCurrent = () =>
      active.current &&
      !currentDisabled.current &&
      requestEpoch === epoch.current &&
      raw.current === submittedText &&
      sameStudioApplicationSourceImportSnapshot(snapshot, currentSnapshotReader.current());
    try {
      const response = await reviewStudioApplicationSource(snapshot.organizationId, {
        rootId: snapshot.rootId,
        expectedDraftRevision: snapshot.draftRevision,
        expectedSavedSourceFingerprint: snapshot.savedSourceFingerprint,
        source: candidate.source,
      });
      if (
        !active.current ||
        currentDisabled.current ||
        requestEpoch !== epoch.current ||
        raw.current !== submittedText
      )
        return;
      if (!responseIsCurrent()) {
        importNotice("The editor changed. Review again; your JSON input is preserved.", "error");
        return;
      }
      const parsed = studioApplicationSourceReviewResultSchema.safeParse(response);
      if (!parsed.success) {
        console.error("[studio] invalid application source review response", parsed.error);
        importNotice("The review could not be verified. What you typed is kept.", "error");
        return;
      }
      const result = parsed.data;
      if (
        result.kind !== "available" &&
        result.kind !== "validation_failed" &&
        result.kind !== "identity_conflict"
      ) {
        importNotice(
          result.kind === "conflict"
            ? "The saved draft changed. Reopen explicitly before reviewing again."
            : result.kind === "invalid"
              ? "The source failed draft validation. What you typed is kept."
              : result.kind === "refused"
                ? "The current draft read was refused. What you typed is kept."
                : "The review is unavailable. What you typed is kept.",
          "error",
        );
        return;
      }
      if (
        !sameId(result.organizationId, snapshot.organizationId) ||
        !sameId(result.rootId, snapshot.rootId) ||
        result.key !== snapshot.key ||
        result.rootAlias !== snapshot.rootAlias ||
        result.draftRevision !== snapshot.draftRevision ||
        result.savedSourceFingerprint !== snapshot.savedSourceFingerprint
      ) {
        importNotice(
          "The review does not match this source and draft. What you typed is kept.",
          "error",
        );
        return;
      }
      const submittedFingerprint = await fingerprintSourceDocument(candidate.source);
      if (!responseIsCurrent()) return;
      if (result.candidateSourceFingerprint !== submittedFingerprint) {
        importNotice(
          "The review does not match the submitted source. What you typed is kept.",
          "error",
        );
        return;
      }
      if (result.kind === "identity_conflict") {
        const names = result.conflicts
          .map((conflict) => `${conflict.kind.replaceAll("_", " ")} “${conflict.name}”`)
          .join(", ");
        importNotice(
          `This file gives names already used in this application to different components: ${names}. Keep each existing component's original id when editing its name, or choose a name that has never been used. Your draft is unchanged.`,
          "error",
        );
        return;
      }
      if (result.kind === "validation_failed") {
        if (
          !result.validation.errors.every(
            (error) =>
              error.location === undefined ||
              (error.location.documentKind === "application" &&
                error.location.documentKey === snapshot.key),
          )
        ) {
          importNotice(
            "The validation locations do not match this Application. What you typed is kept.",
            "error",
          );
          return;
        }
        setDiagnostics({
          snapshot,
          text: submittedText,
          epoch: requestEpoch,
          validation: result.validation,
        });
        importNotice(
          "The file has problems. Fix the issues listed below and check it again. What you typed is kept.",
          "error",
        );
        return;
      }
      if (
        result.source.key !== snapshot.key ||
        result.source.root_alias !== snapshot.rootAlias ||
        canonicalJson(result.source) !== canonicalJson(candidate.source)
      ) {
        importNotice(
          "The review does not match this source and draft. What you typed is kept.",
          "error",
        );
        return;
      }
      const next: ReviewedSource = {
        snapshot,
        text: submittedText,
        epoch: requestEpoch,
        source: result.source,
        fingerprint: result.candidateSourceFingerprint,
      };
      acceptedReview.current = next;
      setReviewed(next);
      importNotice("Checked. Review what will change below, then apply it to your draft.");
    } catch (error) {
      console.error("[studio] application source review failed", error);
      if (responseIsCurrent())
        importNotice("The review could not be completed. What you typed is kept.", "error");
    } finally {
      if (active.current && epoch.current === requestEpoch) {
        busy.current = null;
        setOperation(null);
      }
    }
  };

  const reviewedCurrent =
    reviewed !== null &&
    !disabled &&
    reviewed.epoch === epoch.current &&
    reviewed.text === raw.current &&
    sameStudioApplicationSourceImportSnapshot(reviewed.snapshot, readSnapshot());

  const apply = async () => {
    const candidate = acceptedReview.current;
    const isCurrent = () =>
      candidate !== null &&
      active.current &&
      !currentDisabled.current &&
      busy.current === null &&
      candidate.epoch === epoch.current &&
      candidate.text === raw.current &&
      sameStudioApplicationSourceImportSnapshot(
        candidate.snapshot,
        currentSnapshotReader.current(),
      );
    if (candidate === null || !isCurrent()) {
      importNotice("The check is out of date. What you typed is kept; check it again.", "error");
      return;
    }
    if (canonicalJson(candidate.source) === canonicalJson(candidate.snapshot.source)) {
      importNotice("Your draft already matches this file. Nothing was changed.");
      return;
    }
    if (
      !(await confirm({
        title: "Replace the draft with the imported file?",
        description: "The imported file replaces your current draft. Undo brings your draft back.",
        confirmLabel: "Replace the draft",
      }))
    )
      return;
    if (!isCurrent()) {
      importNotice("The draft changed, so nothing was replaced.", "error");
      return;
    }
    const result = onApply(candidate.snapshot, candidate.source);
    if (result === "applied") {
      replaceText("");
      onOpenChange(false);
      importNotice("Imported. Your draft is the imported file now.", "success");
    } else
      importNotice(
        result === "unchanged"
          ? "Your draft already matches this file. Nothing was changed."
          : "The editor changed. What you typed is kept; review again.",
      );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-4 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Replace draft from a file</DialogTitle>
          <DialogDescription>
            Check an application file, review the changes, then replace your draft.
          </DialogDescription>
        </DialogHeader>
        <div
          className="min-h-0 min-w-0 flex-1 space-y-6 overflow-y-auto text-sm"
          aria-busy={operation !== null}
        >
          <Card
            className={cn("border-2 border-dashed", dragging && "border-primary")}
            onDragOver={(event) => {
              event.preventDefault();
              if (!disabled) setDragging(true);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                setDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (disabled) return;
              if (event.dataTransfer.files.length !== 1) {
                importNotice("Choose one application file at a time.", "error");
                return;
              }
              void readFile(event.dataTransfer.files[0]);
            }}
          >
            <CardContent>
              {/* shadcn-exempt: hidden file input; the Button below opens it */}
              <input
                ref={fileInput}
                type="file"
                accept=".json,application/json"
                hidden
                disabled={disabled}
                aria-label="Application file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  void readFile(file);
                }}
              />
              <Button
                type="button"
                variant="ghost"
                disabled={disabled}
                onClick={() => fileInput.current?.click()}
                className="h-auto w-full flex-col gap-3 p-8 text-center whitespace-normal"
              >
                <Icon name="upload" className="size-8 text-muted-foreground" />
                <span className="font-medium">Drop an application file or browse</span>
                <span className="text-xs font-normal text-muted-foreground">
                  Up to {definitionLimitImportSize}, same application
                </span>
              </Button>
            </CardContent>
          </Card>
          {text !== "" && (
            <p className="text-sm text-muted-foreground">
              Source ready · {formatBytes(new TextEncoder().encode(text).byteLength)}
            </p>
          )}
          <Collapsible open={pasteOpen} onOpenChange={setPasteOpen}>
            <CollapsibleTrigger render={<Button variant="ghost" />}>
              <Icon name="chevron-down" />
              Paste instead
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <StudioField
                label="Application source"
                hint="Keep each component's original id when changing its name."
              >
                {(control) => (
                  <div className="font-mono">
                    <Textarea
                      {...control}
                      className="min-h-48"
                      value={text}
                      disabled={disabled}
                      onChange={(event) => {
                        if (disabled || readSnapshot() === null) return;
                        replaceText(event.target.value);
                      }}
                    />
                  </div>
                )}
              </StudioField>
            </CollapsibleContent>
          </Collapsible>
          {reviewedCurrent && reviewed !== null && (
            <div className="space-y-2">
              <p>
                Replacing the draft replaces everything in it, including permissions, access groups,
                pages and flows. Checking the file does not decide whether it can be published.
              </p>
              <SourceChangeTable current={reviewed.snapshot.source} next={reviewed.source} />
            </div>
          )}
          {diagnosticsCurrent && diagnostics !== null && (
            <div role="status" aria-live="polite" className="space-y-2">
              <h3 className="font-semibold">Problems found in the file</h3>
              <ul className="space-y-3">
                {diagnostics.validation.errors.map((error, index) => (
                  <li key={`${error.code}:${index}`}>
                    <p className="font-medium">{error.message}</p>
                    <p>{error.guidance}</p>
                    <StudioInspectorGroup title="Details" defaultOpen={false} persist={false}>
                      <p className="break-all">
                        Where: {error.location?.documentKey ?? diagnostics.snapshot.key}
                        {error.location?.segments.map((segment, segmentIndex) => (
                          <span key={segmentIndex}>
                            {" "}
                            · {segment.kind}: {segment.key}
                          </span>
                        ))}
                      </p>
                      <p>
                        Code: <code>{error.code}</code>
                      </p>
                    </StudioInspectorGroup>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p role="status" aria-live="polite" className="sr-only">
            {operation === "reading"
              ? "Reading file"
              : operation === "reviewing"
                ? "Checking file"
                : ""}
          </p>
          {reviewedCurrent && reviewed !== null && (
            <StudioInspectorGroup title="Details" defaultOpen={false} persist={false}>
              <p className="break-all">
                Fingerprint of the file: <code>{reviewed.fingerprint}</code>
              </p>
              <StudioSourceView value={reviewed.snapshot.source} title="Current draft" />
              <StudioSourceView value={reviewed.source} title="Imported file" />
            </StudioInspectorGroup>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={text.length === 0 && operation === null}
            onClick={() => {
              replaceText("");
              if (fileInput.current !== null) fileInput.current.value = "";
              importNotice("Cleared. Your draft is unchanged.");
            }}
          >
            Clear
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || operation !== null || text.length === 0}
            onClick={() => {
              void review();
            }}
          >
            {operation !== null && <Spinner />}
            {operation === "reading"
              ? "Reading file…"
              : operation === "reviewing"
                ? "Checking file…"
                : "Check the file"}
          </Button>
          <Button
            type="button"
            disabled={disabled || operation !== null || !reviewedCurrent}
            onClick={apply}
          >
            Replace the draft
          </Button>
        </DialogFooter>
        {confirmDialog}
      </DialogContent>
    </Dialog>
  );
}
