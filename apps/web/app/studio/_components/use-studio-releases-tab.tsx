"use client";
import dynamic from "next/dynamic";
import { NavigationLink } from "@vortex/ui/routing";
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
import { readApplicationReleaseStanding } from "../releases-actions";
import type { ApplicationReleaseStanding } from "../../_lib/application-release-adoption";
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
import { Button } from "@vortex/ui/components/button";
import { useStudioTabVisited } from "./studio-frame";
import type { StudioCompositionContext } from "@vortex/ui/studio";
import {
  studioRecordPageChecks,
  type StudioRecordPageCheck,
  type StudioStructureCommand,
  type StudioStructureResult,
} from "@vortex/ui/studio";
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
const StudioPageCheckReview = deferredStudioPart(
  () => import("./studio-page-check-review").then((module) => module.StudioPageCheckReview),
  "review of the record pages",
);
const preloadReleasesPanel = () => import("./studio-releases-panel");
const preloadPublishDialog = () =>
  Promise.all([
    import("./studio-publish-dialog"),
    import("./studio-field-page-review"),
    import("./studio-page-check-review"),
  ]);

const ApplicationSourceImport = dynamic(
  () => import("./application-source-import").then((module) => module.ApplicationSourceImport),
  { loading: () => <p role="status">Loading source import…</p> },
);
const StandardPageAdoption = dynamic(
  () => import("./standard-page-adoption").then((module) => module.StandardPageAdoption),
  { loading: () => <p role="status">Loading page adoption…</p> },
);
const StudioBackendRuns = dynamic(
  () => import("./studio-backend-runs").then((module) => module.StudioBackendRuns),
  { loading: () => <p role="status">Loading the back-end runs…</p> },
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
  flowProblem?: string,
): string => {
  if (reason === "identity_retired" && sentence !== undefined) return sentence;
  // A compilation refusal names what it is about (the field, query or block) so it can be fixed.
  if (reason?.startsWith("compilation_") === true) {
    if (flowProblem !== undefined)
      return `This draft cannot be published: ${flowProblem} Change it and try again.`;
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
 * Where the application stands in the builder's organisation, in plain words, with the App Store
 * page that installs or upgrades it. `published` names the version a Publish just created.
 */
const standingWords = (
  standing: ApplicationReleaseStanding,
  published?: string,
): Readonly<{ text: string; link?: Readonly<{ label: string; href: string }> }> => {
  const lead = published === undefined ? "" : `Published version ${published}. `;
  switch (standing.kind) {
    case "live":
      return {
        text: `${lead}Version ${standing.version} is live in your organisation.${standing.rolesWaiting ? " Role changes are waiting: accept them in the App Store." : ""}`,
        ...(standing.rolesWaiting
          ? { link: { label: "Open in the App Store", href: standing.appStoreHref } }
          : {}),
      };
    case "waiting":
      return {
        text: `${lead}Your organisation runs version ${standing.installedVersion}; version ${standing.version} is waiting. Upgrade it in the App Store to use it.`,
        link: { label: "Upgrade in the App Store", href: standing.appStoreHref },
      };
    case "not_installed":
      return {
        text: `${lead}Version ${standing.version} is not installed in your organisation, so people cannot open it yet. Install it from the App Store.`,
        link: { label: "Install in the App Store", href: standing.appStoreHref },
      };
    case "not_published":
      return { text: `${lead}No version is published yet.` };
    case "unknown":
      return {
        text: `${lead}Someone who manages applications installs or upgrades it in the App Store.`,
        ...(standing.appStoreHref === undefined
          ? {}
          : { link: { label: "Open in the App Store", href: standing.appStoreHref } }),
      };
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
  compositionContext,
  structure,
}: Readonly<{
  draft: StudioDraft;
  compositionContext: StudioCompositionContext;
  hidden: boolean;
  initialSection: StudioReleasesSection;
  /** The one Structure command runner, for the one-click offers Publish shows. */
  structure: Readonly<{
    command: (command: StudioStructureCommand) => StudioStructureResult;
  }>;
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
  // Where the application stands in the organisation: read when the Releases tab opens and after
  // each Publish; null until read.
  const [standing, setStanding] = useState<ApplicationReleaseStanding | null>(null);
  const rootId = draft.state.rootId;
  const readStanding = useCallback(async (): Promise<ApplicationReleaseStanding> => {
    const next = await readApplicationReleaseStanding(organizationId, rootId).catch(
      (error: unknown): ApplicationReleaseStanding => {
        console.error(`[studio] release standing read failed: ${describeFailure(error)}`);
        return { kind: "unknown" };
      },
    );
    if (latest.current.isActive()) setStanding(next);
    return next;
  }, [organizationId, rootId]);
  useEffect(() => {
    if (!hidden) void readStanding();
  }, [hidden, readStanding]);

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
    result: Readonly<{
      reason?: string;
      flowKey?: string;
      taskId?: string;
      family?: string;
      sentence?: string;
    }>,
  ): string | undefined =>
    result.flowKey === undefined || result.reason === undefined
      ? undefined
      : describeStudioCompileFailure(
          {
            reasonCode: result.reason.slice("compilation_".length),
            family: result.family ?? "unknown",
            flowKey: result.flowKey,
            ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
            ...(result.sentence === undefined ? {} : { sentence: result.sentence }),
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
    adopted = false,
  ): Promise<StudioPublicationOutcome> => {
    if (draft.isHeld("publication") || latest.current.blockedReason() !== undefined)
      return { kind: "not_started", reason: "busy" };
    // A check shows as under way while the latest edits finish saving, so the dialog never offers it twice.
    if (mode === "prepare") setPreparing(true);
    const snapshot = (await latest.current.flush()) ? readSnapshot() : null;
    if (snapshot === null) {
      if (mode === "prepare" && request.current === null && latest.current.isActive())
        setPreparing(false);
      return { kind: "not_started", reason: "not_saved" };
    }
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
    // The dialog still waits on this request: it was neither closed, replaced nor unmounted.
    const current = () =>
      latest.current.isActive() && !ticket.cancelled && request.current === ticket;
    const superseded = () => !current() || latest.current.lifetime !== snapshot.lifetime;
    const discard = (): StudioPublicationOutcome => {
      if (current())
        setProblem(
          mode === "prepare"
            ? "The draft was reloaded while its summary was being checked. Check again before publishing."
            : publicationProblemText("temporarily_unavailable", undefined),
        );
      return { kind: "discarded" };
    };
    try {
      if (mode === "prepare") {
        const result = await prepareStudioApplicationPublication(organizationId, {
          rootId: snapshot.rootId,
          expectedDraftRevision: snapshot.draftRevision,
        });
        if (superseded()) return discard();
        const parsed =
          result.kind === "available"
            ? prepareDefinitionPublicationResultSchema.safeParse(result.preparation)
            : null;
        // An unchanged draft whose release the platform has superseded is saved once more by the
        // platform, in the same request; the same source on a later revision is adopted as the
        // saved draft, and the check runs again on it.
        if (
          !adopted &&
          parsed?.success &&
          parsed.data.confirmation.rootId === snapshot.rootId &&
          parsed.data.confirmation.expectedDraftRevision > snapshot.draftRevision &&
          parsed.data.confirmation.sourceFingerprint === snapshot.sourceFingerprint
        ) {
          // This request is finished: release it so the check on the adopted draft can start.
          request.current = null;
          latest.current.hold("publication", false);
          const reloaded = await latest.current.reload();
          if (!reloaded) {
            setProblem("The saved draft could not be reloaded. Close this window and try again.");
            return { kind: "unverified" };
          }
          // Let the reloaded draft render before the check reads the workspace again.
          await new Promise((resolve) => setTimeout(resolve));
          return requestPublication("prepare", suppliedNote, true);
        }
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
            if (superseded()) return discard();
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
            compileProblemOf(snapshot.draftRevision),
            "sentence" in result ? result.sentence : undefined,
            flowRefusalOf(result),
          ),
        );
        return { kind: "declined", result: result.kind, reason: result.reason };
      }
      const confirmation = confirmed!.confirmation;
      const result = await publishStudioApplication(organizationId, { confirmation, releaseNote });
      if (superseded()) return discard();
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
        // Publishing creates the version; the App Store installs or upgrades to it. The notice says
        // which of those the organisation still needs.
        const version = parsed.data.releaseVersion;
        void readStanding().then((now) => {
          const words = standingWords(now, version);
          studioNotice(words.text, "success", words.link);
        });
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
          compileProblemOf(snapshot.draftRevision),
          "sentence" in result ? result.sentence : undefined,
          flowRefusalOf(result),
        ),
      );
      // A transient failure of the append may still have completed.
      return result.kind === "temporarily_unavailable"
        ? { kind: "unverified" }
        : { kind: "declined", result: result.kind, reason: result.reason };
    } catch (error) {
      console.error(`[studio] publication ${mode} request failed: ${describeFailure(error)}`);
      if (current())
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
        throw new Error(problem, { cause: error });
      } finally {
        if (latest.current.isActive()) setPreviewPending(false);
      }
    })();
    studioNotice("Preview is starting…");
    void starting
      .then((href) =>
        studioNotice("Preview ready", "success", undefined, {
          action: {
            label: "Open",
            onClick: () => {
              window.open(href, "_blank", "noopener");
            },
          },
        }),
      )
      .catch((error: unknown) =>
        studioNotice(
          error instanceof Error
            ? error.message
            : "Preview could not start. Your changes are kept. Try Preview again.",
          "error",
        ),
      );
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
    // The reviewed file is what the draft must hold: a parse that drops anything is a defect, not a silent replace.
    if (canonicalJson(parsed.data) !== canonicalJson(candidate)) {
      console.error(
        "[studio] the imported source did not survive its own contract: STUDIO_SOURCE_IMPORT_PARSE_LOST",
      );
      return "stale";
    }
    const outcome = draft.run(() => ({ kind: "edit", source: parsed.data, result: true }), {
      expected: expected.source,
    });
    if (outcome.kind === "blocked") return "stale";
    if (!outcome.changed) return "unchanged";
    if (canonicalJson(draft.history.getState().source) !== canonicalJson(parsed.data)) {
      console.error(
        "[studio] the draft did not keep the imported source: STUDIO_SOURCE_IMPORT_EDIT_LOST",
      );
      return "stale";
    }
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

  const standingShown = standingWords(standing ?? { kind: "unknown" });
  const panel = panelVisited ? (
    <StudioReleasesPanel hidden={hidden} section={section} onSection={setSection} />
  ) : null;
  const centre: ReactNode = (
    <div className="mx-auto max-w-4xl px-8 py-6 text-foreground">
      {standing === null || standing.kind === "unknown" ? null : (
        <section
          aria-label="Installation"
          className="mb-4 space-y-2 rounded-md border border-border bg-muted/40 p-4"
        >
          <p className="font-medium">
            {standing.kind === "live"
              ? "Live in your organisation"
              : standing.kind === "waiting"
                ? "A newer version is waiting"
                : standing.kind === "not_installed"
                  ? "Not installed yet"
                  : "Not published yet"}
          </p>
          <p className="text-sm text-muted-foreground">{standingShown.text}</p>
          {standingShown.link === undefined ? null : (
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<NavigationLink href={standingShown.link.href} />}
            >
              {standingShown.link.label}
            </Button>
          )}
        </section>
      )}
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
      {!hidden && section === "backend-runs" && (
        <StudioBackendRuns
          organizationId={organizationId}
          rootId={draft.state.rootId}
          savedRevision={draft.saved.draftRevision}
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
  const pageChecks = prepared === null ? [] : studioRecordPageChecks(draft.state.source);
  const fixPageCheck = (check: StudioRecordPageCheck): StudioStructureResult => {
    if (check.kind === "missing_edit_page")
      return structure.command({
        kind: "add_record_page",
        type: "form_edit",
        recordType: check.recordType,
        shellAlias: null,
        addToMenu: false,
      });
    if (check.kind === "missing_row_edit")
      return structure.command({
        kind: "ensure_record_page_actions",
        recordType: check.recordType,
      });
    if (check.kind === "missing_form_cancel")
      return structure.command({ kind: "ensure_form_cancel", pageAlias: check.pageAlias });
    return { kind: "refused", message: "Add content to the home page in Structure." };
  };
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
          <>
            <StudioFieldPageReview
              addedFields={prepared.addedFields}
              context={compositionContext}
              disabled={draft.locked || preparing || draft.updatingCanvas}
              edit={studioDataEdit(draft)}
            />
            <StudioPageCheckReview
              checks={pageChecks}
              disabled={draft.locked || preparing || draft.updatingCanvas}
              onFix={fixPageCheck}
            />
          </>
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
