"use client";

/**
 * The one Puck component config. It is the single place that maps a definition block to UI:
 *
 * - one Puck component per block renderer key, with one slot field per declared child slot and
 *   `defaultProps`; settings, layout and theme are edited by Studio's typed inspector, not Puck;
 * - one `render` function per component, which is the only place a block's React implementation is
 *   bound to a placement. The same render functions serve `<Render>` and the `<Puck>` editor.
 *
 * Layout and spacing are explicit component fields: every container gap, padding, direction and
 * content width is a setting written into the placement (each release property's `defaultValue`
 * is what an inserted placement receives and what materialisation writes), and nothing below the
 * config changes layout because a setting is absent.
 *
 * Page-runtime context (queries, forms, actions, flow runtime) reaches a render function through
 * Puck's `metadata` as `VortexPuckMetadata`; the registry's per-block payload parsers validate it.
 */

import {
  createContext,
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import type { FlowRuntimeState } from "./flow-runtime/flow-runtime";
import { FlowRuntimeStateContext } from "./flow-runtime/flow-runtime-state-context";
import { InlineMessage } from "./flow-runtime/inline-message";
import {
  PlacementReactionsContext,
  useLivePlacementReactions,
} from "./flow-runtime/placement-reactions";
import type { ComponentConfig, Config, Field, PuckContext, SlotComponent } from "@puckeditor/core";
import {
  plainSettingValue,
  readCompiledItemSettings,
  repeatableSlotItemIdentities,
  repeatableSlotKey,
  type BreakpointOrder,
  type CompiledItemVortex,
  type BlockPropertyValueContract,
  type ApplicationPuckRootShell,
  type PlatformBlockRelease,
  type ProjectedNavigation,
} from "@vortex/platform/schema";
import {
  DefinitionRenderError,
  placementSettings,
  validateAccessibleName,
  type PlacementSettingsReader,
  type Breakpoint,
  type DefinitionRenderErrorLocation,
} from "./definition-error";
import {
  computePlacementClassName,
  computePlacementStyle,
  computeResponsiveSelectorCss,
  LAYOUT_CLASS_NAMES,
  RESPONSIVE_BREAKPOINT_ORDER,
  slotGapLength,
  type ResponsivePlacementLayouts,
  type SlotGapName,
} from "./layout-styles";
import { DeferredSlot } from "./deferred-drawing";
import { projectedAvailability } from "./placement-availability";
import {
  EMPTY_RUNTIME_INPUTS,
  type PlatformBlockRuntimeInputs,
  type PlatformComponentRegistry,
  type PlatformComponentRenderer,
  type FieldInputControlReleaseMap,
  type RuntimeInputsByPlacement,
} from "./registry";
import { ApplicationLauncher } from "./launcher/application-launcher";
import { LinkTiles } from "./launcher/link-tiles";
import { ApplicationNavigationBlock } from "./navigation/navigation";
import { ApplicationAccountActionsBlock } from "./navigation/account-actions";
import {
  ApplicationSearchBlock,
  type ApplicationSearchRuntime,
} from "./navigation/application-search-block";
import { Container } from "./layout/container";
import { Heading } from "./layout/heading";
import { NoticeBlock } from "./display/notice";
import { QueryNoticeDisplay } from "./display/query-notice";
import { RecordDetailDisplay } from "./display/record-detail";
import { RichTextDisplay } from "./display/rich-text-component";
import { SummaryValuesDisplay } from "./display/summary-values";
import { ChartDisplay } from "./display/chart";
import { TableDisplay } from "./display/table";
import { PlainTextDisplay } from "./display/text";
import { BooleanInput } from "./controls/boolean-input";
import { Button } from "./controls/button";
import { ChoiceInput } from "./controls/choice-input";
import { DateInput } from "./controls/date-input";
import { Dialog } from "./controls/dialog";
import { Drawer } from "./controls/drawer";
import { FieldInput } from "./controls/field-input";
import { FormContainer } from "./controls/form-container";
import { LinkInput } from "./controls/link-input";
import { NumberInput } from "./controls/number-input";
import { RichTextInput } from "./controls/rich-text-input";
import { Tabs } from "./controls/tabs";
import { AttachmentInput } from "./controls/attachment-input";
import { ConnectionSecretInput } from "./controls/connection-secret-input";
import { TableInput } from "./controls/table-input";
import { TextInput } from "./controls/text-input";
import { ValidationMessage } from "./controls/validation-message";
import { SearchAttachmentDisplay } from "./search-attachment-blocks";
import { CustomComponentHost } from "./custom-component/custom-component-host";
import { ApplicationShellRoot, type ApplicationShellRuntime } from "./navigation/application-shell";

// ---------------------------------------------------------------------------------------------
// Page-runtime context
// ---------------------------------------------------------------------------------------------

/**
 * What the page runtime supplies to every render function through Puck's `metadata`. It is the
 * only channel for runtime data, so `<Render>`, `<Puck>` and the page runtime feed the same
 * components the same way. Everything is optional: an editor has no query results to show.
 */
export type VortexPuckMetadata = Readonly<{
  /**
   * Explicit preview breakpoint, rendered with that breakpoint's inline geometry. Absent for a
   * live page, which adapts to the visitor's width through responsive CSS.
   */
  breakpoint?: Breakpoint | undefined;
  /**
   * Who emits each placement's responsive geometry. `placement` (the default) makes every
   * placement wrapper carry its own scoped rules, as `<Render>` and the editor need; `page` is for
   * a host that already emits one scoped stylesheet for the whole resolved tree.
   */
  layoutCss?: "placement" | "page" | undefined;
  /** Raw component runtime inputs by stable placement identity, validated per block. */
  runtimeInputs?: RuntimeInputsByPlacement | undefined;
  /** In-flight flow state, observed separately by each placement. */
  runtimeState?: FlowRuntimeState | undefined;
  /** Permission-filtered application menu threaded to navigation placements. */
  projectedNavigation?: ProjectedNavigation | undefined;
  /** Page-address resolver supplied by the shell. */
  resolvePageHref?: ((pageId: string) => string) | undefined;
  /** Internal page identity currently shown. */
  currentPageId?: string | undefined;
  /** Configured dedicated component origin, for the sandboxed custom-component host. */
  componentBundleOrigin?: string | undefined;
  /** Runtime names and permitted links used by the definition-selected root shell. */
  applicationShellRuntime?: ApplicationShellRuntime | undefined;
  /** Protected search results loaded for this page's definition-placed search block. */
  applicationSearch?: ApplicationSearchRuntime | undefined;
  /** Record subject preserved when submitting application search from a detail page. */
  applicationSearchPageSubject?: string | undefined;
  /**
   * How every placement's settings are read. The host always supplies it: a runtime page reads
   * its published composition, Studio checks every value of the composition being edited.
   */
  readSettings?: PlacementSettingsReader | undefined;
}>;
type FieldInputControlReleases = FieldInputControlReleaseMap;

/**
 * The part of a placement that is not a block setting: the compiled item's `vortex` prop, exactly
 * as the published definition carries it.
 */
type VortexPlacementMeta = Readonly<{
  block: CompiledItemVortex["block"];
  responsive: CompiledItemVortex["responsive"];
  /** The complete tablet and phone order of each child slot; a slot array is its desktop order. */
  slotOrders?: Readonly<Record<string, BreakpointOrder>>;
  availability?: "unavailable";
  unavailableReason?: "operation_unavailable";
  visibilityCondition?: CompiledItemVortex["visibilityCondition"];
  requiredCondition?: CompiledItemVortex["requiredCondition"];
  readOnlyCondition?: CompiledItemVortex["readOnlyCondition"];
  enabledCondition?: CompiledItemVortex["enabledCondition"];
  reactions?: Readonly<{ required?: boolean; readOnly?: boolean; enabled?: boolean }>;
}>;

type PlacementSettings = Readonly<Record<string, BlockPropertyValueContract>>;

/**
 * Props every component of the config receives: the compiled item's props. Each declared setting is
 * its own prop holding its typed value; slot props are `SlotComponent` functions.
 */
type VortexPuckComponentProps = Readonly<{
  id: string;
  vortex: VortexPlacementMeta;
  puck: PuckContext;
  /** Host-owned wrapper additions; the page runtime passes grid-item geometry here. */
  wrapper?: Readonly<{ className?: string | undefined; style?: CSSProperties | undefined }>;
  /**
   * Slot content the host has already rendered, by slot key. The page runtime orders and renders
   * each slot itself and passes the nodes here, so React keeps their identity between renders;
   * `<Render>` and the editor supply Puck `SlotComponent` props instead.
   */
  slotNodes?: Readonly<Record<string, ReactNode>>;
}> &
  Readonly<Record<string, unknown>>;

const ThemeTokensContext = createContext<Readonly<Record<string, unknown>>>({});

/**
 * The page root's resolved slot gap. It travels by context rather than a CSS variable so slots
 * rendered through a portal (dialogs, drawers), which sit outside the root's DOM subtree, get it.
 */
const RootSlotGapContext = createContext<string | undefined>(undefined);

/**
 * Supplies the page root's slot gap to the placements below it. The page content rendered in a
 * frame's outlet supplies its own root's gap, so its placements never depend on the frame's root.
 */
export function RootSlotGapProvider({
  gap,
  children,
}: Readonly<{ gap: SlotGapName; children: ReactNode }>) {
  return (
    <RootSlotGapContext.Provider value={slotGapLength(gap)}>{children}</RootSlotGapContext.Provider>
  );
}

/** Which placement the editor has selected; each placement reads only whether it is that one. */
export type SelectedPlacementStore = Readonly<{
  get: () => string | undefined;
  /** Whether the placement holds the selected one, at any depth. */
  holds: (placementId: string) => boolean;
  /** The selected placement and the placements that hold it (nearest first). */
  set: (placementId: string | undefined, holders?: readonly string[]) => void;
  subscribe: (listener: () => void) => () => void;
}>;

export const createSelectedPlacementStore = (): SelectedPlacementStore => {
  let selected: string | undefined;
  let holders: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  return {
    get: () => selected,
    holds: (placementId) => holders.has(placementId),
    set: (placementId, holding = []) => {
      const same = placementId === selected && holding.join("\n") === [...holders].join("\n");
      if (same) return;
      selected = placementId;
      holders = new Set(holding);
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

/** A live page selects nothing. */
const NO_SELECTION: SelectedPlacementStore = createSelectedPlacementStore();

const SelectedPlacementContext = createContext<SelectedPlacementStore>(NO_SELECTION);

/**
 * Tells the placements below it which one the editor has selected, so an empty slot of the selected
 * block can show its hint. Only the editor supplies it; a live page never does.
 */
export function SelectedPlacementProvider({
  store,
  children,
}: Readonly<{ store: SelectedPlacementStore; children: ReactNode }>) {
  return (
    <SelectedPlacementContext.Provider value={store}>{children}</SelectedPlacementContext.Provider>
  );
}

/** Supplies the application's theme tokens to custom components. */
export function VortexPuckThemeTokensProvider({
  tokens,
  children,
}: Readonly<{ tokens: Readonly<Record<string, unknown>>; children: ReactNode }>): ReactElement {
  return <ThemeTokensContext.Provider value={tokens}>{children}</ThemeTokensContext.Provider>;
}

// ---------------------------------------------------------------------------------------------
// Block implementations: the one table that binds a renderer key to its React component
// ---------------------------------------------------------------------------------------------

// The heavy blocks load on demand: a page that places none of them never downloads their code. The
// server still renders them (the lazy boundary suspends and streams), and the registry stays the
// one table that binds a renderer key to its component.
const lazyBlock = (load: () => Promise<PlatformComponentRenderer>): PlatformComponentRenderer => {
  const Block = lazy(async () => ({ default: await load() }));
  const LazyBlock: PlatformComponentRenderer = (props) => (
    <Suspense fallback={null}>
      <Block {...props} />
    </Suspense>
  );
  return LazyBlock;
};

const IMPLEMENTATIONS: ReadonlyMap<string, PlatformComponentRenderer> = new Map<
  string,
  PlatformComponentRenderer
>([
  ["platform.renderer.container", Container],
  ["platform.renderer.heading", Heading],
  ["platform.renderer.tabs", Tabs],
  ["platform.renderer.dialog", Dialog],
  ["platform.renderer.drawer", Drawer],
  ["platform.renderer.text", PlainTextDisplay],
  ["platform.renderer.rich_text", RichTextDisplay],
  ["platform.renderer.table", TableDisplay],
  ["platform.renderer.record_detail", RecordDetailDisplay],
  ["platform.renderer.summary_values", SummaryValuesDisplay],
  ["platform.renderer.chart", ChartDisplay],
  ["platform.renderer.notice", NoticeBlock],
  ["platform.renderer.query_notice", QueryNoticeDisplay],
  [
    "platform.renderer.calendar",
    lazyBlock(async () => (await import("./display/calendar")).CalendarDisplay),
  ],
  ["platform.renderer.attachment_list", SearchAttachmentDisplay],
  ["platform.renderer.form_container", FormContainer],
  ["platform.renderer.field_input", FieldInput],
  ["platform.renderer.text_input", TextInput],
  ["platform.renderer.table_input", TableInput],
  ["platform.renderer.attachment_input", AttachmentInput],
  ["platform.renderer.connection_secret_input", ConnectionSecretInput],
  ["platform.renderer.link_input", LinkInput],
  ["platform.renderer.rich_text_input", RichTextInput],
  ["platform.renderer.number_input", NumberInput],
  ["platform.renderer.boolean_input", BooleanInput],
  ["platform.renderer.date_input", DateInput],
  ["platform.renderer.choice_input", ChoiceInput],
  ["platform.renderer.validation_message", ValidationMessage],
  ["platform.renderer.button", Button],
  ["platform.renderer.application_navigation", ApplicationNavigationBlock],
  ["platform.renderer.account_actions", ApplicationAccountActionsBlock],
  ["platform.renderer.application_search", ApplicationSearchBlock],
  ["platform.renderer.application_launcher", ApplicationLauncher],
  ["platform.renderer.link_tiles", LinkTiles],
]);

const implementationFor = (release: PlatformBlockRelease): PlatformComponentRenderer => {
  if (release.customComponent !== undefined) return CustomComponentHost;
  const implementation = IMPLEMENTATIONS.get(release.rendererKey);
  if (implementation === undefined)
    throw new DefinitionRenderError(
      "ABSENT_RENDERER_KEY",
      `Block '${release.key}' (${release.blockId}:${release.releaseVersion}) has no component in the Puck config for renderer key '${release.rendererKey}'`,
      { blockId: release.blockId, releaseVersion: release.releaseVersion },
    );
  return implementation;
};

// ---------------------------------------------------------------------------------------------
// Explicit layout and spacing
// ---------------------------------------------------------------------------------------------

/** The settings a block receives when it is inserted: each declared property's own default. */
const defaultSettingsFor = (release: PlatformBlockRelease): PlacementSettings => {
  const defaults: Record<string, BlockPropertyValueContract> = {};
  for (const property of release.properties)
    if (property.defaultValue !== undefined) defaults[property.key] = property.defaultValue;
  return defaults;
};

/** The slot gap of a page root: a stored root holds none, so the runtime and the canvas both take this. */
export const PAGE_ROOT_GAP: SlotGapName = "medium";

const isSlotGapName = (value: string): value is SlotGapName =>
  value === "none" || value === "small" || value === "medium" || value === "large";

/**
 * The gap between the children of one of this placement's slots: the placement's own declared
 * `gap` setting, or, for a block that declares none, the page root's gap.
 */
const slotGapFor = (
  release: PlatformBlockRelease,
  settings: PlacementSettings,
  rootGap: string | undefined,
  location: DefinitionRenderErrorLocation,
): string => {
  if (!release.properties.some((property) => property.key === "gap")) {
    if (rootGap === undefined)
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Block '${release.key}' renders outside a page root that supplies a slot gap`,
        location,
      );
    return rootGap;
  }
  const value = settings.gap;
  if (value?.kind !== "choice" || !isSlotGapName(value.value))
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `Block '${release.key}' needs an explicit gap setting`,
      { ...location, propertyPath: ["gap"] },
    );
  return slotGapLength(value.value);
};

// ---------------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------------

/**
 * Whether a slot is what its block is for: a container's content, the content of each tab. The
 * editor keeps a placeholder in such a slot at rest, as in a slot the release requires, so an
 * empty container or tabs block can be found and filled. The one place that says which they are.
 */
const holdsContent = (slot: PlatformBlockRelease["slots"][number]): boolean =>
  slot.key === "content" || slot.repeats !== undefined;

/**
 * The slot fields a placement of this release has, given its settings, with their declared name
 * and whether the editor keeps a placeholder in them while they are empty.
 */
const declaredSlots = (
  release: PlatformBlockRelease,
  settings: PlacementSettings,
): readonly Readonly<{ key: string; label: string; required: boolean }>[] =>
  release.slots.flatMap((slot) =>
    (slot.repeats === undefined
      ? [slot.key]
      : repeatableSlotItemIdentities(slot, settings).map((identity) =>
          repeatableSlotKey(slot.key, identity),
        )
    ).map((key) => ({ key, label: slot.label, required: slot.required || holdsContent(slot) })),
  );

/**
 * How an empty slot is presented in the editor, in one place (the rules are in the layout styles).
 * A required slot, or the one that holds its block's content, keeps its placeholder. An optional
 * one draws nothing at rest, shows its drop target while a block is dragged and a small hint while
 * its own block is selected, each labelled with the slot's name. A live page has none of this.
 */
const slotClassName = (editing: boolean, required: boolean, selected: boolean): string =>
  !editing
    ? "vortex-puck-slot"
    : `vortex-puck-slot ${required ? "vortex-puck-slot--required" : "vortex-puck-slot--optional"}${selected ? " vortex-puck-slot--selected" : ""}`;

/** A CSS string for the slot's name: backslash and quote escaped, a line break as a CSS escape. */
const cssString = (text: string): string =>
  `"${text
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, "\\A ")
    .replace(/\p{Cc}/gu, " ")}"`;

const slotLabelStyle = (label: string): CSSProperties =>
  ({ "--vortex-slot-label": cssString(label) }) as CSSProperties;

// ---------------------------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------------------------

const ownEntry = <Value,>(
  entries: Readonly<Record<string, Value>> | undefined,
  key: string,
): Value | undefined =>
  entries !== undefined && Object.hasOwn(entries, key) ? entries[key] : undefined;

const isSlotComponent = (value: unknown): value is SlotComponent => typeof value === "function";

const cssAttributeValue = (value: string): string =>
  value.replace(/[^A-Za-z0-9_-]/gu, (c) => `\\${(c.codePointAt(0) ?? 0xfffd).toString(16)} `);

/**
 * The geometry of a placement's wrapper: whether it is a grid item, its class name and its inline
 * style. A live page adapts through scoped media rules, so only an explicit preview breakpoint
 * (Studio's canvas) carries inline geometry. The wrapper and every placeholder drawn in its place
 * use this one function, so they can never differ.
 */
export const placementWrapperGeometry = (
  responsive: ResponsivePlacementLayouts | undefined,
  breakpoint: Breakpoint | undefined,
): Readonly<{ gridChild: boolean; className: string; style: CSSProperties }> => {
  if (responsive === undefined)
    return {
      gridChild: false,
      className: computePlacementClassName(undefined),
      style: computePlacementStyle(undefined),
    };
  return {
    gridChild: RESPONSIVE_BREAKPOINT_ORDER.some(
      (candidate) => responsive[candidate].width.kind === "grid",
    ),
    className:
      breakpoint === undefined
        ? LAYOUT_CLASS_NAMES.placementWrapper
        : computePlacementClassName(responsive[breakpoint]),
    style: breakpoint === undefined ? {} : computePlacementStyle(responsive[breakpoint]),
  };
};

type PlacementBlockProps = {
  registry: PlatformComponentRegistry;
  componentProps: VortexPuckComponentProps;
  fieldInputControlReleases: FieldInputControlReleases;
};

const sameShallow = (left: object, right: object): boolean => {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) =>
      Object.is((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
};

/**
 * One placement. Puck calls the render function of every block again when its selection moves,
 * with the same props; a placement draws again only for a change in its props, or in the context
 * and stores it reads (its own selection among them).
 */
const PlacementBlock = memo(
  PlacementBlockContent,
  (previous: PlacementBlockProps, next: PlacementBlockProps) => {
    const { puck: previousPuck, ...previousRest } = previous.componentProps;
    const { puck: nextPuck, ...nextRest } = next.componentProps;
    return (
      previous.registry === next.registry &&
      previous.fieldInputControlReleases === next.fieldInputControlReleases &&
      sameShallow(previousRest, nextRest) &&
      sameShallow(previousPuck, nextPuck)
    );
  },
);

function PlacementBlockContent(props: PlacementBlockProps): ReactElement {
  const { registry, componentProps, fieldInputControlReleases } = props;
  const { id: placementId, vortex, puck, wrapper } = componentProps;
  const metadataIn = (puck.metadata ?? {}) as VortexPuckMetadata;
  const runtimeState = metadataIn.runtimeState;
  const reactions = useLivePlacementReactions(runtimeState, vortex);
  const subscribe = useCallback(
    (listener: () => void) => runtimeState?.subscribe(placementId, listener) ?? (() => {}),
    [placementId, runtimeState],
  );
  const readRunning = useCallback(
    () => runtimeState?.isRunning(placementId) ?? false,
    [placementId, runtimeState],
  );
  const running = useSyncExternalStore(subscribe, readRunning, () => false);
  const themeTokens = useContext(ThemeTokensContext);
  const selection = useContext(SelectedPlacementContext);
  const selectedHere = useSyncExternalStore(
    selection.subscribe,
    () => selection.get() === placementId,
    () => false,
  );
  const holdsSelected = useSyncExternalStore(
    selection.subscribe,
    () => selection.holds(placementId),
    () => false,
  );
  const rootSlotGap = useContext(RootSlotGapContext);
  const breakpoint = metadataIn.breakpoint;
  const responsive = breakpoint === undefined;
  const activeBreakpoint: Breakpoint = breakpoint ?? "desktop";

  const location = {
    placementId,
    blockId: vortex.block.blockId,
    releaseVersion: vortex.block.releaseVersion,
    breakpoint: activeBreakpoint,
  };
  const registration = registry.get(vortex.block.blockId, vortex.block.releaseVersion);
  if (registration === undefined)
    throw new DefinitionRenderError(
      registry.hasBlockId(vortex.block.blockId) ? "MISMATCHED_RELEASE" : "UNKNOWN_RELEASE",
      `Placement '${placementId}' references unavailable block '${vortex.block.blockId}' release '${vortex.block.releaseVersion}'`,
      location,
    );
  const release = registration.metadata;
  const Implementation = implementationFor(release);
  // Each setting is its own prop holding its plain value; the release declares every one,
  // including those the compiler derives, and gives it its kind.
  const readSettings = metadataIn.readSettings;
  if (readSettings === undefined)
    throw new Error(
      `Placement '${placementId}' is rendered by a host that supplies no settings reader`,
    );
  const settings = placementSettings(componentProps, release, location, readSettings);
  validateAccessibleName(settings, release.capabilities, location);

  // A placement whose use is unavailable stays viewable but never receives an invocable callback,
  // which each block's own context enforces from the availability it receives. The parsed inputs
  // are spread first, so the props every block always receives cannot be replaced.
  const availability = projectedAvailability(
    {
      ...(vortex.availability === undefined
        ? {}
        : { availability: vortex.availability, unavailableReason: vortex.unavailableReason }),
    },
    location,
  );
  const suppliedInputs = ownEntry(metadataIn.runtimeInputs, placementId);
  const parsedInputs: PlatformBlockRuntimeInputs =
    suppliedInputs === undefined
      ? EMPTY_RUNTIME_INPUTS
      : registration.parsePayload(suppliedInputs, location);

  const slotStyle: CSSProperties = { gap: slotGapFor(release, settings, rootSlotGap, location) };
  const slots: Record<string, ReactNode> = {};
  const latestSlots = useRef<Record<string, SlotComponent>>({});
  const stableSlots = useRef<Record<string, SlotComponent>>({});
  for (const { key: slotKey, label: slotLabel, required: slotRequired } of declaredSlots(
    release,
    settings,
  )) {
    const Slot = componentProps[slotKey];
    const hostNode = componentProps.slotNodes?.[slotKey];
    if (isSlotComponent(Slot)) {
      latestSlots.current[slotKey] = Slot;
      stableSlots.current[slotKey] ??= (props) => latestSlots.current[slotKey]!(props);
    }
    const StableSlot = stableSlots.current[slotKey];
    slots[slotKey] =
      hostNode !== undefined ? (
        hostNode
      ) : StableSlot !== undefined ? (
        <DeferredSlot forced={!puck.isEditing || holdsSelected || selectedHere}>
          <StableSlot
            className={slotClassName(puck.isEditing, slotRequired, selectedHere)}
            style={puck.isEditing ? { ...slotStyle, ...slotLabelStyle(slotLabel) } : slotStyle}
          />
        </DeferredSlot>
      ) : null;
  }

  // Visibility, width, grid placement and height come from the placement's own responsive
  // declaration, either inline for an explicit preview breakpoint or as scoped media rules.
  const layout = vortex.responsive[activeBreakpoint];
  const pageEmitsCss = metadataIn.layoutCss === "page";
  const visible = responsive
    ? RESPONSIVE_BREAKPOINT_ORDER.some((candidate) => vortex.responsive[candidate].visible)
    : layout.visible;
  const wrapperScope = cssAttributeValue(placementId);
  const geometry = placementWrapperGeometry(vortex.responsive, breakpoint);
  const gridChild = geometry.gridChild;
  const wrapperClassName = geometry.className;
  const wrapperStyle: CSSProperties = {
    ...wrapper?.style,
    ...geometry.style,
    ...(reactions.visible === false ? { display: "none" } : {}),
  };
  const ownCss =
    responsive && !pageEmitsCss
      ? computeResponsiveSelectorCss(
          `[data-vortex-wrapper-scope="${wrapperScope}"]`,
          vortex.responsive as ResponsivePlacementLayouts,
          true,
        )
      : undefined;

  return (
    <div
      ref={puck.dragRef ?? undefined}
      data-vortex-layout-wrapper=""
      data-vortex-placement-id={placementId}
      data-vortex-block-id={release.blockId}
      data-vortex-block-key={release.key}
      aria-busy={running || undefined}
      hidden={reactions.visible === false}
      {...(responsive && !pageEmitsCss ? { "data-vortex-wrapper-scope": placementId } : {})}
      {...(gridChild ? { "data-vortex-grid-child": "" } : {})}
      {...(responsive
        ? {}
        : {
            "data-vortex-breakpoint": activeBreakpoint,
            "data-vortex-visible": String(layout.visible),
          })}
      className={wrapper?.className ? `${wrapperClassName} ${wrapper.className}` : wrapperClassName}
      style={wrapperStyle}
    >
      {ownCss === undefined ? null : <style>{ownCss}</style>}
      {visible ? (
        <FlowRuntimeStateContext.Provider value={metadataIn.runtimeState}>
          <PlacementReactionsContext.Provider value={reactions}>
            <Implementation
              {...parsedInputs}
              placementId={placementId}
              settings={settings}
              slots={slots}
              breakpoint={activeBreakpoint}
              responsiveLayout={responsive}
              metadata={release}
              fieldInputControlReleases={fieldInputControlReleases}
              themeTokens={themeTokens}
              {...availability}
              {...(metadataIn.projectedNavigation === undefined
                ? {}
                : { projectedNavigation: metadataIn.projectedNavigation })}
              {...(metadataIn.resolvePageHref === undefined
                ? {}
                : { resolvePageHref: metadataIn.resolvePageHref })}
              {...(metadataIn.currentPageId === undefined
                ? {}
                : { currentPageId: metadataIn.currentPageId })}
              {...(metadataIn.componentBundleOrigin === undefined
                ? {}
                : { componentBundleOrigin: metadataIn.componentBundleOrigin })}
              {...(metadataIn.applicationSearch === undefined
                ? {}
                : { applicationSearch: metadataIn.applicationSearch })}
              {...(metadataIn.applicationSearchPageSubject === undefined
                ? {}
                : { applicationSearchPageSubject: metadataIn.applicationSearchPageSubject })}
            />
            <InlineMessage placementId={`retry:${placementId}`} />
          </PlacementReactionsContext.Provider>
        </FlowRuntimeStateContext.Provider>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The config
// ---------------------------------------------------------------------------------------------

type VortexComponentConfig = ComponentConfig<Record<string, unknown>>;

const releasesByRendererKey = (registry: PlatformComponentRegistry) => {
  const releaseByKey = new Map<string, PlatformBlockRelease>();
  for (const { metadata } of registry.list()) {
    if (releaseByKey.has(metadata.rendererKey))
      throw new Error(`Renderer '${metadata.rendererKey}' has more than one registered release`);
    releaseByKey.set(metadata.rendererKey, metadata);
  }
  return releaseByKey;
};

const rendererKeysByCategory = (releaseByKey: ReadonlyMap<string, PlatformBlockRelease>) => {
  const keysByCategory = new Map<string, string[]>();
  for (const [key, release] of releaseByKey) {
    const keys = keysByCategory.get(release.paletteGroup) ?? [];
    keys.push(key);
    keysByCategory.set(release.paletteGroup, keys);
  }
  return keysByCategory;
};

/** Puck's slot field of one declared slot: its name and the blocks it takes. */
const slotField = (
  slot: PlatformBlockRelease["slots"][number],
  keysByCategory: ReadonlyMap<string, readonly string[]>,
): Field => ({
  type: "slot",
  label: slot.label,
  allow: slot.allowedChildCategories.flatMap((category) => keysByCategory.get(category) ?? []),
});

/**
 * The config with a slot field for each key of a repeating slot that a page holds (a tab is stored
 * as `tab_<key>`), by renderer key. Puck finds a slot only through the static `fields` of the
 * config, never through `resolveFields`, so the keys a page uses are declared for the page; a
 * block of that renderer that does not use a key draws nothing for it.
 */
export function withRepeatingSlots(
  registry: PlatformComponentRegistry,
  config: Config,
  keysByRenderer: ReadonlyMap<string, readonly string[]>,
): Config {
  if (keysByRenderer.size === 0) return config;
  const releaseByKey = releasesByRendererKey(registry);
  const keysByCategory = rendererKeysByCategory(releaseByKey);
  const components = { ...config.components } as Record<string, VortexComponentConfig>;
  for (const [rendererKey, keys] of keysByRenderer) {
    const release = releaseByKey.get(rendererKey);
    const component = components[rendererKey];
    if (release === undefined || component === undefined) continue;
    const fields = { ...component.fields } as Record<string, Field>;
    for (const key of keys) {
      const declaration = release.slots.find(
        (slot) => slot.repeats !== undefined && key.startsWith(`${slot.key}_`),
      );
      if (declaration !== undefined) fields[key] = slotField(declaration, keysByCategory);
    }
    components[rendererKey] = { ...component, fields };
  }
  return { ...config, components } as Config;
}

/**
 * Builds the Puck config for every release in the registry: one component per renderer key, typed
 * from that key's one release.
 */
function createVortexPuckConfig(
  registry: PlatformComponentRegistry,
  fieldInputControlReleases: FieldInputControlReleases,
): Config {
  const releaseByKey = releasesByRendererKey(registry);
  const keysByCategory = rendererKeysByCategory(releaseByKey);

  // Only slot fields: Puck finds a block's slots through them. A placement's settings, layout and
  // theme are edited by Studio's own typed inspector, never through Puck fields.
  const buildFields = (release: PlatformBlockRelease, settings: PlacementSettings) => {
    // Every other prop is declared as an object with no fields of its own, so Puck's walk over a
    // placement never reads a key inside it (such as the `content` of `vortex.slotOrders`) as a slot.
    const opaque: Field = { type: "object", objectFields: {} };
    const fields: Record<string, Field> = {
      vortex: opaque,
      ...Object.fromEntries(release.properties.map((property) => [property.key, opaque])),
    };
    for (const slot of release.slots) {
      const keys =
        slot.repeats === undefined
          ? [slot.key]
          : repeatableSlotItemIdentities(slot, settings).map((identity) =>
              repeatableSlotKey(slot.key, identity),
            );
      for (const key of keys) fields[key] = slotField(slot, keysByCategory);
    }
    return fields;
  };

  const components: Record<string, VortexComponentConfig> = {};
  for (const [rendererKey, release] of releaseByKey) {
    implementationFor(release);
    const defaults = defaultSettingsFor(release);
    const hasRepeatableSlot = release.slots.some((slot) => slot.repeats !== undefined);
    components[rendererKey] = {
      label: release.name,
      defaultProps: {
        ...Object.fromEntries(
          Object.entries(defaults).map(([key, value]) => [key, plainSettingValue(value)]),
        ),
        vortex: {
          block: { blockId: release.blockId, releaseVersion: release.releaseVersion },
          responsive: Object.fromEntries(
            RESPONSIVE_BREAKPOINT_ORDER.map((breakpoint) => [
              breakpoint,
              { visible: true, width: { kind: "fill" }, height: { kind: "content" } },
            ]),
          ),
        },
      },
      fields: buildFields(release, defaults),
      resolveFields: (data: { props: Record<string, unknown> }) =>
        buildFields(
          release,
          hasRepeatableSlot
            ? placementSettings(
                data.props,
                release,
                {
                  blockId: release.blockId,
                  releaseVersion: release.releaseVersion,
                },
                readCompiledItemSettings,
              )
            : defaults,
        ),
      render: (componentProps) => (
        <PlacementBlock
          registry={registry}
          fieldInputControlReleases={fieldInputControlReleases}
          componentProps={componentProps as unknown as VortexPuckComponentProps}
        />
      ),
    } as VortexComponentConfig;
  }

  return {
    components,
    root: {
      defaultProps: {
        gap: PAGE_ROOT_GAP,
        padding: "medium",
        applicationShell: { kind: "default" },
      },
      fields: {
        gap: {
          type: "select",
          label: "Gap",
          options: ["none", "small", "medium", "large"].map((value) => ({ label: value, value })),
        },
        padding: {
          type: "select",
          label: "Padding",
          options: ["none", "small", "medium", "large"].map((value) => ({ label: value, value })),
        },
      },
      render: ({
        children,
        puck,
        gap,
        padding,
        applicationShell,
      }: {
        children: ReactNode;
        puck: PuckContext;
        gap: SlotGapName;
        padding: SlotGapName;
        applicationShell: ApplicationPuckRootShell;
      }) => (
        <ApplicationShellRoot
          shell={applicationShell}
          runtime={(puck.metadata as VortexPuckMetadata | undefined)?.applicationShellRuntime}
          contentStyle={
            {
              gap: slotGapLength(gap),
              padding: slotGapLength(padding),
            } as CSSProperties
          }
          {...(puck.isEditing ? { editing: true } : {})}
        >
          <RootSlotGapContext.Provider value={slotGapLength(gap)}>
            {children}
          </RootSlotGapContext.Provider>
        </ApplicationShellRoot>
      ),
    },
  } as unknown as Config;
}

const configs = new WeakMap<
  PlatformComponentRegistry,
  WeakMap<FieldInputControlReleases, Config>
>();

/** The Puck config of a registry and its field-input controls, built once per pair. */
export function getVortexPuckConfig(
  registry: PlatformComponentRegistry,
  fieldInputControlReleases: FieldInputControlReleases,
): Config {
  let byControls = configs.get(registry);
  if (byControls === undefined) {
    byControls = new WeakMap();
    configs.set(registry, byControls);
  }
  let config = byControls.get(fieldInputControlReleases);
  if (config === undefined) {
    config = createVortexPuckConfig(registry, fieldInputControlReleases);
    byControls.set(fieldInputControlReleases, config);
  }
  return config;
}
