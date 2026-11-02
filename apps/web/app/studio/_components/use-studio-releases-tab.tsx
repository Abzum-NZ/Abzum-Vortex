"use client";
import dynamic from "next/dynamic";
import { NavigationLink } from "@vortex/ui/routing";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  applicationSourceDocumentSchema,
  canonicalJson,
  describeFailure,
} from "@vortex/platform/schema";
import { previewStudioApplication } from "../preview-actions";
import { readApplicationReleaseStanding } from "../releases-actions";
import type { ApplicationReleaseStanding } from "../../_lib/application-release-adoption";
import {
  sameStudioApplicationSourceImportSnapshot,
  type StudioApplicationSourceImportSnapshot,
} from "../_lib/application-source-import";
import type { SavedDraftContext } from "./application-draft-agent-tools";
import type { ApplicationSourceImport as ApplicationSourceImportComponent } from "./application-source-import";
import { previewProblem } from "./studio-refusal-messages";
import { studioReleasesSections, type StudioReleasesSection } from "./studio-rail-tabs";
import type { StudioDraft } from "./use-studio-draft";
import { studioNotice } from "./studio-save-state";
import { Button } from "@vortex/ui/components/button";
import { useStudioTabVisited } from "./studio-frame";
import { deferredStudioPart } from "./studio-deferred-part";
import { useIntentPreload } from "../_lib/use-intent-preload";
import type { StudioActionToken } from "../../_lib/studio-action-tokens";
import { useStudioActionFlows } from "./use-studio-action-flows";

// What Publish and the Releases tab show loads when they are first wanted: the top bar's Publish
// needs only this hook's state at first paint.
const StudioReleasesPanel = deferredStudioPart(
  () => import("./studio-releases-panel").then((module) => module.StudioReleasesPanel),
  "releases panel",
);
const preloadReleasesPanel = () => import("./studio-releases-panel");
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

/** The one Preview toast: starting, then opened, ready to open or failed, replacing each other. */
const previewNoticeId = "studio-preview";

/** The one wording of how a system application advances, shown in the standing and the history. */
const systemRefreshMessage = "System applications move forward through the platform refresh.";

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
    case "system":
      return {
        text: `${lead}Latest published version: ${standing.version}. Installed version: ${standing.installedVersion}. ${systemRefreshMessage}`,
      };
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
 * What the editor offers about installing the application, from where it stands in the
 * organisation: install it, upgrade it, open it, or nothing (nothing is published yet, or the
 * standing cannot be read).
 */
export type StudioInstallControl = "install" | "upgrade" | "open" | undefined;

const installControlOf = (kind: ApplicationReleaseStanding["kind"]): StudioInstallControl =>
  kind === "not_installed"
    ? "install"
    : kind === "waiting"
      ? "upgrade"
      : kind === "live" || kind === "system"
        ? "open"
        : undefined;

/**
 * The Releases tab and what acts on the saved draft as a whole: Publish and Install or upgrade
 * (the App Store's flows, run over the editor), Preview, the published versions with restore, page
 * adoption and import. Each of them first lets the latest edits finish saving, because only the
 * saved draft is published, previewed or restored over.
 */
export function useStudioReleasesTab({
  draft,
  hidden,
  initialSection,
  initialStanding,
}: Readonly<{
  draft: StudioDraft;
  /** Where the application stood in the organisation when the editor opened. */
  initialStanding: ApplicationReleaseStanding["kind"];
  hidden: boolean;
  initialSection: StudioReleasesSection;
}>) {
  const { organizationId, history } = draft;
  useIntentPreload(preloadReleasesPanel, "#studio-rail-releases");
  const latest = useRef(draft);
  latest.current = draft;
  const [section, setSection] = useState<StudioReleasesSection>(initialSection);
  const importVisited = useStudioTabVisited(!hidden && section === "import");
  const panelVisited = useStudioTabVisited(!hidden);
  // A new version reloads the history.
  const [historyGeneration, setHistoryGeneration] = useState(0);
  const [previewPending, setPreviewPending] = useState(false);
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
  const readSnapshot = useCallback(() => {
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
    };
  }, [history]);

  // Publishing and installing are the App Store's flows, run over the editor: the latest edits
  // finish saving, then the flow's first dialog opens here. What a flow commits changes where the
  // application stands and what the history lists.
  const actions = useStudioActionFlows({
    organizationId,
    rootId,
    hold: (on) => draft.hold("publication", on),
    onCommitted: (action) => {
      void readStanding();
      if (action === "publish") setHistoryGeneration((generation) => generation + 1);
    },
  });
  const startAction = async (action: StudioActionToken): Promise<boolean> => {
    if (!(await latest.current.flush())) {
      studioNotice(
        `Your latest change is not saved. Resolve it, then ${action === "publish" ? "publish" : "install"}.`,
        "error",
      );
      return false;
    }
    return actions.start(action);
  };
  const openPublish = () => {
    void startAction("publish");
  };
  const openInstall = () => {
    void startAction("install");
  };

  // Preview runs the saved draft as its own Application in a new tab. The tab is opened at once,
  // while the press still counts as the person's, and is closed if nothing runs. A browser that
  // does not open it (a pop-up blocker, an embedded browser) gets the same result as a link that
  // stays until it is used, so Preview always ends in something the person can open.
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
        const opened = previewTab !== null && !previewTab.closed;
        if (opened) previewTab.location.href = result.href;
        return { href: result.href, opened };
      } catch (error) {
        console.error("[studio] the preview could not be started", describeFailure(error));
        previewTab?.close();
        throw new Error(problem, { cause: error });
      } finally {
        if (latest.current.isActive()) setPreviewPending(false);
      }
    })();
    studioNotice("Preview is starting…", "info", undefined, { id: previewNoticeId });
    void starting
      .then(({ href, opened }) =>
        opened
          ? studioNotice("Preview opened in a new tab", "success", undefined, {
              id: previewNoticeId,
            })
          : studioNotice(
              "Preview is ready, but your browser did not open a new tab",
              "success",
              { label: "Open preview", href, newTab: true },
              { id: previewNoticeId, duration: Infinity, closeButton: true },
            ),
      )
      .catch((error: unknown) =>
        studioNotice(
          error instanceof Error
            ? error.message
            : "Preview could not start. Your changes are kept. Try Preview again.",
          "error",
          undefined,
          { id: previewNoticeId },
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
            {standing.kind === "system"
              ? "System application"
              : standing.kind === "live"
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
          installationMessage={
            standing?.kind === "system"
              ? systemRefreshMessage
              : standing == null || standing.kind === "unknown"
                ? undefined
                : "Organisations install and upgrade a version from the App Store."
          }
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
  return {
    panel,
    centre,
    title,
    openPublish,
    openInstall,
    install: installControlOf(standing?.kind ?? initialStanding),
    /** The action whose App Store page is being read before its first dialog opens. */
    actionPending: actions.pending,
    /** The dialogs, toasts and banner the flows show over the editor. */
    flowHost: { element: actions.element, banner: actions.banner },
    openPreview: () => {
      void openPreview();
    },
    previewPending,
    agent: { readSavedDraft, startAction },
  };
}
