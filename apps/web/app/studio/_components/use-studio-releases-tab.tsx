"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  applicationSourceDocumentSchema,
  canonicalJson,
  describeFailure,
} from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import { Alert, AlertAction, AlertDescription } from "@vortex/ui/components/alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vortex/ui/components/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@vortex/ui/components/sheet";
import { Skeleton } from "@vortex/ui/components/skeleton";
import { Spinner } from "@vortex/ui/components/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@vortex/ui/components/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";
import { previewStudioApplication } from "../preview-actions";
import { readApplicationReleaseStanding, readStandardPageAdoption } from "../releases-actions";
import type { ApplicationReleaseStanding } from "../../_lib/application-release-adoption";
import {
  sameStudioApplicationSourceImportSnapshot,
  type StudioApplicationSourceImportSnapshot,
} from "../_lib/application-source-import";
import type { SavedDraftContext } from "./application-draft-agent-tools";
import type { ApplicationSourceImport as ApplicationSourceImportComponent } from "./application-source-import";
import { previewProblem } from "./studio-refusal-messages";
import {
  isStudioReleasesSection,
  studioReleasesSections,
  type StudioReleasesSection,
} from "./studio-rail-tabs";
import type { StudioDraft } from "./use-studio-draft";
import { studioNotice } from "./studio-save-state";
import { Button } from "@vortex/ui/components/button";
import { appStoreHrefOf, StudioReleasesStanding } from "./studio-releases-standing";
import type { StudioStandardPageAdoptionLoadResult } from "../../_lib/studio-standard-page-adoption";
import { useIntentPreload } from "../_lib/use-intent-preload";
import type { StudioActionToken } from "../../_lib/studio-action-tokens";
import { useStudioActionFlows } from "./use-studio-action-flows";

// What Publish and the Releases tab show loads when they are first wanted: the top bar's Publish
// needs only this hook's state at first paint.
const preloadReleasesHistory = () => import("./studio-history-tab");
const ApplicationSourceImport = dynamic(
  () => import("./application-source-import").then((module) => module.ApplicationSourceImport),
  {
    loading: () => (
      <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" />
        Loading source import…
      </div>
    ),
  },
);
const StandardPageAdoption = dynamic(
  () => import("./standard-page-adoption").then((module) => module.StandardPageAdoption),
  { loading: () => <Skeleton className="h-24 w-full" /> },
);
const StudioBackendRuns = dynamic(
  () => import("./studio-backend-runs").then((module) => module.StudioBackendRuns),
  { loading: () => <Skeleton className="h-24 w-full" /> },
);
const StudioHistoryTab = dynamic(
  () => import("./studio-history-tab").then((module) => module.StudioHistoryTab),
  { loading: () => <Skeleton className="h-24 w-full" /> },
);

