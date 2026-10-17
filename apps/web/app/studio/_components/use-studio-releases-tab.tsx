"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  applicationSourceDocumentSchema, canonicalJson, describeFailure, prepareDefinitionPublicationResultSchema, publishDefinitionResultSchema,
  type DefinitionPublicationConfirmation, type PublishDefinitionResult,
} from "@vortex/platform/schema";
import { prepareStudioApplicationPublication, publishStudioApplication } from "../actions";
import { previewStudioApplication } from "../preview-actions";
import { sameStudioApplicationSourceImportSnapshot, type StudioApplicationSourceImportSnapshot } from "../_lib/application-source-import";
import type { SavedDraftContext, StudioPublicationOutcome } from "./application-draft-agent-tools";
import { ApplicationSourceImport } from "./application-source-import";
import { StandardPageAdoption } from "./standard-page-adoption";
import { StudioHistoryTab } from "./studio-history-tab";
import { StudioPublishDialog } from "./studio-publish-dialog";
import { previewProblem, unavailableMessage } from "./studio-refusal-messages";
import { StudioReleasesPanel } from "./studio-releases-panel";
import { studioReleasesSections, type StudioReleasesSection } from "./studio-rail-tabs";
import type { StudioDraft } from "./use-studio-draft";

/** The saved revision a publication was prepared for; any edit or reload makes it out of date. */
type PublicationSnapshot = Readonly<{
  rootId: string; draftRevision: number; sourceFingerprint: string; source: object; lifetime: number;
}>;
type PreparedPublication = Readonly<{
  confirmation: DefinitionPublicationConfirmation;
  componentLabels: readonly Readonly<{ componentId: string; label: string }>[];
  snapshot: PublicationSnapshot;
}>;
const sameSnapshot = (left: PublicationSnapshot, right: PublicationSnapshot | null) => right !== null &&
  left.rootId === right.rootId && left.draftRevision === right.draftRevision && left.sourceFingerprint === right.sourceFingerprint &&
  left.source === right.source && left.lifetime === right.lifetime;

/** Words a person can act on for a publication the platform declined. */
const publicationProblemText = (kind: string, reason: string | undefined, blockAlias?: string): string => {
  // A compilation refusal names its rule and, when it is about one, the block, so it can be fixed.
  if (reason?.startsWith("compilation_") === true) {
    const rule = reason.slice("compilation_".length).replace(/^vortex.definition./u, "").replaceAll("_", " ");
    return `This draft does not compile, so it cannot be published: ${rule}${blockAlias === undefined ? "" : ` (block ${blockAlias})`}. Change it and try again.`;
  }
  switch (kind) {
    case "no_change": return "Nothing has changed since the last published version, so there is nothing new to publish.";
    case "dependency_unavailable":
      return "A module or component this application needs is not available in a compatible version. Publish or install it first.";
    case "conflict": return "The draft changed while this window was open. Close it and open Publish again.";
    case "temporarily_unavailable":
      return "Publishing could not be confirmed. It may have gone through: check Releases before trying again.";
    default: return unavailableMessage(kind === "refused" ? "refused" : "temporarily_unavailable", reason);
  }
};

/**
 * The Releases tab and what acts on the saved draft as a whole: Publish (prepare, then publish the
 * prepared release), Preview, the published versions with restore, page adoption and import. Each
 * of them first lets the latest edits finish saving, because only the saved draft is published,
 * previewed or restored over.
 */
