import type {
  ApplicationRootId,
  ApplicationSourceDocument,
  ImmutablePlatformBlockCatalogue,
  PlatformBlockRelease,
  BlockPropertySchemaContract,
  SourceBlockPropertyValueContract,
  sourcePlacementLayoutSchema,
} from "@vortex/platform/schema";
import type { StudioBorrowedChoices, StudioPaletteChoice } from "./contextual-palette";
import type { StudioCompositionRemovalReason } from "./composition-references";

export type StudioCompositionBreakpoint = "desktop" | "tablet" | "phone";
export type StudioCompositionLayout = ReturnType<typeof sourcePlacementLayoutSchema.parse>;
/** Local identity only: a command does not grant authority or perform a write. */
export type StudioCompositionContext = Readonly<{
  organizationId: string;
  rootId: ApplicationRootId;
  key: string;
  draftRevision: number;
  localLifetime: number;
  catalogue: ImmutablePlatformBlockCatalogue;
  source: Readonly<ApplicationSourceDocument>;
  /** What the Modules the draft uses offer, from its last compile: the exposed queries a block may read. */
  borrowed: StudioBorrowedChoices | null;
}>;

/** What owns the blocks an edit reaches: a page, or an application layout (shell). */
export type StudioCompositionOwner =
  Readonly<{ kind: "page"; pageAlias: string }> | Readonly<{ kind: "layout"; shellAlias: string }>;

export type StudioCompositionCommand =
  | Readonly<{
      kind: "order";
      breakpoint: StudioCompositionBreakpoint;
      order: readonly string[] | null;
    }>
  | Readonly<{
      kind: "resize";
      breakpoint: StudioCompositionBreakpoint;
      layout: StudioCompositionLayout | null;
    }>
  | Readonly<{ kind: "move"; destination: StudioCompositionDestination }>
  | Readonly<{ kind: "remove" }>
  /** Set or clear only this block's view gate, keeping its settings, content and bindings. */
  | Readonly<{ kind: "gate"; gate: string | null }>
  /**
   * Puts the selected block into a new container block of this release, which takes the block's
   * place. The block keeps its name, settings and orders; the container's first fixed slot that
   * admits the block holds it.
   */
  | Readonly<{
      kind: "wrap";
      blockId: string;
      releaseVersion: string;
      /** The container's own required settings, which the wrap asks for (a dialog's title). */
      settings: StudioCompositionSettings;
    }>
  /**
   * The one settings edit: the block's complete set settings (a declared setting left out takes
   * its default) and, for a block that reads records, the query it reads.
   */
  | Readonly<{ kind: "settings"; settings: StudioCompositionSettings; query: string | null }>
  | Readonly<{
      kind: "add";
      owner: StudioCompositionOwner;
      area: string;
      destination: StudioCompositionDestination;
      index: number;
      blockId: string;
      releaseVersion: string;
      settings: StudioCompositionSettings;
      query: string | null;
    }>;

/** A block's settings by setting key, each a typed authored value of its declared kind. */
export type StudioCompositionSettings = Readonly<Record<string, SourceBlockPropertyValueContract>>;
/** One place on a page or layout a new block can go: a content area's (or layout's) top, or a fixed slot of a block in it. */
export type StudioCompositionAddTarget = Readonly<{
  /** Stable key of this place among the page's places. */
  id: string;
  /** The page content area (its slot address key), or "layout" for a layout's own blocks. */
  area: string;
  destination: StudioCompositionDestination;
  label: string;
  /** How many blocks deep the place is; the top of a content area is 0. */
  depth: number;
  /** The blocks the catalogue admits here. */
  choices: readonly StudioPaletteChoice[];
}>;
/** The containers a selected block can be wrapped in, each with why it cannot when it cannot. */
export type StudioCompositionWrapModel =
  | Readonly<{
      kind: "available";
      containers: readonly Readonly<{
        blockId: string;
        releaseVersion: string;
        name: string;
        description: string;
        /** The slot of the container that would hold the block. */
        slotLabel: string;
        /** Why this container cannot hold the block; absent when it can. */
        unavailable?: string;
        /** The container as the palette knows it: its required settings are asked before wrapping. */
        choice: StudioPaletteChoice;
      }>[];
    }>
  | Readonly<{ kind: "invalid" | "unsupported" }>;
export type StudioCompositionAddTargetsModel =
  | Readonly<{ kind: "available"; targets: readonly StudioCompositionAddTarget[] }>
  | Readonly<{ kind: "invalid" | "unsupported" }>;

export type StudioCompositionSettingsModel =
  | Readonly<{
      kind: "available";
      placementAlias: string;
      signedIn: boolean;
      /** Every setting the block's release declares, in declaration order. */
      properties: readonly BlockPropertySchemaContract[];
      settings: StudioCompositionSettings;
      /** Whether the block reads records from a query, which the settings edit chooses. */
      readsQuery: boolean;
      query: string | null;
    }>
  | Readonly<{ kind: "invalid" | "unsupported" }>;

export type StudioCompositionDestination =
  Readonly<{ kind: "root" }> | Readonly<{ kind: "child"; parentAlias: string; slotKey: string }>;

export type StudioCompositionDestinationModel =
  | Readonly<{
      kind: "available";
      destinations: readonly Readonly<{
        destination: StudioCompositionDestination;
        label: string;
      }>[];
    }>
  | Readonly<{ kind: "unsupported"; reason: "page_kind" | "manifest_mismatch" }>
  | Readonly<{ kind: "invalid" }>;

export type StudioCompositionCommandResult =
  /** `placementAlias` names the new block of an add. */
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocument; placementAlias?: string }>
  /** An add the stored composition refuses; `reason` names the place and the rule. */
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "invalid" | "stale" | "unsupported" }>;

/** What became of one command in the workspace: its kind, and for a refusal why. */
export type StudioCompositionOutcome = Readonly<{
  kind: StudioCompositionCommandResult["kind"];
  reason?: string;
}>;

export type StudioCompositionRemovalModel =
  | Readonly<{ kind: "available"; placementAlias: string; willRemoveUnusedRelease: boolean }>
  | Readonly<{
      kind: "blocked";
      reason: StudioCompositionRemovalReason;
      /** The flow, and its step, that still names this item. */
      flow?: string;
      step?: string;
    }>
  | Readonly<{ kind: "unsupported"; reason: StudioCompositionRemovalUnsupportedReason }>
  | Readonly<{ kind: "invalid" }>;

export type StudioCompositionRemovalUnsupportedReason =
  "page_kind" | "public_page" | "manifest_mismatch" | "repeating_slot" | "has_children";

export type StudioCompositionEditorModel =
  | Readonly<{
      kind: "available";
      placementAlias: string;
      order: readonly string[];
      explicitOrder: boolean;
      responsiveOrder: boolean;
      layout: StudioCompositionLayout;
      explicitLayout: boolean;
      capabilities: Readonly<
        Pick<PlatformBlockRelease["capabilities"], "gridWidth" | "height" | "responsiveVisibility">
      >;
    }>
  | Readonly<{ kind: "invalid" | "unsupported" }>;
