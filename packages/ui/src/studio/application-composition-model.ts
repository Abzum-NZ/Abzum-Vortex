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
  /**
   * The one settings edit: the block's complete set settings (a declared setting left out takes
   * its default) and, for a block that reads records, the query it reads.
   */
  | Readonly<{ kind: "settings"; settings: StudioCompositionSettings; query: string | null }>
  | Readonly<{
      kind: "add";
      pageAlias: string;
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
/** One place on a page a new block can go: a content area's top, or a fixed slot of a block in it. */
export type StudioCompositionAddTarget = Readonly<{
  /** Stable key of this place among the page's places. */
  id: string;
  /** The page content area (its slot address key). */
  area: string;
  destination: StudioCompositionDestination;
  label: string;
  /** How many blocks deep the place is; the top of a content area is 0. */
  depth: number;
  /** The blocks the catalogue admits here. */
  choices: readonly StudioPaletteChoice[];
}>;
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
  | Readonly<{ kind: "invalid" | "unsupported" }>;

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
  | Readonly<{ kind: "blocked"; reason: StudioCompositionRemovalReason }>
  | Readonly<{ kind: "invalid" | "unsupported" }>;

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