export function useStudioReleasesTab({ draft, hidden, initialSection, blocked }: Readonly<{
  draft: StudioDraft;
  hidden: boolean;
  initialSection: StudioReleasesSection;
  /** Why the saved draft cannot be published now (a canvas setting the platform refuses), or undefined. */
  blocked: string | undefined;
}>) {
  const { organizationId, history } = draft;
  const latest = useRef(draft);
  latest.current = draft;
  const [section, setSection] = useState<StudioReleasesSection>(initialSection);
  const [publishOpen, setPublishOpen] = useState(false);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [published, setPublished] = useState<PublishDefinitionResult | null>(null);
  const [prepared, setPreparedState] = useState<PreparedPublication | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [notice, setNotice] = useState("");
  // The agent tools read the confirmation between calls, so the latest value is kept outside render state.
  const preparedRef = useRef<PreparedPublication | null>(null);
  const setPrepared = useCallback((next: PreparedPublication | null) => { preparedRef.current = next; setPreparedState(next); }, []);
  const request = useRef<{ cancelled: boolean } | null>(null);

  /** The saved draft, when it is exactly what the workspace shows: nothing waiting to be saved and nothing held. */
  const readSnapshot = useCallback((): PublicationSnapshot | null => {
    const current = latest.current;
    const state = history.getState();
    if (!current.isActive() || current.blockedReason() !== undefined || state.isDirty || state.isSaving ||
      current.saved.rootId !== state.rootId || current.saved.draftRevision !== state.draftRevision) return null;
    return { rootId: state.rootId, draftRevision: state.draftRevision, sourceFingerprint: current.saved.sourceFingerprint,
      source: state.source, lifetime: current.lifetime };
  }, [history]);

  // A prepared publication is for one saved revision: an edit, an undo or a reload makes it out of date.
  useEffect(() => {
    if (preparedRef.current !== null && !sameSnapshot(preparedRef.current.snapshot, readSnapshot())) setPrepared(null);
  }, [draft.state, draft.saved, draft.lifetime, readSnapshot, setPrepared]);

  const requestPublication = async (mode: "prepare" | "publish", suppliedNote?: string): Promise<StudioPublicationOutcome> => {
    if (draft.isHeld("publication") || latest.current.blockedReason() !== undefined) return { kind: "not_started", reason: "busy" };
    if (!await latest.current.flush()) return { kind: "not_started", reason: "not_saved" };
    const snapshot = readSnapshot();
    if (snapshot === null) return { kind: "not_started", reason: "not_saved" };
    const confirmed = preparedRef.current;
    const releaseNote = (suppliedNote ?? note).trim();
    if (mode === "publish" && (confirmed === null || releaseNote.length < 1 || releaseNote.length > 2000 ||
      !sameSnapshot(confirmed.snapshot, snapshot))) {
      setPrepared(null);
      setProblem("Check what will be published again and add a short note about what changed.");
      return { kind: "not_started", reason: confirmed === null || releaseNote.length >= 1 && releaseNote.length <= 2000 ? "not_prepared" : "release_note_invalid" };
    }
    const ticket = { cancelled: false };
    request.current = ticket;
    latest.current.hold("publication", true);
    setPrepared(null);
    setProblem("");
    if (mode === "prepare") setPreparing(true);
    const superseded = () => !latest.current.isActive() || ticket.cancelled || request.current !== ticket ||
      latest.current.lifetime !== snapshot.lifetime;
    try {
      if (mode === "prepare") {
        const result = await prepareStudioApplicationPublication(organizationId, {
          rootId: snapshot.rootId, expectedDraftRevision: snapshot.draftRevision,
        });
        if (superseded()) return { kind: "discarded" };
        const parsed = result.kind === "available" ? prepareDefinitionPublicationResultSchema.safeParse(result.preparation) : null;
        if (parsed?.success && parsed.data.confirmation.rootId === snapshot.rootId &&
          parsed.data.confirmation.expectedDraftRevision === snapshot.draftRevision &&
          parsed.data.confirmation.sourceFingerprint === snapshot.sourceFingerprint) {
          setPrepared({ confirmation: parsed.data.confirmation, componentLabels: parsed.data.componentLabels, snapshot });
          return { kind: "prepared", confirmation: parsed.data.confirmation };
        }
        if (result.kind === "available") {
          console.error("[studio] publication preparation did not match the saved draft: STUDIO_PUBLICATION_PREPARATION_MISMATCH");
          setProblem("The summary did not match the saved draft, so nothing can be published from it. Close this window and try again.");
          return { kind: "unverified" };
        }
        setProblem(publicationProblemText(result.kind, result.reason, "blockAlias" in result ? result.blockAlias : undefined));
        return { kind: "declined", result: result.kind, reason: result.reason };
      }
      const confirmation = confirmed!.confirmation;
      const result = await publishStudioApplication(organizationId, { confirmation, releaseNote });
      if (superseded()) return { kind: "discarded" };
      const parsed = result.kind === "available" ? publishDefinitionResultSchema.safeParse(result.publication) : null;
      if (parsed?.success && parsed.data.rootId === confirmation.rootId &&
        parsed.data.releaseRevision === confirmation.expectedDraftRevision &&
        parsed.data.releaseVersion === confirmation.assignedVersion &&
        parsed.data.contentFingerprint === confirmation.contentFingerprint &&
        parsed.data.resolutionFingerprint === confirmation.resolutionFingerprint &&
        canonicalJson(parsed.data.dependencyManifest) === canonicalJson(confirmation.dependencyManifest)) {
        setPublished(parsed.data);
        return { kind: "published", publication: parsed.data };
      }
      if (result.kind === "available") {
        console.error("[studio] publication result did not match the confirmation: STUDIO_PUBLICATION_RESULT_MISMATCH");
        setProblem(publicationProblemText("temporarily_unavailable", undefined));
        return { kind: "unverified" };
      }
      setProblem(publicationProblemText(result.kind, result.reason, "blockAlias" in result ? result.blockAlias : undefined));
      // A transient failure of the append may still have completed.
      return result.kind === "temporarily_unavailable" ? { kind: "unverified" }
        : { kind: "declined", result: result.kind, reason: result.reason };
    } catch (error) {
      console.error(`[studio] publication ${mode} request failed: ${describeFailure(error)}`);
      if (!superseded())
        setProblem(mode === "prepare" ? "The platform could not read what will be published. Try again in a moment."
          : publicationProblemText("temporarily_unavailable", undefined));
      return { kind: "unverified" };
    } finally {
      // Cancellation never releases a potentially mutating request early or clears another owner.
      if (request.current === ticket) {
        request.current = null;
        latest.current.hold("publication", false);
        if (latest.current.isActive()) setPreparing(false);
      }
    }
  };

  const openPublish = () => {
    setProblem("");
    setPublished(null);
    setNote("");
    setPublishOpen(true);
    void latest.current.flush();
  };
  const closePublish = (open: boolean) => {
    if (open) return;
    setPrepared(null);
    if (request.current !== null) request.current.cancelled = true;
    setProblem("");
    setPublishOpen(false);
  };

  // Preview runs the saved draft as its own Application in a new tab. The tab is opened at once,
  // while the press still counts as the person's, and is closed if nothing runs.
  const openPreview = async () => {
    if (previewPending) return;
    const previewTab = window.open("", "_blank");
    setPreviewPending(true);
    try {
      if (!await latest.current.flush()) {
        previewTab?.close();
        setNotice("Your latest change is not saved, so there is nothing new to preview. See the message above.");
        return;
      }
      const state = history.getState();
      setNotice("Starting the preview of the saved draft…");
      const result = await previewStudioApplication(organizationId, { rootId: state.rootId, draftRevision: state.draftRevision });
      if (result.kind !== "provisioned") {
        previewTab?.close();
        setNotice(previewProblem(result));
        return;
      }
      if (previewTab === null) window.open(result.href, "_blank", "noopener");
      else previewTab.location.href = result.href;
      setNotice(`Preview of draft revision ${result.draftRevision} opened in a new tab.`);
    } catch (error) {
      console.error("[studio] the preview could not be started", describeFailure(error));
      previewTab?.close();
      setNotice("The preview could not be started. Your changes are kept.");
    } finally {
      if (latest.current.isActive()) setPreviewPending(false);
    }
  };

  /** The saved draft the agent's preview runs; null while edits are being saved or a request holds the draft. */
  const readSavedDraft = useCallback((): SavedDraftContext | null => {
    const snapshot = readSnapshot();
    return snapshot === null ? null
      : { organizationId, rootId: snapshot.rootId, draftRevision: snapshot.draftRevision, source: history.getState().source };
  }, [readSnapshot, organizationId, history]);

  // Import replaces the draft with a reviewed file; the review is against the saved draft.
  const readImportSnapshot = (): StudioApplicationSourceImportSnapshot | null => {
    const current = latest.current;
    const state = history.getState();
    if (!current.isActive() || current.blockedReason() !== undefined || state.isSaving ||
      current.saved.draftRevision !== state.draftRevision) return null;
    return { organizationId, rootId: state.rootId, key: current.saved.key, rootAlias: state.source.root_alias,
      draftRevision: state.draftRevision, savedSourceFingerprint: current.saved.sourceFingerprint,
      source: state.source, localLifetime: current.lifetime };
  };
  const applyImport: Parameters<typeof ApplicationSourceImport>[0]["onApply"] = (expected, candidate) => {
    if (!sameStudioApplicationSourceImportSnapshot(expected, readImportSnapshot())) return "stale";
    const parsed = applicationSourceDocumentSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.key !== expected.key || parsed.data.root_alias !== expected.rootAlias) return "stale";
    const outcome = draft.run(() => ({ kind: "edit", source: parsed.data, result: true }), { expected: expected.source });
    if (outcome.kind === "blocked") return "stale";
    if (!outcome.changed) return "unchanged";
    return "applied";
  };

  // Restoring and adopting write the saved draft on the server, so they wait for the latest edits to be saved.
  const savedWait = draft.status.kind === "saved" ? undefined
    : draft.status.kind === "saving" ? "Wait a moment: your latest change is being saved."
      : "Your latest change is not saved. Resolve the message at the top first.";
  const restoreBlocked = draft.locked ? "Wait for the workspace to finish loading or publishing." : savedWait;

  const panel = <StudioReleasesPanel hidden={hidden} section={section} onSection={setSection} savedStateLabel={draft.chip} />;
  const centre: ReactNode = <>
    {!hidden && section === "history" &&
      <StudioHistoryTab organizationId={organizationId} rootId={draft.state.rootId} savedRevision={draft.saved.draftRevision}
        restoreBlocked={restoreBlocked}
        onRestored={(restored) => { void draft.reload().then(() => setNotice(restored)); }} />}
    {!hidden && section === "page-adoption" &&
      <StandardPageAdoption organizationId={organizationId} rootId={draft.state.rootId}
        disabledReason={restoreBlocked} onSaved={() => { void draft.reload(); }} />}
    {/* The import keeps what was pasted while another section or tab is open. */}
    <section hidden={section !== "import"} aria-label="Import from source" className="space-y-3">
      <p className="text-sm text-muted-foreground">Replace the draft with a source document. This is for advanced use; the change is checked before it reaches your draft.</p>
      <ApplicationSourceImport key={draft.lifetime} disabled={draft.locked} readSnapshot={readImportSnapshot} onApply={applyImport} />
    </section>
  </>;
  const title = studioReleasesSections.find((entry) => entry.value === section)!.label;
  const notSaved = draft.status.kind === "conflict" || draft.status.kind === "refused" ? draft.status.message : "";
  const dialog = <StudioPublishDialog open={publishOpen} onOpenChange={closePublish}
    saving={draft.status.kind === "saving" || draft.status.kind === "failed"} notSaved={notSaved}
    canPrepare={readSnapshot() !== null && blocked === undefined} preparing={preparing}
    publishing={draft.isHeld("publication") && !preparing}
    prepared={prepared} note={note} onNoteChange={setNote}
    problem={blocked ?? problem} published={published}
    onPrepare={() => { void requestPublication("prepare"); }}
    onPublish={() => { void requestPublication("publish"); }} />;

  return {
    panel, centre, title, dialog, notice,
    openPublish, openPreview: () => { void openPreview(); }, previewPending,
    agent: {
      readPreparedConfirmation: () => preparedRef.current?.confirmation,
      prepare: () => requestPublication("prepare"),
      publish: (releaseNote: string) => requestPublication("publish", releaseNote),
      readSavedDraft,
    },
  };
}
