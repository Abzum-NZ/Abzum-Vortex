"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  applicationSourceDocumentSchema,
  canonicalJson,
  describeFailure,
  prepareDefinitionPublicationResultSchema,
  publishDefinitionResultSchema,
  type DefinitionPublicationConfirmation,
} from "@vortex/platform/schema";
import { prepareStudioApplicationPublication, publishStudioApplication } from "../actions";
import { previewStudioApplication } from "../preview-actions";
import {
  sameStudioApplicationSourceImportSnapshot,
  type StudioApplicationSourceImportSnapshot,
} from "../_lib/application-source-import";
import type { SavedDraftContext, StudioPublicationOutcome } from "./application-draft-agent-tools";
import type { ApplicationSourceImport as ApplicationSourceImportComponent } from "./application-source-import";
import { previewProblem, unavailableMessage } from "./studio-refusal-messages";
import { describeStudioCompileFailure } from "../_lib/studio-compile-failure";
import { studioReleasesSections, type StudioReleasesSection } from "./studio-rail-tabs";
import type { StudioDraft } from "./use-studio-draft";
import { studioNotice } from "./studio-save-state";
import { toast } from "@vortex/ui/components/sonner";
import { useStudioTabVisited } from "./studio-frame";
import type { StudioCompositionContext } from "@vortex/ui/studio";
import { studioDataEdit } from "../_lib/studio-data-model";
import { deferredStudioPart } from "./studio-deferred-part";
import { useIntentPreload } from "../_lib/use-intent-preload";

// What Publish and the Releases tab show loads when they are first wanted: the top bar's Publish
// needs only this hook's state at first paint.
const StudioReleasesPanel = deferredStudioPart(
  () => import("./studio-releases-panel").then((module) => module.StudioReleasesPanel),
  "releases panel",
);
const StudioPublishDialog = deferredStudioPart(
  () => import("./studio-publish-dialog").then((module) => module.StudioPublishDialog),
  "publish window",
);
const StudioFieldPageReview = deferredStudioPart(
  () => import("./studio-field-page-review").then((module) => module.StudioFieldPageReview),
  "review of the new fields",
);
const preloadReleasesPanel = () => import("./studio-releases-panel");
const preloadPublishDialog = () =>
  Promise.all([import("./studio-publish-dialog"), import("./studio-field-page-review")]);

const ApplicationSourceImport = dynamic(
  () => import("./application-source-import").then((module) => module.ApplicationSourceImport),
  { loading: () => <p role="status">Loading source import…</p> },
);
const StandardPageAdoption = dynamic(
  () => import("./standard-page-adoption").then((module) => module.StandardPageAdoption),
  { loading: () => <p role="status">Loading page adoption…</p> },
);
const StudioHistoryTab = dynamic(
  () => import("./studio-history-tab").then((module) => module.StudioHistoryTab),
  { loading: () => <p role="status">Loading the published versions…</p> },
);

/** The saved revision a publication was prepared for; any edit or reload makes it out of date. */
type PublicationSnapshot = Readonly<{
  rootId: string;
  draftRevision: number;
  sourceFingerprint: string;
  source: object;
  lifetime: number;
}>;
type PreparedPublication = Readonly<{
  confirmation: DefinitionPublicationConfirmation;
  componentLabels: readonly Readonly<{ componentId: string; label: string }>[];
  addedFields: readonly string[];
  snapshot: PublicationSnapshot;
}>;
const sameSnapshot = (left: PublicationSnapshot, right: PublicationSnapshot | null) =>
  right !== null &&
  left.rootId === right.rootId &&
  left.draftRevision === right.draftRevision &&
  left.sourceFingerprint === right.sourceFingerprint &&
  left.source === right.source &&
  left.lifetime === right.lifetime;

