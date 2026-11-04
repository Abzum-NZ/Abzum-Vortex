"use client";
import { useSearchParams } from "next/navigation";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  applicationSourceDocumentSchema,
  describeFailure,
  holdsPermission,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
  type NavigationPermissionDecisions,
} from "@vortex/platform/schema";
import {
  applyStudioCompositionCommand,
  applyStudioReactionCondition,
  describeStudioCompositionAddTargets,
  describeStudioCompositionDestinations,
  describeStudioCompositionWrap,
  studioDraftChoices,
  resolveStudioSelectionInspectorContext,
  studioMoveUnavailableReason,
  studioSemanticSelectionKey,
  traverseStudioSemanticSelectionDraft,
  type StudioCompositionCommand,
  type StudioCompositionContext,
  type StudioCompositionDestination,
  type StudioCompositionOutcome,
  type StudioCompositionOwner,
  type StudioBorrowedChoices,
  type StudioRecordReader,
  type StudioSemanticOutline,
  type StudioSemanticSelection,
  reduceStudioCanvasGrid,
  studioCanvasGridArrangement,
  studioCanvasGridReads,
  type StudioCanvasGridChange,
  type StudioCanvasGridRead,
  type StudioCanvasGridState,
  studioPageNestingLevels,
} from "@vortex/ui/studio";
import { Icon, type FieldInputControlReleaseMap, type PlatformThemeTokens } from "@vortex/ui";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@vortex/ui/components/empty";
import { Button } from "@vortex/ui/components/button";
import { Badge } from "@vortex/ui/components/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";
import { StudioCanvasSkeleton, StudioCanvasView } from "@vortex/ui/studio/canvas-view";
import { StudioBlocksPanel } from "@vortex/ui/studio/puck-drawer";
import type {
  StudioBlockActions,
  StudioBlockDialogKind,
  StudioCanvasAddRequest,
  StudioCanvasFrame,
  StudioPuckInput,
} from "@vortex/ui/studio/puck-provider";
import { FirstRecordTypeEmptyState } from "../../_components/first-record-type-empty-state";
import { readStudioCanvasRecords, readStudioDataRecords } from "../_lib/studio-preview-reader";
import { readWhenPreviewReady } from "../_lib/studio-preview-gate";
import {
  applyStudioItemLabels,
  applyStudioPageValue,
  type StudioPageValueCommand,
  type StudioPageValueResult,
  type StudioPlacementDescriber,
} from "@vortex/ui/studio";
import { studioDraftNavigation } from "../_lib/studio-draft-navigation";
import { studioUseTargetOf } from "../_lib/studio-places";
import { pageUsingLayout } from "../_lib/studio-view-request";
import type { StudioApplicationCanvasFrames } from "../../_lib/studio-application-draft";
import { studioMenuPosition } from "@vortex/platform/schema";
import type { StudioInspectorAction } from "@vortex/ui/studio";
import { ApplicationCompositionEditor } from "./application-composition-editor";
import { StudioBlockVisibility } from "./studio-block-gate";
import { StudioBlockSetupDialog, type StudioBlockSetupRequest } from "./studio-block-setup-dialog";
import { StudioBlockDialogs } from "./studio-block-dialogs";
import { StudioQuerySheet } from "./studio-query-sheet";
import { StudioCanvasToolbar, type StudioCanvasZoom } from "./studio-canvas-toolbar";
import { StudioPanelShell } from "./studio-frame";
import { StudioInspector } from "./studio-inspector";
import { StudioLayoutOutlets, StudioLayoutOutletUses } from "./studio-layout-outlets";
import type { StudioStructureCommandRunner } from "./use-studio-structure-tab";
import { StudioUsedIn } from "./studio-used-in";
import type { StudioModuleOwnerApplication } from "./module-fields-editor";
import { StudioOutlinePanel } from "./studio-outline-panels";
import { railShowsCanvas, type StudioRailKey } from "./studio-rail-tabs";
import type { StudioDraft, StudioDraftStep } from "./use-studio-draft";
import { StudioPageValuesPanel } from "./studio-page-values-panel";
import type { useStudioDraftTheme } from "./use-studio-draft-theme";

/**
 * The application frame the canvas draws the page inside: the compiled draft's shell, with the
 * draft's menu and theme as they are edited, so Menu and Theme changes show before a compile. The
 * menu is the one a previewed role sees, or every entry in the design view (`decisions` null).
 */
const canvasFrameFor = (
  frames: StudioApplicationCanvasFrames | null,
  pageAlias: string,
  source: ApplicationSourceDocument,
  theme: StudioCanvasFrame["theme"] | undefined,
  decisions: NavigationPermissionDecisions | null,
): StudioCanvasFrame | undefined => {
  const page = frames?.pages[pageAlias];
  return frames === null || page === undefined || theme === undefined
    ? undefined
    : {
        applicationName: frames.applicationName,
        shells: frames.shells,
        theme,
        navigation: studioDraftNavigation(source, frames.pages, decisions),
        ...page,
      };
};

/** A function that keeps its identity while always calling the latest one. */
const useStable = <Args extends unknown[], Result>(
  latest: (...args: Args) => Result,
): ((...args: Args) => Result) => {
  const held = useRef(latest);
  held.current = latest;
  return useCallback((...args: Args) => held.current(...args), []);
};

const sameDestination = (
  left: StudioCompositionDestination,
  right: StudioCompositionDestination,
) =>
  left.kind === "root"
    ? right.kind === "root"
    : right.kind === "child" &&
      left.parentAlias === right.parentAlias &&
      left.slotKey === right.slotKey;

/**
 * The page canvas and what edits it: the Blocks and Outline panels, the inspector (name, settings,
 * order and size, visibility rule and workflows of the selection), the Puck canvas itself and its
 * toolbar, and "Who can see this". Every edit is one command through the draft's envelope.
 */