/** The saved draft's source as a file the person keeps: the same document Replace draft from a file reads. */
const downloadApplicationSource = (snapshot: StudioApplicationSourceImportSnapshot): void => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(snapshot.source, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${snapshot.key}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

/**
 * Shown above the tabs only when an upgrade left pages with a local replacement to compare with the
 * standard page, or when that could not be checked (a hidden backlog would be a missed upgrade step).
 */
function PageAdoptionNotice({
  loaded,
  onReview,
  onReload,
}: Readonly<{
  loaded: StudioStandardPageAdoptionLoadResult | null;
  onReview: () => void;
  onReload: () => void;
}>) {
  if (loaded?.kind === "temporarily_unavailable")
    return (
      <Alert variant="destructive">
        <AlertDescription>Pages waiting after an upgrade could not be checked.</AlertDescription>
        <AlertAction>
          <Button type="button" variant="outline" size="sm" onClick={onReload}>
            Reload
          </Button>
        </AlertAction>
      </Alert>
    );
  if (loaded?.kind !== "available" || loaded.choices.length === 0) return null;
  const waiting = loaded.choices.length;
  return (
    <Alert variant="warning">
      <AlertDescription>
        {waiting === 1
          ? "1 page has your own version next to the standard one."
          : `${waiting} pages have your own version next to the standard one.`}
      </AlertDescription>
      <AlertAction>
        <Button type="button" variant="outline" size="sm" onClick={onReview}>
          Review pages
        </Button>
      </AlertAction>
    </Alert>
  );
}

/** The one Preview toast: starting, then opened, ready to open or failed, replacing each other. */
const previewNoticeId = "studio-preview";

/**
 * What the editor offers about installing the application, from where it stands in the
 * organisation: install it, upgrade it, open it, or nothing (nothing is published yet, or the
 * standing cannot be read).
 */
export type StudioInstallControl = "install" | "upgrade" | "open" | undefined;

const installControlOf = (standing: ApplicationReleaseStanding): StudioInstallControl =>
  standing.kind === "not_installed"
    ? standing.mayInstall
      ? "install"
      : undefined
    : standing.kind === "waiting"
      ? standing.mayInstall
        ? "upgrade"
        : undefined
      : standing.kind === "live" || standing.kind === "system"
        ? "open"
        : undefined;

const openHrefOf = (standing: ApplicationReleaseStanding): string | undefined =>
  standing.kind === "live" || standing.kind === "system" ? standing.openHref : undefined;

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
  showPlace,
}: Readonly<{
  draft: StudioDraft;
  /** Opens a module or record type of the draft in the Data tab. */
  showPlace: (moduleKey: string, recordKey: string | undefined) => boolean;
  /** Where the application stood in the organisation when the editor opened. */
  initialStanding: ApplicationReleaseStanding;
  hidden: boolean;
  initialSection: StudioReleasesSection;
}>) {
  const { organizationId, history } = draft;
  useIntentPreload(preloadReleasesHistory, "#studio-rail-releases");
  const latest = useRef(draft);
  latest.current = draft;
  const [section, setSection] = useState<StudioReleasesSection>(initialSection);
  // The import dialog is built when first opened and then kept, so closing it keeps what was pasted.
  const [importMounted, setImportMounted] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [adoptionOpen, setAdoptionOpen] = useState(false);
  // A new version, or the Reload control, reads the history and the back-end runs again.
  const [historyGeneration, setHistoryGeneration] = useState(0);
  const [runsGeneration, setRunsGeneration] = useState(0);
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

  // The pages an upgrade left to adopt: one read, owned here, shared by the notice and the sheet.
  // It is read when the tab opens and again after an install, publish or restore.
  const [adoption, setAdoption] = useState<StudioStandardPageAdoptionLoadResult | null>(null);
  const readAdoption = useCallback(async (): Promise<void> => {
    const next = await readStandardPageAdoption(organizationId, rootId).catch(
      (error: unknown): StudioStandardPageAdoptionLoadResult => {
        console.error(`[studio] page adoption comparison failed: ${describeFailure(error)}`);
        return { kind: "temporarily_unavailable" };
      },
    );
    if (next.kind !== "available") console.error(`[studio] page adoption comparison ${next.kind}`);
    if (latest.current.isActive()) setAdoption(next);
  }, [organizationId, rootId]);
  // The comparison is of the saved draft, so a saved edit reads it again.
  const savedRevision = draft.saved.draftRevision;
  useEffect(() => {
    if (!hidden) void readAdoption();
  }, [hidden, readAdoption, savedRevision]);

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
      // A published version changes what the draft is compared with; an install or upgrade does not.
      if (action === "publish") {
        void readAdoption();
        setHistoryGeneration((generation) => generation + 1);
      }
    },
  });
  const startAction = async (
    action: StudioActionToken,
    origin: "person" | "agent" = "person",
  ): Promise<boolean> => {
    // Installing moves the organisation to the published version; the draft is not involved.
    if (action === "install") return actions.start(action, origin);
    if (!(await latest.current.flush())) {
      studioNotice(
        `Your latest change is not saved. Resolve it, then ${action === "publish" ? "publish" : "install"}.`,
        "error",
      );
      return false;
    }
    return actions.start(action, origin);
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
  // Export waits for the latest edits to be saved, as Publish does, and says why when it cannot run.
  const exportSource = async (): Promise<void> => {
    const flushed = await latest.current.flush();
    const snapshot = flushed ? readImportSnapshot() : null;
    if (snapshot !== null) {
      downloadApplicationSource(snapshot);
      return;
    }
    studioNotice(
      latest.current.blockedReason() ??
        (flushed
          ? "The draft changed while exporting. Try again."
          : "Your latest change is not saved. Resolve it, then export again."),
      "error",
    );
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

  const shownStanding = standing ?? initialStanding;
  const appStoreHref = appStoreHrefOf(shownStanding);
  const centre: ReactNode = (
    <div className="mx-auto max-w-5xl space-y-4 px-8 py-6 text-foreground">
      <StudioReleasesStanding
        standing={shownStanding}
        actionPending={actions.pending !== undefined}
        onReviewRoles={openInstall}
      />
      {!hidden && (
        <PageAdoptionNotice
          loaded={adoption}
          onReview={() => setAdoptionOpen(true)}
          onReload={() => void readAdoption()}
        />
      )}
      <Tabs
        value={section}
        onValueChange={(value) => {
          if (isStudioReleasesSection(value)) setSection(value);
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <TabsList>
            {studioReleasesSections.map((entry) => (
              <TabsTrigger key={entry.value} value={entry.value}>
                {entry.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Reload"
                    onClick={() => {
                      if (section === "history")
                        setHistoryGeneration((generation) => generation + 1);
                      else setRunsGeneration((generation) => generation + 1);
                    }}
                  />
                }
              >
                <Icon name="refresh" />
              </TooltipTrigger>
              <TooltipContent>
                {section === "history" ? "Reload the versions" : "Reload the runs"}
              </TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label="More release actions"
                        />
                      }
                    />
                  }
                >
                  <Icon name="more-horizontal" />
                </TooltipTrigger>
                <TooltipContent>More release actions</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={draft.locked}
                  onClick={() => {
                    setImportMounted(true);
                    setImportOpen(true);
                  }}
                >
                  <Icon name="upload" />
                  Replace draft from a file…
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={draft.locked}
                  onClick={() => {
                    void exportSource();
                  }}
                >
                  <Icon name="download" />
                  Export source
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <TabsContent value="history" className="pt-4">
          {!hidden && (
            <StudioHistoryTab
              key={historyGeneration}
              organizationId={organizationId}
              rootId={draft.state.rootId}
              savedRevision={draft.saved.draftRevision}
              appStoreHref={appStoreHref}
              restoreBlocked={restoreBlocked}
              hold={(on) => draft.hold("restoring", on)}
              onRestored={(restored) => {
                void readAdoption();
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
              onPublish={openPublish}
            />
          )}
        </TabsContent>
        <TabsContent value="backend-runs" className="pt-4">
          {!hidden && (
            <StudioBackendRuns
              key={runsGeneration}
              organizationId={organizationId}
              rootId={draft.state.rootId}
            />
          )}
        </TabsContent>
      </Tabs>
      <Sheet open={adoptionOpen} onOpenChange={setAdoptionOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
          <SheetHeader className="sr-only">
            <SheetTitle>Page adoption</SheetTitle>
            <SheetDescription>
              Choose, page by page, whether to keep your own version or use the standard one.
            </SheetDescription>
          </SheetHeader>
          <div className="px-8 pb-6">
            <StandardPageAdoption
              loaded={adoption}
              onReload={readAdoption}
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
          </div>
        </SheetContent>
      </Sheet>
      {/* The import keeps what was pasted while it is closed, another section or another tab is open. */}
      {importMounted && (
        <ApplicationSourceImport
          key={draft.lifetime}
          open={importOpen && !hidden}
          onOpenChange={setImportOpen}
          disabled={draft.locked}
          readSnapshot={readImportSnapshot}
          onShowPlace={(source, place) => {
            const module = source.body.modules.find((entry) => entry.key === place.moduleKey);
            if (module === undefined) return undefined;
            const recordKey = module.record_types.some((entry) => entry.key === place.recordKey)
              ? place.recordKey
              : undefined;
            return () => showPlace(place.moduleKey, recordKey);
          }}
          onApply={applyImport}
        />
      )}
    </div>
  );
  const title = "Releases";
  return {
    centre,
    title,
    openPublish,
    openInstall,
    install: installControlOf(standing ?? initialStanding),
    /** Where the application opens once it is installed: read with its standing, so an install made here shows it at once. */
    openHref: openHrefOf(standing ?? initialStanding),
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