/** Words a person can act on for a publication the platform declined. */
const publicationProblemText = (
  kind: string,
  reason: string | undefined,
  blockAlias?: string,
  compileProblem?: string,
  sentence?: string,
): string => {
  if (reason === "identity_retired" && sentence !== undefined) return sentence;
  // A compilation refusal names what it is about (the field, query or block) so it can be fixed.
  if (reason?.startsWith("compilation_") === true) {
    // A rule with its own business sentence (a Records table feature check) says it as Studio does.
    if (sentence !== undefined)
      return `This draft cannot be published: ${sentence} Change it and try again.`;
    if (compileProblem !== undefined)
      return `This draft does not compile, so it cannot be published. ${compileProblem} Then try again.`;
    const rule = reason
      .slice("compilation_".length)
      .replace(/^vortex.definition./u, "")
      .replaceAll("_", " ");
    return `This draft does not compile, so it cannot be published: ${rule}${blockAlias === undefined ? "" : ` (block ${blockAlias})`}. Change it and try again.`;
  }
  switch (kind) {
    case "no_change":
      return "Nothing has changed since the last published version, so there is nothing new to publish.";
    case "dependency_unavailable":
      return "A module or component this application needs is not available in a compatible version. Publish or install it first.";
    case "conflict":
      return "The draft changed while this window was open. Close it and open Publish again.";
    case "temporarily_unavailable":
      return "Publishing could not be confirmed. It may have gone through: check Releases before trying again.";
    default:
      return unavailableMessage(kind === "refused" ? "refused" : "temporarily_unavailable", reason);
  }
};

/**
 * The Releases tab and what acts on the saved draft as a whole: Publish (prepare, then publish the
 * prepared release), Preview, the published versions with restore, page adoption and import. Each
 * of them first lets the latest edits finish saving, because only the saved draft is published,
 * previewed or restored over.
 */