export function useStudioCanvasTab({
  draft,
  tab,
  catalogue,
  describePlacement,
  structure,
  fieldInputControlReleases,
  platformThemeTokens,
  outline,
  labels,
  theme,
  flowsInspector,
  placementWorkflows,
  flowDeleteActions,
  flowDeleteNotice,
  openTab,
  applications,
}: Readonly<{
  draft: StudioDraft;
  tab: StudioRailKey;
  catalogue: ImmutablePlatformBlockCatalogue;
  describePlacement: StudioPlacementDescriber;
  /** The Structure command runner the Layout inspector edits through. */
  structure: StudioStructureCommandRunner;
  fieldInputControlReleases: FieldInputControlReleaseMap | null;
  platformThemeTokens: PlatformThemeTokens | null;
  outline: StudioSemanticOutline;
  /** Selection key to the label Studio shows for it. */
  labels: ReadonlyMap<string, string>;
  theme: ReturnType<typeof useStudioDraftTheme>;
  /** The selected flow step's inspector, from the Flows tab. */
  flowsInspector: ReactNode;
  /** The selected block's workflows, from the Flows tab. */
  placementWorkflows: ReactNode;
  flowDeleteActions: readonly StudioInspectorAction[];
  flowDeleteNotice: ReactNode;
  openTab: (tab: StudioRailKey) => void;
  /** The organisation's applications, which name the owner of a choice from a used Module. */
  applications: readonly StudioModuleOwnerApplication[];
}>) {
  const { organizationId, source, selected, state, view } = draft;
  const rootId = state.rootId;
  const key = draft.saved.key;
  const [fitZoom, setFitZoom] = useState(0);
  // The query sheet a block's data picker opened, with how the block chooses the query it makes.
  const [querySheet, setQuerySheet] = useState<Readonly<{
    use: (reference: string) => void;
  }> | null>(null);
  const [canvasZoom, setCanvasZoom] = useState<StudioCanvasZoom>("fit");
  // The canvas previews the application in light or dark; the running application keeps its own toggle.
  const [appearance, setAppearance] = useState<"light" | "dark">("light");
  // "Who can see this": the role the canvas and its menu are previewed as; null is the builder's view.
  const [viewAs, setViewAs] = useState<string | null>(null);
  const [paletteMessage, setPaletteMessage] = useState("");
  const [blockSetup, setBlockSetup] = useState<StudioBlockSetupRequest | null>(null);
  // The dialog the selected block's More menu opened on the canvas.
  const [blockDialog, setBlockDialog] = useState<StudioBlockDialogKind | null>(null);
  const [notice, setNotice] = useState("");
  const [arrangeGrid, setArrangeGrid] = useState(false);
  const [arrangeableGrids, setArrangeableGrids] = useState(false);
  // A locked draft takes no arrangement: the toolbar and Puck's mode both stay off, however it was asked for.
  useEffect(() => {
    if (draft.locked) setArrangeGrid(false);
  }, [draft.locked, arrangeGrid]);
  const [gridStates, setGridStates] = useState<ReadonlyMap<string, StudioCanvasGridState>>(
    new Map(),
  );
  const gridStatesRef = useRef(gridStates);
  const onGridChange = useCallback((change: StudioCanvasGridChange) => {
    const held = gridStatesRef.current;
    try {
      const next = reduceStudioCanvasGrid(held.get(change.placementAlias), change);
      if (next !== undefined && "kind" in next) {
        console.error("[studio] a canvas grid change was refused", {
          code: next.code,
          cause: next.cause,
        });
        setNotice(next.reason);
        return;
      }
      if (next === held.get(change.placementAlias)) return;
      const states = new Map(held);
      if (next === undefined) states.delete(change.placementAlias);
      else states.set(change.placementAlias, next);
      gridStatesRef.current = states;
      setGridStates(states);
    } catch (error) {
      console.error(
        `[studio] a canvas grid change was not applied: STUDIO_CANVAS_GRID_CHANGE_REFUSED cause=${describeFailure(error)}`,
      );
      setNotice("This grid change could not be applied. Reload the canvas and try again.");
    }
  }, []);
  // The preview reads a grid again only for a query change or a newly shown column; the text
  // makes the object stable across the layout gestures that read nothing.
  const gridReadsText = JSON.stringify(studioCanvasGridReads(gridStates));
  const gridReads = useMemo(
    () => JSON.parse(gridReadsText) as ReturnType<typeof studioCanvasGridReads>,
    [gridReadsText],
  );

  // Resolving validates the whole source: once per source and selection, not on every render.
  const inspector = useMemo(
    () => resolveStudioSelectionInspectorContext({ rootId, source }, selected),
    [rootId, source, selected],
  );
  const selectionKey = selected === null ? "" : studioSemanticSelectionKey(selected);
  // The page or layout that holds each block: the canvas draws a block's page, the Outline lists its owner's blocks.
  const placementOwners = useMemo(() => {
    const owners = new Map<
      string,
      Readonly<{ kind: "page"; pageAlias: string } | { kind: "shell"; shellAlias: string }>
    >();
    traverseStudioSemanticSelectionDraft({ rootId, source, catalogue }, ({ phase, node }) => {
      if (phase === "enter" && node.kind === "placement")
        owners.set(
          node.selection.placementAlias,
          node.owner.kind === "page"
            ? { kind: "page", pageAlias: node.owner.pageAlias }
            : { kind: "shell", shellAlias: node.owner.shellAlias },
        );
    });
    return owners;
  }, [rootId, source, catalogue]);
  const selectedOwner =
    selected?.kind === "placement" ? placementOwners.get(selected.placementAlias) : undefined;
  // A menu entry shows the page it opens; the Menu and Theme tabs otherwise show the home page, so
  // their changes are seen in the application's frame.
  const selectedEntry =
    selected?.kind === "navigation"
      ? studioMenuPosition(source, selected.navigationItemAlias)?.item
      : undefined;
  const pageAliasOfKey = (pageKey: string | undefined) =>
    source.body.pages.find((page) => page.key === pageKey)?.id;
  // A selected layout, or a block of one, is drawn on the page the view reads for it.
  const layoutAlias =
    selected?.kind === "shell"
      ? selected.shellAlias
      : selectedOwner?.kind === "shell"
        ? selectedOwner.shellAlias
        : undefined;
  const previewPageAlias = pageUsingLayout(source, layoutAlias);
  const canvasPageAlias =
    selected?.kind === "page"
      ? selected.pageAlias
      : selectedOwner?.kind === "page"
        ? selectedOwner.pageAlias
        : layoutAlias !== undefined
          ? previewPageAlias
          : selectedEntry?.type === "page"
            ? (pageAliasOfKey(selectedEntry.page) ?? pageAliasOfKey(source.body.home_page))
            : tab === "menu" || tab === "theme"
              ? pageAliasOfKey(source.body.home_page)
              : undefined;
  const canvasPage =
    canvasPageAlias === undefined
      ? undefined
      : source.body.pages.find((page) => page.id === canvasPageAlias);
  const addressRestored = useRef(false);
  // The address names a page before the first render (the server draws it too): until the effect
  // below has selected it, the centre is loading that page, not empty.
  const requestedPageKey = useSearchParams().get("page");
  const [addressSettled, setAddressSettled] = useState(false);
  const pageLoading =
    !addressSettled &&
    requestedPageKey !== null &&
    source.body.pages.some((entry) => entry.key === requestedPageKey);
  useEffect(() => {
    const restore = () => {
      const url = new URL(window.location.href);
      const page = source.body.pages.find((entry) => entry.key === url.searchParams.get("page"));
      if (page === undefined) return;
      const block = url.searchParams.get("block");
      const owner = block === null ? undefined : placementOwners.get(block);
      draft.select(
        block !== null &&
          (owner?.kind === "shell" || (owner?.kind === "page" && owner.pageAlias === page.id))
          ? { kind: "placement", placementAlias: block }
          : { kind: "page", pageAlias: page.id },
      );
    };
    if (!addressRestored.current) {
      addressRestored.current = true;
      restore();
      setAddressSettled(true);
    } else if (canvasPage !== undefined) {
      const url = new URL(window.location.href);
      url.searchParams.set("page", canvasPage.key);
      if (selected?.kind === "placement") url.searchParams.set("block", selected.placementAlias);
      else url.searchParams.delete("block");
      if (url.href !== window.location.href)
        window.history.replaceState(window.history.state, "", url);
    }
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [canvasPage, selected, source, placementOwners, draft.select]);
  const canvasPageRef = useRef(canvasPage?.id);
  canvasPageRef.current = canvasPage?.id;
  const layoutAliasRef = useRef(layoutAlias);
  layoutAliasRef.current = layoutAlias;
  // New blocks go to the selected layout, otherwise to the page on the canvas.
  const addOwner: StudioCompositionOwner | undefined =
    layoutAlias !== undefined
      ? { kind: "layout", shellAlias: layoutAlias }
      : canvasPage === undefined
        ? undefined
        : { kind: "page", pageAlias: canvasPage.id };
  const addOwnerKey =
    addOwner === undefined
      ? ""
      : `${addOwner.kind}:${"shellAlias" in addOwner ? addOwner.shellAlias : addOwner.pageAlias}`;
  const addOwnerRef = useRef(addOwner);
  addOwnerRef.current = addOwner;
  // A previewed role holds what the compiled saved draft grants it, which is what the running application installs.
  const viewAsGrants = viewAs === null ? undefined : view.frames?.roles[viewAs];
  const viewAsRole =
    viewAsGrants === undefined ? undefined : source.body.roles.find((role) => role.key === viewAs);
  const viewDecisions = useMemo<NavigationPermissionDecisions | null>(
    () =>
      viewAsGrants === undefined
        ? null
        : Object.fromEntries(viewAsGrants.map((grant) => [grant, true])),
    [viewAsGrants],
  );

  const compositionContext = useMemo<StudioCompositionContext>(
    () => ({
      organizationId,
      rootId,
      key,
      draftRevision: state.draftRevision,
      localLifetime: draft.lifetime,
      catalogue,
      source: state.source,
      borrowed: view.borrowedChoices,
    }),
    [
      organizationId,
      rootId,
      key,
      state.draftRevision,
      draft.lifetime,
      catalogue,
      state.source,
      view.borrowedChoices,
    ],
  );
  const liveContext = (): StudioCompositionContext => {
    const current = draft.history.getState();
    return {
      organizationId,
      rootId: current.rootId,
      key,
      draftRevision: current.draftRevision,
      localLifetime: draft.lifetime,
      catalogue: draft.readCatalogue(),
      source: current.source,
      borrowed: draft.view.borrowedChoices,
    };
  };

  // The one composition edit: the item editor's controls, the Data tab's placements and the agent tools all come through here.
  const commandComposition = (
    expected: StudioCompositionContext,
    expectedSelection: StudioSemanticSelection,
    command: StudioCompositionCommand,
    merge?: string,
  ): StudioCompositionOutcome => {
    const now = draft.selection.getSelection();
    if (
      now === null ||
      studioSemanticSelectionKey(now) !== studioSemanticSelectionKey(expectedSelection)
    )
      return { kind: "stale" };
    const outcome = draft.run(
      ():
        | {
            kind: "edit";
            source: ApplicationSourceDocument;
            result: StudioCompositionOutcome;
          }
        | { kind: "keep"; result: StudioCompositionOutcome } => {
        const result = applyStudioCompositionCommand(liveContext(), expected, now, command);
        return result.kind === "applied"
          ? { kind: "edit", source: result.source, result: { kind: "applied" } }
          : {
              kind: "keep",
              result:
                result.kind === "refused"
                  ? { kind: "refused", reason: result.reason }
                  : { kind: result.kind },
            };
      },
      { merge },
    );
    return outcome.kind === "done" ? outcome.result : { kind: "refused", reason: outcome.message };
  };

  // The one add path for a new block: a drop on the canvas, the palette's Add button and the setup dialog.
  const runAdd = (command: Extract<StudioCompositionCommand, { kind: "add" }>): string | true => {
    const after: { added?: string | undefined } = {};
    const outcome = draft.run(
      ():
        | {
            kind: "edit";
            source: ApplicationSourceDocument;
            result: string | true;
          }
        | { kind: "keep"; result: string | true } => {
        const context = liveContext();
        const result = applyStudioCompositionCommand(
          context,
          context,
          draft.selection.getSelection(),
          command,
        );
        if (result.kind === "refused") return { kind: "keep", result: result.reason };
        if (result.kind !== "applied") {
          console.error(
            `[studio] adding a block was refused: STUDIO_ADD_${result.kind.toUpperCase()}`,
          );
          return {
            kind: "keep",
            result: "The block could not be added, so the draft is unchanged.",
          };
        }
        after.added = result.placementAlias;
        return { kind: "edit", source: result.source, result: true };
      },
    );
    if (outcome.kind === "blocked") return outcome.message;
    if (outcome.result === true && after.added !== undefined)
      draft.select({ kind: "placement", placementAlias: after.added });
    return outcome.result;
  };
  const addTargets = useMemo(
    () =>
      canvasPage === undefined || addOwner === undefined
        ? null
        : describeStudioCompositionAddTargets(compositionContext, addOwner, describePlacement),
    [compositionContext, canvasPage?.id, addOwnerKey, describePlacement],
  );
  // A block for one place: added at once, or after its setup when it needs settings or data.
  const addBlock = (request: StudioCanvasAddRequest): true | false | string => {
    const owner = addOwnerRef.current;
    if (owner === undefined || addTargets?.kind !== "available") return false;
    const target = addTargets.targets.find(
      (candidate) =>
        candidate.area === request.area &&
        sameDestination(candidate.destination, request.destination),
    );
    const choice = target?.choices.find(
      (candidate) => candidate.rendererKey === request.rendererKey,
    );
    // A block this place does not admit still goes to the add command, which names why it is refused.
    const release =
      choice ??
      [...catalogue.releases]
        .reverse()
        .find((candidate) => candidate.rendererKey === request.rendererKey);
    if (release === undefined) return false;
    const command = {
      kind: "add",
      owner,
      area: request.area,
      destination: request.destination,
      index: request.index,
      blockId: release.blockId,
      releaseVersion: release.releaseVersion,
    } as const;
    if (
      target !== undefined &&
      choice !== undefined &&
      choice.unavailable === undefined &&
      (choice.setup.length > 0 || choice.needsQuery)
    ) {
      const page =
        owner.kind === "page"
          ? source.body.pages.find((candidate) => candidate.id === owner.pageAlias)
          : undefined;
      setPaletteMessage("");
      setBlockSetup({
        choice,
        description: `Add to ${target.label}.`,
        action: `Add ${choice.name}`,
        pageQuery: page !== undefined && "query" in page ? page.query : undefined,
        add: (settings, query) => {
          const outcome = runAdd({ ...command, settings, query });
          if (outcome === true) setPaletteMessage(`${choice.name} added.`);
          return outcome;
        },
      });
      return false;
    }
    const outcome = runAdd({ ...command, settings: {}, query: null });
    setPaletteMessage(outcome === true ? `${release.name} added.` : outcome);
    return outcome;
  };

  // A drag on the canvas: the canvas edits the draft it was drawn from, so any change in between makes it stale.
  const applyPuckPageEdit = (
    expectedSource: ApplicationSourceDocument,
    nextSource: ApplicationSourceDocument,
  ) => {
    if (canvasPageRef.current === undefined) return;
    const parsed = applicationSourceDocumentSchema.safeParse(nextSource);
    if (!parsed.success) {
      console.error("Failed to validate Puck page changes", parsed.error);
      setNotice("This page change could not be applied. Your draft is unchanged.");
      return;
    }
    if (parsed.data.key !== key || parsed.data.root_alias !== state.source.root_alias) return;
    const outcome = draft.run(() => ({ kind: "edit", source: parsed.data, result: true }), {
      expected: expectedSource,
    });
    setNotice(outcome.kind === "blocked" ? outcome.message : "");
  };

  // What reference settings and the query picker offer: queries that already exist (own, then borrowed), fields and pages.
  // A record reference picks a record of the builder's preview of the saved draft, read 40 at a
  // time with their preview access through the same reader as the Data tab's results, once the
  // preview runs the saved revision's data shape.
  const readRecordChoices = useCallback<StudioRecordReader>(
    async ({ recordType, after }, signal) => {
      const separator = recordType.indexOf(":");
      const result = await readWhenPreviewReady(
        draft.preview,
        view.draftRevision,
        view.previewShape,
        signal,
        () =>
          readStudioDataRecords(
            organizationId,
            {
              rootId,
              draftRevision: view.draftRevision,
              moduleKey: recordType.slice(0, separator),
              recordKey: recordType.slice(separator + 1),
              pageSize: 40,
              ...(after === undefined ? {} : { continuationToken: after }),
            },
            signal,
          ),
      );
      switch (result.kind) {
        case "available": {
          const title = result.titleColumn;
          return {
            kind: "available",
            records: result.rows.map((row) => ({
              recordId: row.id,
              label: (title === undefined ? undefined : row.cells[title]) || "Untitled record",
            })),
            ...(result.next === undefined ? {} : { next: result.next }),
          };
        }
        case "not_saved":
          return { kind: "not_saved" };
        // The preview did not reach the saved revision; the picker reads again when opened again.
        case "following":
          return { kind: "temporarily_unavailable" };
        // The saved draft moved on; the next save's revision reads again.
        case "conflict":
          return { kind: "temporarily_unavailable" };
        case "no_query":
          return { kind: "no_list" };
        // A record type is read through a plain query, never a summary.
        case "summary":
          return { kind: "no_list" };
        case "query_refused":
          console.error(
            `[studio] record choices were refused: STUDIO_RECORD_CHOICES_REFUSED reason=${result.reason}`,
          );
          return { kind: "refused" };
        case "refused":
          return { kind: "refused" };
        // The draft cannot run yet; the picker reads again once it can.
        case "not_runnable":
        case "temporarily_unavailable":
          return { kind: "temporarily_unavailable" };
      }
    },
    [organizationId, rootId, view.draftRevision, view.previewShape, draft.preview],
  );
  const applicationName = useCallback(
    (application: string) =>
      applications.find((candidate) => candidate.key === application)?.name ??
      "another application",
    [applications],
  );
  const draftChoices = useMemo(
    () => studioDraftChoices(source, view.borrowedChoices, readRecordChoices, applicationName),
    [source, view.borrowedChoices, readRecordChoices, applicationName],
  );
  // The values the selected block's page declares, which a display can show.
  const blockChoices = useMemo(
    () => ({
      ...draftChoices,
      pageValues: Object.entries(canvasPage?.values ?? {}).map(([key, declaration]) => ({
        key,
        label: declaration.label,
        ...(declaration.currency === undefined ? {} : { currency: declaration.currency }),
      })),
    }),
    [draftChoices, canvasPage],
  );
  // The records of the canvas's data blocks, read once per area for the compiled saved revision,
  // when the builder's preview runs that revision's data shape.
  const readCanvasRecords = useCallback(
    async (
      area: string,
      signal: AbortSignal,
      controlValues: Readonly<Record<string, string>>,
      tableStates: Readonly<Record<string, StudioCanvasGridRead>>,
    ) => {
      const pageAlias = canvasPageRef.current;
      if (pageAlias === undefined) return { state: "unavailable" as const, records: {} };
      const result = await readWhenPreviewReady(
        draft.preview,
        view.draftRevision,
        view.previewShape,
        signal,
        () =>
          readStudioCanvasRecords(
            organizationId,
            {
              rootId,
              draftRevision: view.draftRevision,
              sourceFingerprint: view.sourceFingerprint,
              pageAlias,
              area,
              controlValues,
              tableStates,
            },
            signal,
          ),
      );
      if (
        result.kind === "available" &&
        result.draftRevision === view.draftRevision &&
        result.sourceFingerprint === view.sourceFingerprint &&
        result.pageAlias === pageAlias &&
        result.area === area
      )
        return {
          state: "ready" as const,
          records: result.records,
          ...(result.sample === undefined ? {} : { sample: result.sample }),
        };
      if (result.kind === "refused") return { state: "refused" as const, records: {} };
      if (result.kind === "not_runnable")
        return {
          state: "not_runnable" as const,
          sentence: result.sentence,
          refusal: result.refusal,
          records: {},
        };
      // A conflict means a newer save replaced this revision: its compile reads again, and what is shown stays meanwhile.
      if (result.kind === "conflict") return { state: "superseded" as const, records: {} };
      // A read that is temporarily unavailable is an expected race (logged as information); any other cause is a platform fault.
      (result.kind === "temporarily_unavailable" ? console.info : console.error)(
        `[studio] the canvas records were not read: STUDIO_CANVAS_RECORDS_${result.kind.toUpperCase()}`,
      );
      return { state: "unavailable" as const, records: {} };
    },
    [
      organizationId,
      rootId,
      view.draftRevision,
      view.sourceFingerprint,
      view.previewShape,
      draft.preview,
    ],
  );

  // The page's declared values, added, changed and removed as one undoable edit each.
  const commandPageValue = (command: StudioPageValueCommand): StudioPageValueResult => {
    const outcome = draft.run((current): StudioDraftStep<StudioPageValueResult> => {
      const result = applyStudioPageValue(current, command);
      return result.kind === "applied"
        ? { kind: "edit", source: result.source, result }
        : { kind: "keep", result };
    });
    return outcome.kind === "blocked"
      ? { kind: "refused", reason: outcome.message }
      : outcome.result;
  };

  const commandReaction: Parameters<typeof StudioBlockVisibility>[0]["onReaction"] = (
    expected,
    expectedSelection,
    metadata,
    condition,
    slot,
  ) => {
    const currentSelection = draft.selection.getSelection();
    if (
      currentSelection?.kind !== "placement" ||
      expectedSelection.kind !== "placement" ||
      currentSelection.placementAlias !== expectedSelection.placementAlias
    )
      return { kind: "stale" };
    const outcome = draft.run(
      ():
        | {
            kind: "edit";
            source: ApplicationSourceDocument;
            result: ReturnType<typeof applyStudioReactionCondition>;
          }
        | {
            kind: "keep";
            result: ReturnType<typeof applyStudioReactionCondition>;
          } => {
        const result = applyStudioReactionCondition(
          expected,
          liveContext(),
          currentSelection,
          metadata,
          condition,
          slot,
        );
        return result.kind === "applied"
          ? { kind: "edit", source: result.source, result }
          : { kind: "keep", result };
      },
      { merge: `${slot}:${currentSelection.placementAlias}` },
    );
    return outcome.kind === "done" ? outcome.result : { kind: "stale" };
  };

  // The application's and a page's name and description, typed straight into the draft.
  const selectedPage =
    selected?.kind === "page"
      ? source.body.pages.find((page) => page.id === selected.pageAlias)
      : undefined;
  const editable =
    inspector.status === "resolved" &&
    (selected?.kind === "application" || selectedPage !== undefined);
  const setLabels = (name: string, description: string): string | true => {
    const outcome = draft.run<string | true>(
      (current) => {
        const applied = applyStudioItemLabels(
          current,
          draft.selection.getSelection(),
          name,
          description,
        );
        return applied.kind === "applied"
          ? { kind: "edit", source: applied.source, result: true as const }
          : {
              kind: "keep",
              result:
                applied.kind === "invalid"
                  ? "Enter a name and description within their length limits."
                  : "This item is not in the draft any more.",
            };
      },
      { merge: `labels:${selectionKey}` },
    );
    return outcome.kind === "blocked" ? outcome.message : outcome.result;
  };

  const previewAs = (roleKey: string) => {
    const role = source.body.roles.find((entry) => entry.key === roleKey);
    if (role === undefined || view.frames?.roles[roleKey] === undefined) {
      setNotice(
        "The preview shows a role as the saved draft grants it; wait a moment for your latest change to save.",
      );
      return;
    }
    setViewAs(roleKey);
    const start = source.body.pages.find((page) => page.key === role.home_page);
    if (start === undefined) return;
    openTab("structure");
    draft.select({ kind: "page", pageAlias: start.id });
  };

  const pageLabel = (pageAlias: string, fallback: string) =>
    labels.get(studioSemanticSelectionKey({ kind: "page", pageAlias })) ?? fallback;
  // The layout open in Outline: selected directly, or the layout that holds the selected block.
  const ownerShellKey =
    selected?.kind === "shell"
      ? selectionKey
      : selectedOwner?.kind === "shell"
        ? studioSemanticSelectionKey(selectedOwner)
        : undefined;
  const breadcrumbItem =
    canvasPage !== undefined && ownerShellKey === undefined
      ? pageLabel(canvasPage.id, canvasPage.name)
      : ownerShellKey === undefined
        ? undefined
        : labels.get(ownerShellKey);
  // The page or layout whose blocks the Outline tab lists and searches.
  const outlineOwnerKey =
    canvasPage !== undefined && ownerShellKey === undefined
      ? studioSemanticSelectionKey({ kind: "page", pageAlias: canvasPage.id })
      : ownerShellKey;
  const selectedName = selected === null ? undefined : labels.get(selectionKey);
  const usedIn = studioUseTargetOf(selected);
  const title =
    canvasPage !== undefined && ownerShellKey === undefined
      ? pageLabel(canvasPage.id, canvasPage.name)
      : inspector.status === "resolved"
        ? (selectedName ?? inspector.descriptor.label)
        : "Select an item";
  const panels = (
    <>
      <StudioOutlinePanel
        hidden={tab !== "outline"}
        pageOpen={canvasPage !== undefined}
        outline={outline}
        ownerKey={outlineOwnerKey}
        selectedKey={selectionKey}
        choose={(node) => {
          if (node.selection !== null) draft.select(node.selection);
        }}
        levels={
          canvasPage === undefined
            ? undefined
            : studioPageNestingLevels(catalogue, state.source, canvasPage.id)
        }
      />
      <StudioPanelShell
        title="Blocks"
        description={
          addOwner?.kind === "layout"
            ? "Blocks to add to the selected layout. Drag a block onto the layout, or use Add."
            : "Blocks to add to the page on the canvas. Drag a block onto the page, or use Add."
        }
        hidden={tab !== "blocks"}
      >
        {/* Drawn inside the workspace's Puck editor, so its blocks drag with the canvas's own drag and drop. */}
        <StudioBlocksPanel />
        {canvasPage === undefined && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon name="blocks" />
              </EmptyMedia>
              <EmptyTitle>No page open</EmptyTitle>
              <EmptyDescription>
                {layoutAlias === undefined
                  ? "Choose a page in Structure to add blocks."
                  : "No page uses this layout yet. Give a page this layout in Structure to add blocks to it."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </StudioPanelShell>
    </>
  );

  const inspectorPanel = (
    <StudioInspector
      inspector={inspector}
      labelsKey={selectionKey}
      title={inspector.status === "resolved" ? (selectedName ?? inspector.descriptor.label) : ""}
      labels={
        editable
          ? {
              isApplication: selected?.kind === "application",
              label:
                selected?.kind === "application" ? source.body.name : (selectedPage?.name ?? ""),
              description: source.body.description,
              disabled: draft.locked,
              onLabel: (value) => setLabels(value, source.body.description),
              onDescription: (value) =>
                setLabels(
                  selected?.kind === "application" ? source.body.name : (selectedPage?.name ?? ""),
                  value,
                ),
            }
          : undefined
      }
      extraActions={selected?.kind === "flow" ? flowDeleteActions : []}
      note={
        selected?.kind === "placement"
          ? undefined
          : selected?.kind === "flow" || selected?.kind === "flow_step"
            ? tab === "flows"
              ? undefined
              : "Open this flow in the Flows tab to change it."
            : selected === null
              ? undefined
              : selected.kind === "navigation"
                ? "Change this menu entry in the Menu tab."
                : selected.kind === "shell"
                  ? undefined
                  : selected.kind === "role"
                    ? tab === "access"
                      ? undefined
                      : "Change this role in the Access tab."
                    : selected.kind === "module" ||
                        selected.kind === "record_type" ||
                        selected.kind === "field" ||
                        selected.kind === "query"
                      ? "Change this in the Data tab."
                      : "This item cannot be edited here."
      }
    >
      {selected?.kind === "shell" &&
        source.body.shells
          .filter((shell) => shell.id === selected.shellAlias)
          .map((shell) => (
            <StudioLayoutOutlets
              key={shell.id}
              locked={draft.locked}
              catalogue={catalogue}
              describePlacement={describePlacement}
              command={structure.command}
              shell={shell}
            />
          ))}
      {(selected?.kind === "flow" || selected?.kind === "flow_step") &&
        tab === "flows" &&
        inspector.status === "resolved" &&
        flowsInspector}
      {selected?.kind === "placement" && inspector.status === "resolved" && (
        <ApplicationCompositionEditor
          key={selectionKey}
          context={compositionContext}
          selection={selected}
          disabled={draft.locked}
          choices={blockChoices}
          compiledFields={view.compiledFields}
          canvasArrangement={studioCanvasGridArrangement(gridStates.get(selected.placementAlias))}
          onCommand={commandComposition}
          onNewQuery={(use) => setQuerySheet({ use })}
        />
      )}
      {selected?.kind === "placement" && inspector.status === "resolved" && (
        <StudioBlockVisibility
          key={`visibility:${draft.lifetime}:${selectionKey}`}
          context={compositionContext}
          selection={selected}
          saved={draft.saved}
          disabled={draft.locked}
          onCommand={commandComposition}
          onReaction={commandReaction}
        />
      )}
      {selected?.kind === "page" && inspector.status === "resolved" && (
        <StudioPageValuesPanel
          source={source}
          pageAlias={selected.pageAlias}
          disabled={draft.locked}
          onEdit={commandPageValue}
        />
      )}
      {inspector.status === "resolved" && placementWorkflows}
      {selected?.kind === "placement" && (
        <StudioLayoutOutletUses source={source} placementAlias={selected.placementAlias} />
      )}
      {selected?.kind === "flow" && flowDeleteNotice}
      {usedIn !== null && (
        <StudioUsedIn source={source} target={usedIn} name={selectedName ?? "it"} />
      )}
    </StudioInspector>
  );

  // An application with no record type yet says so: in the canvas strip when a page is open (the
  // canvas keeps its height), as the empty state when the application itself is selected.
  const needsFirstRecordType =
    source.body.uses.length === 0 &&
    source.body.modules.every((module) => module.record_types.length === 0);
  const firstRecordTypeNote =
    canvasPage !== undefined && canvasPage.key === source.body.home_page && needsFirstRecordType ? (
      <>
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          Add your first record type
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Add your first record type: open the Data tab"
                onClick={() => openTab("data")}
              />
            }
          >
            <Icon name="database" />
          </TooltipTrigger>
          <TooltipContent>
            Add your first record type in the Data tab. A record type is a kind of record people
            keep here, such as assets or companies; then show its records on this page.
          </TooltipContent>
        </Tooltip>
      </>
    ) : undefined;
  // The role the canvas previews says so in the canvas strip, where it cannot move the canvas.
  const viewAsSentence =
    canvasPage !== undefined && viewAsRole !== undefined && viewDecisions !== null
      ? `${
          holdsPermission(viewDecisions, canvasPage.permission)
            ? `Blocks ${viewAsRole.name} cannot see are hidden.`
            : `${viewAsRole.name} cannot open this page; it is shown so you can keep working on it.`
        } Records are from your preview.${
          draft.updatingCanvas ? " Your latest change shows once the canvas is updated." : ""
        }`
      : undefined;
  const viewAsNote =
    viewAsSentence === undefined || viewAsRole === undefined ? undefined : (
      <>
        <Tooltip>
          <TooltipTrigger render={<Badge variant="outline" tabIndex={0} className="shrink-0" />}>
            {`As ${viewAsRole.name}`}
          </TooltipTrigger>
          <TooltipContent>{viewAsSentence}</TooltipContent>
        </Tooltip>
        <span role="status" className="sr-only">
          {viewAsSentence}
        </span>
      </>
    );
  const shown = canvasPage !== undefined && (inspector.status === "resolved" || selected === null);
  const centre = (
    <section
      className={
        canvasPage !== undefined
          ? "flex min-h-0 flex-1 flex-col gap-3"
          : "flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4"
      }
      aria-label="Selected item"
    >
      {notice !== "" && (
        <Alert variant="destructive">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {selected?.kind === "placement" && canvasPage === undefined && (
        <p>This block is part of a layout. Change it in the inspector.</p>
      )}
      {canvasPage === undefined && pageLoading && draft.viewProblem === null && (
        <StudioCanvasSkeleton />
      )}
      {canvasPage === undefined &&
        !pageLoading &&
        selected?.kind !== "flow" &&
        selected?.kind !== "placement" && (
          <Empty className="min-h-64 flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon name="blocks" />
              </EmptyMedia>
              <EmptyTitle>No page open</EmptyTitle>
              <EmptyDescription>Choose a page in Structure, or add one.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      {canvasPage === undefined && selected?.kind === "application" && needsFirstRecordType && (
        <FirstRecordTypeEmptyState
          action={
            <Button type="button" onClick={() => openTab("data")}>
              <Icon name="database" />
              Open the Data tab
            </Button>
          }
        />
      )}
      {canvasPage !== undefined && theme.problem.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>{theme.problem}</AlertDescription>
        </Alert>
      )}
      {canvasPage !== undefined &&
        draft.viewProblem === null &&
        (!shown || fieldInputControlReleases === null || platformThemeTokens === null) && (
          // The page shape stays up until the canvas can draw: the inspector, the field controls
          // and the theme tokens each load before it, and none of them may leave a blank centre. A
          // failed view read is shown as its own alert, so nothing is loading then.
          <StudioCanvasSkeleton />
        )}
      {shown &&
        canvasPage !== undefined &&
        fieldInputControlReleases !== null &&
        platformThemeTokens !== null && (
          // The canvas previews the application in light or dark: the appearance is set on the canvas only, never on Studio's frame.
          <div className="flex min-h-0 flex-1 flex-col">
            {/* A newly chosen icon library loads before the canvas draws with it; only the canvas
                waits, and it shows the page's shape meanwhile rather than a blank area. */}
            <Suspense fallback={<StudioCanvasSkeleton />}>
              <StudioCanvasView
                zoom={canvasZoom}
                onFitZoom={setFitZoom}
                note={
                  <>
                    {viewAsNote}
                    {firstRecordTypeNote}
                  </>
                }
              />
            </Suspense>
          </div>
        )}
    </section>
  );

  const toolbar = (
    inspectorOpen: boolean,
    toggleInspector: (() => void) | undefined,
    centreTitle: string,
    showsCanvas: boolean,
    focused: boolean,
    focusCanvas: () => void,
    loading: boolean,
  ) => (
    <StudioCanvasToolbar
      title={centreTitle}
      zoom={canvasZoom}
      fitZoom={fitZoom}
      onZoom={setCanvasZoom}
      showsCanvas={showsCanvas && canvasPage !== undefined}
      arrangeGrid={arrangeGrid}
      arrangeableGrids={arrangeableGrids}
      locked={draft.locked}
      onArrangeGrid={() => setArrangeGrid((held) => !held)}
      appearance={appearance}
      onAppearance={setAppearance}
      viewAs={{
        value: viewAsRole === undefined ? null : viewAs,
        onChange: setViewAs,
        roles: source.body.roles.filter((role) => view.frames?.roles[role.key] !== undefined),
      }}
      inspectorOpen={inspectorOpen}
      onToggleInspector={toggleInspector}
      focused={focused}
      onFocusCanvas={focusCanvas}
      loading={loading}
    />
  );

  // A selection that changes closes the block dialog opened for the one before.
  useEffect(() => {
    setBlockDialog(null);
  }, [selectionKey]);
  const dialog = (
    <>
      {selected?.kind === "placement" && (
        <StudioBlockDialogs
          open={blockDialog}
          onClose={() => setBlockDialog(null)}
          context={compositionContext}
          selection={selected}
          source={source}
          disabled={draft.locked}
          choices={blockChoices}
          onCommand={commandComposition}
        />
      )}
      <StudioBlockSetupDialog
        request={blockSetup}
        choices={draftChoices}
        onClose={() => setBlockSetup(null)}
      />
      <StudioQuerySheet
        key={querySheet === null ? "query-closed" : "query-open"}
        open={querySheet !== null}
        draft={draft}
        doneLabel="Use this query"
        onClose={() => setQuerySheet(null)}
        onDone={(reference) => {
          querySheet?.use(reference);
          setQuerySheet(null);
        }}
      />
    </>
  );

  // The one Puck editor around the workspace: the page on the canvas, its draft and its selection.
  // Everything is kept as the same value until it really changes, so the canvas does not draw again
  // for an edit that is not its own (typing in the inspector).
  const canvasFrame = useMemo(
    () =>
      canvasPage === undefined
        ? undefined
        : canvasFrameFor(view.frames, canvasPage.id, source, theme.theme, viewDecisions),
    [view.frames, canvasPage?.id, source, theme.theme, viewDecisions],
  );
  const canvasViewer = useMemo(
    () =>
      viewAsRole === undefined || viewDecisions === null
        ? null
        : { roleName: viewAsRole.name, decisions: viewDecisions },
    [viewAsRole, viewDecisions],
  );
  // A click on the canvas's empty ground selects what the canvas shows: the layout, or the page.
  const onSelectPlacement = useStable((alias: string | null) =>
    Promise.resolve(
      alias !== null
        ? draft.select({ kind: "placement", placementAlias: alias })
        : layoutAliasRef.current !== undefined
          ? draft.select({ kind: "shell", shellAlias: layoutAliasRef.current })
          : canvasPageRef.current !== undefined &&
            draft.select({ kind: "page", pageAlias: canvasPageRef.current }),
    ),
  );
  const onPageEdit = useStable(applyPuckPageEdit);
  const onAddBlock = useStable(addBlock);
  const blockActions = useMemo<StudioBlockActions>(
    () => ({
      // Why Move to and Wrap are unavailable for a block, read when the menu opens.
      availability: (alias) => {
        const selection = { kind: "placement", placementAlias: alias } as const;
        if (draft.locked) {
          const reason = draft.blockedReason() ?? "Studio is busy; try again.";
          return { move: reason, wrap: reason };
        }
        const wrap = describeStudioCompositionWrap(compositionContext, selection);
        return {
          move: studioMoveUnavailableReason(
            describeStudioCompositionDestinations(compositionContext, selection),
          ),
          wrap:
            wrap.kind !== "available"
              ? "This block can't be wrapped here."
              : wrap.containers.every((container) => container.unavailable !== undefined)
                ? "No container can hold this block here."
                : undefined,
        };
      },
      open: (alias, which) => {
        if (selected?.kind === "placement" && selected.placementAlias === alias)
          setBlockDialog(which);
        else console.info(`[studio] the block menu of '${alias}' found it no longer selected`);
      },
      mark: () => draft.history.getState().source,
      undoIf: (mark) => {
        if (draft.history.getState().source !== mark) return false;
        draft.undo();
        return true;
      },
    }),
    [draft, compositionContext, selected],
  );
  const palette = useMemo(
    () =>
      addTargets === null
        ? undefined
        : {
            targets: addTargets,
            owner: addOwner?.kind ?? ("page" as const),
            message: paletteMessage,
            onAdd: onAddBlock,
          },
    [addTargets, addOwner?.kind, paletteMessage, onAddBlock],
  );
  const compiledSlots = canvasPage === undefined ? undefined : view.slots?.[canvasPage.id];
  const selectedPlacementAlias = selected?.kind === "placement" ? selected.placementAlias : null;
  const canvasShown = railShowsCanvas(tab);
  const puck = useMemo<StudioPuckInput>(
    () => ({
      source,
      compiledSource: view.source,
      platformBlockCatalogue: catalogue,
      fieldInputControlReleases,
      platformThemeTokens,
      pageAlias: canvasPage?.id,
      layoutAlias,
      compiledSlots,
      frame: canvasFrame,
      viewer: canvasViewer,
      describePlacement,
      selectedPlacementAlias,
      onSelectPlacement,
      canvasShown,
      appearance,
      disabled: draft.locked,
      disabledReason: draft.locked ? draft.blockedReason() : undefined,
      compileFailure: view.failure,
      onChange: onPageEdit,
      readRecords: readCanvasRecords,
      arrangeGrid,
      onArrangeGrid: setArrangeGrid,
      onArrangeableGrids: setArrangeableGrids,
      onGridChange,
      gridReads,
      updating: draft.updatingCanvas,
      palette,
      blockActions,
    }),
    [
      source,
      view.source,
      catalogue,
      fieldInputControlReleases,
      platformThemeTokens,
      canvasPage?.id,
      layoutAlias,
      compiledSlots,
      canvasFrame,
      canvasViewer,
      describePlacement,
      selectedPlacementAlias,
      onSelectPlacement,
      canvasShown,
      appearance,
      draft.locked,
      view.failure,
      onPageEdit,
      readCanvasRecords,
      arrangeGrid,
      onGridChange,
      gridReads,
      draft.updatingCanvas,
      palette,
      blockActions,
    ],
  );

  return {
    puck,
    panels,
    inspector: inspectorPanel,
    centre,
    toolbar,
    dialog,
    title,
    breadcrumbItem,
    compositionContext,
    commandComposition,
    readRecordChoices,
    previewAs,
    readQueries: (borrowed: StudioBorrowedChoices | null) =>
      studioDraftChoices(
        draft.parsed(draft.history.getState().source),
        borrowed,
        null,
        applicationName,
      ).queries,
  };
}