export function useStudioReleasesTab({
  draft,
  hidden,
  initialSection,
  appStoreHref,
  compositionContext,
}: Readonly<{
  draft: StudioDraft;
  compositionContext: StudioCompositionContext;
  hidden: boolean;
  /** The App Store, where a published version is installed or upgraded to; absent when its address is unknown. */
  appStoreHref: string | undefined;
  initialSection: StudioReleasesSection;
}>) {
  const { organizationId, history } = draft;
  useIntentPreload(preloadReleasesPanel, "#studio-rail-releases");
  useIntentPreload(preloadPublishDialog, "#studio-publish");
  const latest = useRef(draft);
  latest.current = draft;
  const [section, setSection] = useState<StudioReleasesSection>(initialSection);
  const importVisited = useStudioTabVisited(!hidden && section === "import");
  const panelVisited = useStudioTabVisited(!hidden);
  const [publishOpen, setPublishOpen] = useState(false);
  const dialogVisited = useStudioTabVisited(publishOpen);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState("");
  const [preparing, setPreparing] = useState(false);
  // A new version closes Publish, is named in a toast, and reloads the history.
  const [historyGeneration, setHistoryGeneration] = useState(0);
  const [prepared, setPreparedState] = useState<PreparedPublication | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  // The agent tools read the confirmation between calls, so the latest value is kept outside render state.
  const preparedRef = useRef<PreparedPublication | null>(null);
  const setPrepared = useCallback((next: PreparedPublication | null) => {
    preparedRef.current = next;
    setPreparedState(next);
  }, []);
  const request = useRef<{ cancelled: boolean } | null>(null);

  /** The saved draft, when it is exactly what the workspace shows: nothing waiting to be saved and nothing held. */
  const readSnapshot = useCallback((): PublicationSnapshot | null => {
    const current = latest.current;
    const state = history.getState();
    if (
      !current.isActive() ||
      current.blockedReason() !== undefined ||
      state.isDirty ||
      state.isSaving ||
      current.readSaved().rootId !== state.rootId ||
      current.readSaved().draftRevision !== state.draftRevision
    )
      return null;
    return {
      rootId: state.rootId,
      draftRevision: state.draftRevision,
      sourceFingerprint: current.readSaved().sourceFingerprint,
      source: state.source,
      lifetime: current.lifetime,
    };
  }, [history]);

  // A prepared publication is for one saved revision: an edit, an undo or a reload makes it out of date.
  useEffect(() => {
    if (preparedRef.current !== null && !sameSnapshot(preparedRef.current.snapshot, readSnapshot()))
      setPrepared(null);
  }, [draft.state, draft.saved, draft.lifetime, readSnapshot, setPrepared]);

  /** A flow refusal the platform reported when publishing, in the words Studio shows for it. */
  const flowRefusalOf = (
    result: Readonly<{ reason?: string; flowKey?: string; taskId?: string; family?: string }>,
  ): string | undefined =>
    result.flowKey === undefined || result.reason === undefined
      ? undefined
      : describeStudioCompileFailure(
          {
            reasonCode: result.reason.slice("compilation_".length),
            family: result.family ?? "unknown",
            flowKey: result.flowKey,
            ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
          },
          latest.current.parsed(latest.current.view.source),
        ).message;

  /** The saved draft's compile refusal in words, when the workspace's compile is of this revision. */
  const compileProblemOf = (draftRevision: number): string | undefined => {
    const view = latest.current.view;
    return view.failure === null || view.draftRevision !== draftRevision
      ? undefined
      : describeStudioCompileFailure(view.failure, latest.current.parsed(view.source)).message;
  };

  const requestPublication = async (
    mode: "prepare" | "publish",
    suppliedNote?: string,
  ): Promise<StudioPublicationOutcome> => {
    if (draft.isHeld("publication") || latest.current.blockedReason() !== undefined)
      return { kind: "not_started", reason: "busy" };
    if (!(await latest.current.flush())) return { kind: "not_started", reason: "not_saved" };
    const snapshot = readSnapshot();
    if (snapshot === null) return { kind: "not_started", reason: "not_saved" };
    const confirmed = preparedRef.current;
    const releaseNote = (suppliedNote ?? note).trim();
    if (
      mode === "publish" &&
      (confirmed === null ||
        releaseNote.length < 1 ||
        releaseNote.length > 2000 ||
        !sameSnapshot(confirmed.snapshot, snapshot))
    ) {
      setPrepared(null);
      setProblem("Check what will be published again and add a short note about what changed.");
      return {
        kind: "not_started",
        reason:
          confirmed === null || (releaseNote.length >= 1 && releaseNote.length <= 2000)
            ? "not_prepared"
            : "release_note_invalid",
      };
    }
    const ticket = { cancelled: false };
    request.current = ticket;
    latest.current.hold("publication", true);
    setPrepared(null);
    setProblem("");
    if (mode === "prepare") setPreparing(true);
    const superseded = () =>
      !latest.current.isActive() ||
      ticket.cancelled ||
      request.current !== ticket ||
      latest.current.lifetime !== snapshot.lifetime;
    try {
      if (mode === "prepare") {
        const result = await prepareStudioApplicationPublication(organizationId, {
          rootId: snapshot.rootId,
          expectedDraftRevision: snapshot.draftRevision,
        });
        if (superseded()) return { kind: "discarded" };
        const parsed =
          result.kind === "available"
            ? prepareDefinitionPublicationResultSchema.safeParse(result.preparation)
            : null;
        if (
          parsed?.success &&
          parsed.data.confirmation.rootId === snapshot.rootId &&
          parsed.data.confirmation.expectedDraftRevision === snapshot.draftRevision &&
          parsed.data.confirmation.sourceFingerprint === snapshot.sourceFingerprint
        ) {
          // A workspace opened on Releases or an unselected Structure page has no block catalogue.
          // Read the existing authoring resources before judging where its new fields can go.
          if (
            parsed.data.addedFields.length > 0 &&
            latest.current.readCatalogue().releases.length === 0
          ) {
            const resources = await latest.current.loadAuthoringResources();
            if (superseded()) return { kind: "discarded" };
            if (resources === null) {
              setProblem(
                "The pages could not be checked for new fields. Close this window and try again.",
              );
              return { kind: "unverified" };
            }
          }
          setPrepared({
            confirmation: parsed.data.confirmation,
            componentLabels: parsed.data.componentLabels,
            addedFields: parsed.data.addedFields,
            snapshot,
          });
          return { kind: "prepared", confirmation: parsed.data.confirmation };
        }
        if (result.kind === "available") {
          console.error(
            "[studio] publication preparation did not match the saved draft: STUDIO_PUBLICATION_PREPARATION_MISMATCH",
          );
          setProblem(
            "The summary did not match the saved draft, so nothing can be published from it. Close this window and try again.",
          );
          return { kind: "unverified" };
        }
        setProblem(
          publicationProblemText(
            result.kind,
            result.reason,
            "blockAlias" in result ? result.blockAlias : undefined,
            flowRefusalOf(result) ?? compileProblemOf(snapshot.draftRevision),
            "sentence" in result ? result.sentence : undefined,
          ),
        );
        return { kind: "declined", result: result.kind, reason: result.reason };
      }
      const confirmation = confirmed!.confirmation;
      const result = await publishStudioApplication(organizationId, { confirmation, releaseNote });
      if (superseded()) return { kind: "discarded" };
      const parsed =
        result.kind === "available"
          ? publishDefinitionResultSchema.safeParse(result.publication)
          : null;
      if (
        parsed?.success &&
        parsed.data.rootId === confirmation.rootId &&
        parsed.data.releaseRevision === confirmation.expectedDraftRevision &&
        parsed.data.releaseVersion === confirmation.assignedVersion &&
        parsed.data.contentFingerprint === confirmation.contentFingerprint &&
        parsed.data.resolutionFingerprint === confirmation.resolutionFingerprint &&
        canonicalJson(parsed.data.dependencyManifest) ===
          canonicalJson(confirmation.dependencyManifest)
      ) {
        studioNotice(
          `Published version ${parsed.data.releaseVersion}`,
          "success",
          appStoreHref === undefined ? undefined : { label: "Open App Store", href: appStoreHref },
        );
        setHistoryGeneration((generation) => generation + 1);
        closePublish(false);
        return { kind: "published", publication: parsed.data };
      }
      if (result.kind === "available") {
        console.error(
          "[studio] publication result did not match the confirmation: STUDIO_PUBLICATION_RESULT_MISMATCH",
        );
        setProblem(publicationProblemText("temporarily_unavailable", undefined));
        return { kind: "unverified" };
      }
      setProblem(
        publicationProblemText(
          result.kind,
          result.reason,
          "blockAlias" in result ? result.blockAlias : undefined,
          flowRefusalOf(result) ?? compileProblemOf(snapshot.draftRevision),
          "sentence" in result ? result.sentence : undefined,
        ),
      );
      // A transient failure of the append may still have completed.
      return result.kind === "temporarily_unavailable"
        ? { kind: "unverified" }
        : { kind: "declined", result: result.kind, reason: result.reason };
    } catch (error) {
      console.error(`[studio] publication ${mode} request failed: ${describeFailure(error)}`);
      if (!superseded())
        setProblem(
          mode === "prepare"
            ? "The platform could not read what will be published. Try again in a moment."
            : publicationProblemText("temporarily_unavailable", undefined),
        );
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
  const openPreview = () => {
    if (previewPending) return;
    const previewTab = window.open("", "_blank");
    setPreviewPending(true);
    const starting = (async () => {
      let problem = "The preview could not be started. Your changes are kept.";
      try {
        if (!(await latest.current.flush())) {
          problem =
            "Your latest change is not saved. Open the save-state chip to resolve it, then try Preview again.";
          throw new Error(problem);
        }
        const state = history.getState();
        const result = await previewStudioApplication(organizationId, {
          rootId: state.rootId,
          draftRevision: state.draftRevision,
        });
        if (result.kind !== "provisioned") {
          problem = previewProblem(result);
          throw new Error(problem);
        }
        if (previewTab !== null && !previewTab.closed) previewTab.location.href = result.href;
        return result.href;
      } catch (error) {
        console.error("[studio] the preview could not be started", describeFailure(error));
        previewTab?.close();
        throw new Error(problem);
      } finally {
        if (latest.current.isActive()) setPreviewPending(false);
      }
    })();
    toast.promise(starting, {
      loading: "Preview is starting…",
      success: (href) => ({
        message: "Preview ready",
        action: {
          label: "Open",
          onClick: () => {
            window.open(href, "_blank", "noopener");
          },
        },
      }),
      error: (error: unknown) => ({
        message: "Preview could not start",
        duration: Infinity,
        description:
          error instanceof Error ? error.message : "Your changes are kept. Try Preview again.",
      }),
    });
  };

  /** The saved draft the agent's preview runs; null while edits are being saved or a request holds the draft. */
  const readSavedDraft = useCallback((): SavedDraftContext | null => {
    const snapshot = readSnapshot();
    return snapshot === null
      ? null
      : {
          organizationId,
          rootId: snapshot.rootId,
          draftRevision: snapshot.draftRevision,
          source: history.getState().source,
        };
  }, [readSnapshot, organizationId, history]);

  // Import replaces the draft with a reviewed file; the review is against the saved draft.
  const readImportSnapshot = (): StudioApplicationSourceImportSnapshot | null => {
    const current = latest.current;
    const state = history.getState();
    if (
      !current.isActive() ||
      current.blockedReason() !== undefined ||
      state.isSaving ||
      current.readSaved().draftRevision !== state.draftRevision
    )
      return null;
    return {
      organizationId,
      rootId: state.rootId,
      key: current.readSaved().key,
      rootAlias: state.source.root_alias,
      draftRevision: state.draftRevision,
      savedSourceFingerprint: current.readSaved().sourceFingerprint,
      source: state.source,
      localLifetime: current.lifetime,
    };
  };
  const applyImport: Parameters<typeof ApplicationSourceImportComponent>[0]["onApply"] = (
    expected,
    candidate,
  ) => {
    if (!sameStudioApplicationSourceImportSnapshot(expected, readImportSnapshot())) return "stale";
    const parsed = applicationSourceDocumentSchema.safeParse(candidate);
    if (
      !parsed.success ||
      parsed.data.key !== expected.key ||
      parsed.data.root_alias !== expected.rootAlias
    )
      return "stale";
    const outcome = draft.run(() => ({ kind: "edit", source: parsed.data, result: true }), {
      expected: expected.source,
    });
    if (outcome.kind === "blocked") return "stale";
    if (!outcome.changed) return "unchanged";
    return "applied";
  };

  // Restoring and adopting write the saved draft on the server, so they wait for the latest edits to be saved.
  const savedWait =
    draft.status.kind === "saved"
      ? undefined
      : draft.status.kind === "saving"
        ? "Wait a moment: your latest change is being saved."
        : "Your latest change is not saved. Resolve the message at the top first.";
  const restoreBlocked = draft.locked
    ? "Wait for the workspace to finish loading or publishing."
    : savedWait;

  const panel = panelVisited ? (
    <StudioReleasesPanel hidden={hidden} section={section} onSection={setSection} />
  ) : null;
  const centre: ReactNode = (
    <div className="mx-auto max-w-4xl px-8 py-6 text-foreground">
      {!hidden && section === "history" && (
        <StudioHistoryTab
          key={historyGeneration}
          organizationId={organizationId}
          rootId={draft.state.rootId}
          savedRevision={draft.saved.draftRevision}
          restoreBlocked={restoreBlocked}
          hold={(on) => draft.hold("restoring", on)}
          onRestored={(restored) => {
            void draft
              .reload()
              .then((loaded) =>
                studioNotice(
                  loaded
                    ? restored
                    : "The version was restored, but the restored draft could not be loaded here. Reload Studio to see it.",
                  loaded ? "success" : "error",
                ),
              );
          }}
        />
      )}
      {!hidden && section === "page-adoption" && (
        <StandardPageAdoption
          organizationId={organizationId}
          rootId={draft.state.rootId}
          disabledReason={restoreBlocked}
          hold={(on) => draft.hold("restoring", on)}
          onSaved={() => {
            void draft.reload().then((loaded) => {
              if (!loaded)
                studioNotice(
                  "Your choice was saved, but the draft could not be loaded here. Reload Studio to see it.",
                  "error",
                );
            });
          }}
        />
      )}
      {/* The import keeps what was pasted while another section or tab is open. */}
      {importVisited && (
        <section hidden={hidden || section !== "import"} aria-label="Import from source">
          <ApplicationSourceImport
            key={draft.lifetime}
            disabled={draft.locked}
            readSnapshot={readImportSnapshot}
            onApply={applyImport}
          />
        </section>
      )}
    </div>
  );
  const title = studioReleasesSections.find((entry) => entry.value === section)!.label;
  const notSaved =
    draft.status.kind === "conflict" || draft.status.kind === "refused" ? draft.status.message : "";
  const dialog = !dialogVisited ? null : (
    <StudioPublishDialog
      open={publishOpen}
      onOpenChange={closePublish}
      saving={draft.status.kind === "saving" || draft.status.kind === "failed"}
      notSaved={notSaved}
      canPrepare={readSnapshot() !== null}
      preparing={preparing}
      publishing={draft.isHeld("publication") && !preparing}
      prepared={prepared}
      revision={draft.state.draftRevision}
      pageReview={
        prepared === null ? null : (
          <StudioFieldPageReview
            addedFields={prepared.addedFields}
            context={compositionContext}
            disabled={draft.locked || preparing || draft.updatingCanvas}
            edit={studioDataEdit(draft)}
          />
        )
      }
      note={note}
      onNoteChange={setNote}
      problem={problem}
      onPrepare={() => {
        void requestPublication("prepare");
      }}
      onPublish={() => {
        void requestPublication("publish");
      }}
    />
  );

  return {
    panel,
    centre,
    title,
    dialog,
    openPublish,
    openPreview: () => {
      void openPreview();
    },
    previewPending,
    agent: {
      readPreparedConfirmation: () => preparedRef.current?.confirmation,
      prepare: () => requestPublication("prepare"),
      publish: (releaseNote: string) => requestPublication("publish", releaseNote),
      readSavedDraft,
    },
  };
}
