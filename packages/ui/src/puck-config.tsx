"use client";

/**
 * The one Puck component config. It is the single place that maps a definition block to UI:
 *
 * - one Puck component per block renderer key, with typed `fields` (one editor per declared
 *   property, one slot field per declared child slot) and `defaultProps`;
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
  Suspense,
  useContext,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ComponentConfig, Config, Field, PuckContext, SlotComponent } from "@puckeditor/core";
import {
  repeatableSlotItemIdentities,
  repeatableSlotKey,
  type BreakpointOrder,
  type CompiledItemVortex,
  type BlockPropertySchemaContract,
  type BlockPropertyValueContract,
  type ApplicationPuckRootShell,
  type PlatformBlockRelease,
  type ProjectedNavigation,
  themeColorSchema,
} from "@vortex/platform/schema";
import { Checkbox } from "./components/checkbox";
import { Input } from "./components/input";
import { Label } from "./components/label";
import { NativeSelect, NativeSelectOption } from "./components/native-select";
import { Textarea } from "./components/textarea";
import {
  DefinitionRenderError,
  validateAccessibleName,
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
import { projectedAvailability } from "./placement-availability";
import {
  EMPTY_RUNTIME_INPUTS,
  type PlatformBlockRuntimeInputs,
  type PlatformComponentRegistry,
  type PlatformComponentRenderer,
  type FieldInputControlReleaseMap,
  type RuntimeInputsByPlacement,
} from "./registry";
import { resolvePlacementTheme, type PlacementThemeScope, type PlatformThemeTokens } from "./theme";
import { ApplicationLauncher } from "./launcher/application-launcher";
import { LinkTiles } from "./launcher/link-tiles";
import { ViewFilter } from "./launcher/view-filter";
import { ApplicationNavigationBlock } from "./navigation/navigation";
import { ApplicationAccountActionsBlock } from "./navigation/account-actions";
import {
  ApplicationSearchBlock,
  type ApplicationSearchRuntime,
} from "./navigation/application-search-block";
import { Container } from "./layout/container";
import { Heading } from "./layout/heading";
import { ListDisplay } from "./display/list";
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
  /** Permission-filtered application menu threaded to navigation placements. */
  projectedNavigation?: ProjectedNavigation | undefined;
  /** Page-address resolver supplied by the shell. */
  resolvePageHref?: ((pageId: string) => string) | undefined;
  /** Internal page activation supplied by the shell for client-side page transitions. */
  onNavigatePage?: ((pageId: string, event: MouseEvent<HTMLAnchorElement>) => void) | undefined;
  /** Intent to open an internal page, so the shell can start loading it before the click. */
  onPrefetchPage?: ((pageId: string) => void) | undefined;
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
}>;
type FieldInputControlReleases = FieldInputControlReleaseMap;

/**
 * The part of a placement that is not a block setting: the compiled item's `vortex` prop, exactly
 * as the published definition carries it.
 */
export type VortexPlacementMeta = Readonly<{
  block: CompiledItemVortex["block"];
  responsive: CompiledItemVortex["responsive"];
  themeOverrides: CompiledItemVortex["themeOverrides"];
  /** The complete tablet and phone order of each child slot; a slot array is its desktop order. */
  slotOrders?: Readonly<Record<string, BreakpointOrder>>;
  availability?: "unavailable";
  unavailableReason?: "operation_unavailable";
}>;

type PlacementSettings = Readonly<Record<string, BlockPropertyValueContract>>;

/**
 * Props every component of the config receives: the compiled item's props. Each declared setting is
 * its own prop holding its typed value; slot props are `SlotComponent` functions.
 */
export type VortexPuckComponentProps = Readonly<{
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

const EMPTY_THEME_SCOPE: PlacementThemeScope = Object.freeze({ application: {}, inherited: {} });

/** Theme tokens in force for nested placements when the host supplies no explicit scope. */
const ThemeScopeContext = createContext<PlacementThemeScope>(EMPTY_THEME_SCOPE);

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

/** Seeds the root tokens while descendant placements inherit their nearest themed ancestor. */
export function VortexPuckThemeScopeProvider({
  scope,
  children,
}: Readonly<{ scope: PlacementThemeScope; children: ReactNode }>): ReactElement {
  return <ThemeScopeContext.Provider value={scope}>{children}</ThemeScopeContext.Provider>;
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
  ["platform.renderer.list", ListDisplay],
  ["platform.renderer.table", TableDisplay],
  ["platform.renderer.record_detail", RecordDetailDisplay],
  [
    "platform.renderer.grouped_data",
    lazyBlock(async () => (await import("./display/grouped-data")).GroupedDataDisplay),
  ],
  ["platform.renderer.summary_values", SummaryValuesDisplay],
  ["platform.renderer.chart", ChartDisplay],
  ["platform.renderer.notice", NoticeBlock],
  ["platform.renderer.query_notice", QueryNoticeDisplay],
  [
    "platform.renderer.calendar",
    lazyBlock(async () => (await import("./display/calendar")).CalendarDisplay),
  ],
  [
    "platform.renderer.board",
    lazyBlock(async () => (await import("./display/board")).BoardDisplay),
  ],
  ["platform.renderer.attachment_list", SearchAttachmentDisplay],
  ["platform.renderer.form_container", FormContainer],
  ["platform.renderer.field_input", FieldInput],
  ["platform.renderer.text_input", TextInput],
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
  ["platform.renderer.view_filter", ViewFilter],
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

type TaggedValue = BlockPropertyValueContract | undefined;

const jsonText = (value: TaggedValue): string =>
  value === undefined ? "" : JSON.stringify(value, null, 2);

/**
 * Edits a value whose kind has no dedicated control as its canonical, kind-tagged JSON. The text
 * follows the incoming value (undo, redo, an external change) until the person edits it; their
 * in-progress text is then kept until it is committed or discarded on blur.
 */
function JsonValueEditor(props: {
  id: string;
  name: string;
  value: TaggedValue;
  readOnly: boolean | undefined;
  onChange: (value: TaggedValue) => void;
}): ReactElement {
  const canonical = jsonText(props.value);
  const [text, setText] = useState(canonical);
  const [seen, setSeen] = useState(canonical);
  const [editing, setEditing] = useState(false);
  if (canonical !== seen) {
    setSeen(canonical);
    if (!editing) setText(canonical);
  }
  return (
    <Textarea
      id={props.id}
      name={props.name}
      disabled={props.readOnly}
      value={text}
      spellCheck={false}
      className="font-mono text-xs"
      onChange={(event) => {
        setText(event.currentTarget.value);
        setEditing(true);
      }}
      onBlur={() => {
        if (!editing) return;
        setEditing(false);
        const trimmed = text.trim();
        if (trimmed.length === 0) return props.onChange(undefined);
        try {
          props.onChange(JSON.parse(trimmed) as BlockPropertyValueContract);
        } catch {
          setText(canonical);
        }
      }}
    />
  );
}

/** One property's Puck field: an editor for exactly that property's kind-tagged value. */
const propertyField = (property: BlockPropertySchemaContract): Field => ({
  type: "custom",
  label: property.label,
  render: ({ id, name, value, onChange, readOnly }): ReactElement => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{property.label}</Label>
      {renderPropertyEditor(property, { id, name, value, onChange, readOnly })}
    </div>
  ),
});

/** The control that edits one property's kind-tagged value. */
const renderPropertyEditor = (
  property: BlockPropertySchemaContract,
  {
    id,
    name,
    value,
    onChange,
    readOnly,
  }: {
    id: string;
    name: string;
    value: TaggedValue;
    onChange: (value: TaggedValue) => void;
    readOnly: boolean | undefined;
  },
): ReactElement => {
  switch (property.kind) {
    case "text":
      return (
        <Input
          id={id}
          name={name}
          disabled={readOnly}
          value={value?.kind === "text" ? value.value : ""}
          maxLength={property.maxLength}
          onChange={(event) =>
            onChange(
              event.target.value.length === 0
                ? undefined
                : { kind: "text", value: event.target.value },
            )
          }
        />
      );
    case "url":
      return (
        <Input
          id={id}
          name={name}
          type="url"
          disabled={readOnly}
          value={value?.kind === "url" ? value.value : ""}
          onChange={(event) =>
            onChange(
              event.target.value.length === 0
                ? undefined
                : { kind: "url", value: event.target.value },
            )
          }
        />
      );
    case "number":
      return (
        <Input
          id={id}
          name={name}
          type="number"
          disabled={readOnly}
          {...(property.minimum === undefined ? {} : { min: property.minimum })}
          {...(property.maximum === undefined ? {} : { max: property.maximum })}
          step={property.integer ? 1 : "any"}
          value={value?.kind === "number" ? value.value : ""}
          onChange={(event) =>
            onChange(
              event.target.value.length === 0 || !Number.isFinite(Number(event.target.value))
                ? undefined
                : { kind: "number", value: Number(event.target.value) },
            )
          }
        />
      );
    case "boolean":
      return (
        <Checkbox
          id={id}
          name={name}
          disabled={readOnly}
          checked={value?.kind === "boolean" ? value.value : false}
          onCheckedChange={(checked) => onChange({ kind: "boolean", value: checked === true })}
        />
      );
    case "choice":
      return (
        <NativeSelect
          id={id}
          name={name}
          disabled={readOnly}
          value={value?.kind === "choice" ? value.value : ""}
          onChange={(event) =>
            onChange(
              event.target.value.length === 0
                ? undefined
                : { kind: "choice", value: event.target.value },
            )
          }
        >
          {property.defaultValue === undefined ? (
            <NativeSelectOption value="">Not set</NativeSelectOption>
          ) : null}
          {property.options.map((option) => (
            <NativeSelectOption key={option.key} value={option.key}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      );
    default:
      return (
        <JsonValueEditor
          id={id}
          name={name}
          value={value}
          readOnly={readOnly}
          onChange={onChange}
        />
      );
  }
};

/** The declared settings among a placement's props: each declared property's own prop. */
const placementSettingsOf = (
  release: PlatformBlockRelease,
  props: Readonly<Record<string, unknown>>,
): PlacementSettings => {
  const settings: Record<string, BlockPropertyValueContract> = {};
  for (const property of release.properties) {
    const value = ownEntry(props, property.key);
    if (value !== undefined) settings[property.key] = value as BlockPropertyValueContract;
  }
  return settings;
};

/** The names of the slot fields a placement of this release has, given its settings. */
const declaredSlotKeys = (
  release: PlatformBlockRelease,
  settings: PlacementSettings,
): readonly string[] =>
  release.slots.flatMap((slot) =>
    slot.repeats === undefined
      ? [slot.key]
      : repeatableSlotItemIdentities(slot, settings).map((identity) =>
          repeatableSlotKey(slot.key, identity),
        ),
  );

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

function PlacementBlock(props: {
  registry: PlatformComponentRegistry;
  componentProps: VortexPuckComponentProps;
  fieldInputControlReleases: FieldInputControlReleases;
  platformThemeTokens: PlatformThemeTokens;
}): ReactElement {
  const { registry, componentProps, fieldInputControlReleases, platformThemeTokens } = props;
  const { id: placementId, vortex, puck, wrapper } = componentProps;
  const metadataIn = (puck.metadata ?? {}) as VortexPuckMetadata;
  const inheritedScope = useContext(ThemeScopeContext);
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
  // Each declared setting is its own prop; Puck writes `undefined` for an untouched field, and a
  // declared setting is either present or absent.
  const settings = placementSettingsOf(release, componentProps);
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

  // Declared theme overrides apply to this placement and its subtree; a re-themed placement is
  // also a theme root, so its surface, text and typography repaint from its own variables.
  const placementTheme = resolvePlacementTheme(
    inheritedScope,
    vortex.themeOverrides,
    platformThemeTokens,
  );

  const slotStyle: CSSProperties = { gap: slotGapFor(release, settings, rootSlotGap, location) };
  const slots: Record<string, ReactNode> = {};
  const latestSlots = useRef<Record<string, SlotComponent>>({});
  const stableSlots = useRef<Record<string, SlotComponent>>({});
  for (const slotKey of declaredSlotKeys(release, settings)) {
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
        <StableSlot className="vortex-puck-slot" style={slotStyle} />
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
  const gridChild = RESPONSIVE_BREAKPOINT_ORDER.some(
    (candidate) => vortex.responsive[candidate].width.kind === "grid",
  );
  const wrapperClassName = responsive
    ? LAYOUT_CLASS_NAMES.placementWrapper
    : computePlacementClassName(layout);
  const wrapperStyle: CSSProperties = {
    ...wrapper?.style,
    ...placementTheme.style,
    ...(responsive ? {} : computePlacementStyle(layout)),
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
    <ThemeScopeContext.Provider value={placementTheme.scope}>
      <div
        data-vortex-layout-wrapper=""
        data-vortex-placement-id={placementId}
        data-vortex-block-id={release.blockId}
        data-vortex-block-key={release.key}
        {...(responsive && !pageEmitsCss ? { "data-vortex-wrapper-scope": placementId } : {})}
        {...(gridChild ? { "data-vortex-grid-child": "" } : {})}
        {...(responsive
          ? {}
          : {
              "data-vortex-breakpoint": activeBreakpoint,
              "data-vortex-visible": String(layout.visible),
            })}
        {...(placementTheme.style === undefined ? {} : { "data-vortex-theme": "" })}
        className={
          wrapper?.className ? `${wrapperClassName} ${wrapper.className}` : wrapperClassName
        }
        style={wrapperStyle}
      >
        {ownCss === undefined ? null : <style>{ownCss}</style>}
        {visible ? (
          <Implementation
            {...parsedInputs}
            placementId={placementId}
            settings={settings}
            slots={slots}
            breakpoint={activeBreakpoint}
            responsiveLayout={responsive}
            metadata={release}
            fieldInputControlReleases={fieldInputControlReleases}
            themeOverrides={vortex.themeOverrides}
            themeTokens={placementTheme.scope.inherited}
            {...availability}
            {...(metadataIn.projectedNavigation === undefined
              ? {}
              : { projectedNavigation: metadataIn.projectedNavigation })}
            {...(metadataIn.resolvePageHref === undefined
              ? {}
              : { resolvePageHref: metadataIn.resolvePageHref })}
            {...(metadataIn.onNavigatePage === undefined
              ? {}
              : { onNavigatePage: metadataIn.onNavigatePage })}
            {...(metadataIn.onPrefetchPage === undefined
              ? {}
              : { onPrefetchPage: metadataIn.onPrefetchPage })}
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
        ) : null}
      </div>
    </ThemeScopeContext.Provider>
  );
}

// ---------------------------------------------------------------------------------------------
// The config
// ---------------------------------------------------------------------------------------------

const versionParts = (version: string): readonly number[] =>
  version.split(".").map((part) => Number.parseInt(part, 10) || 0);

const compareVersions = (first: string, second: string): number => {
  const a = versionParts(first);
  const b = versionParts(second);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
};

const BREAKPOINT_TITLES: Readonly<Record<Breakpoint, string>> = Object.freeze({
  desktop: "Desktop",
  tablet: "Tablet",
  phone: "Phone",
});

const layoutAt = (
  responsive: unknown,
  breakpoint: Breakpoint,
): Record<string, unknown> | undefined => {
  const layout = (responsive as Record<string, unknown> | undefined)?.[breakpoint];
  return layout !== null && typeof layout === "object"
    ? (layout as Record<string, unknown>)
    : undefined;
};

type WidthValue = { kind?: string; startColumn?: number; span?: number };

// Switching to grid writes an explicit full-width placement; nothing falls back at render time.
const GRID_WIDTH_DEFAULT = Object.freeze({ kind: "grid", startColumn: 1, span: 12 });

/** One breakpoint's width: the kind and, for grid, the start column and span as one value. */
const widthField = (release: PlatformBlockRelease): Field => {
  const kinds = release.capabilities.gridWidth ? ["content", "fill", "grid"] : ["content", "fill"];
  return {
    type: "custom",
    label: "Width",
    render: ({ id, name, value, onChange, readOnly }): ReactElement => {
      const width = (value ?? {}) as WidthValue;
      const column = (key: "startColumn" | "span", label: string): ReactElement => (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-${key}`}>{label}</Label>
          <Input
            id={`${id}-${key}`}
            name={`${name}.${key}`}
            type="number"
            min={1}
            max={12}
            disabled={readOnly}
            value={width[key] ?? ""}
            onChange={(event) => {
              const next = event.target.valueAsNumber;
              if (Number.isInteger(next)) onChange({ ...width, [key]: next });
            }}
          />
        </div>
      );
      return (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id}>Width</Label>
          <NativeSelect
            id={id}
            name={name}
            disabled={readOnly}
            value={width.kind ?? ""}
            onChange={(event) =>
              onChange(
                event.target.value === "grid"
                  ? { ...GRID_WIDTH_DEFAULT }
                  : { kind: event.target.value },
              )
            }
          >
            {kinds.map((kind) => (
              <NativeSelectOption key={kind} value={kind}>
                {kind}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {width.kind === "grid" ? (
            <>
              {column("startColumn", "Start column")}
              {column("span", "Column span")}
            </>
          ) : null}
        </div>
      );
    },
  };
};

type OverrideValue = Record<string, unknown> & { kind: string };

/**
 * A colour text input that keeps its own draft while typing and reaches the page only once the
 * draft is a colour the source accepts (committed as it becomes valid and again on blur).
 */
function ColorTextInput({
  id,
  name,
  disabled,
  value,
  onCommit,
}: {
  id: string;
  name: string;
  disabled: boolean | undefined;
  value: string;
  onCommit: (value: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState(value);
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value);
  }
  const valid = themeColorSchema.safeParse(draft).success;
  const commit = (next: string): void => {
    if (themeColorSchema.safeParse(next).success && next !== value) onCommit(next);
  };
  return (
    <Input
      id={id}
      name={name}
      disabled={disabled}
      value={draft}
      aria-invalid={!valid}
      onChange={(event) => {
        setDraft(event.target.value);
        commit(event.target.value);
      }}
      onBlur={() => commit(draft)}
    />
  );
}

/** The platform token kinds a placement can override from the inspector, each with its editor. */
const THEME_OVERRIDE_FIELDS: Readonly<
  Record<
    string,
    ReadonlyArray<{
      key: string;
      label: string;
      input: "text" | "rem" | "level" | "density";
    }>
  >
> = Object.freeze({
  color_pair: [
    { key: "light", label: "Light", input: "text" },
    { key: "dark", label: "Dark", input: "text" },
  ],
  spacing: [{ key: "rem", label: "Rem", input: "rem" }],
  corners: [{ key: "rem", label: "Rem", input: "rem" }],
  elevation: [{ key: "level", label: "Level", input: "level" }],
  density: [{ key: "value", label: "Density", input: "density" }],
});

const tokenLabel = (key: string): string =>
  key.replace(/_/gu, " ").replace(/^./u, (first) => first.toUpperCase());

/**
 * One theme token's override: off (no override) or an explicit value of the platform token's own
 * kind, started from the platform value and then edited.
 */
const themeOverrideField = (tokenKey: string, platformToken: Record<string, unknown>): Field => {
  const kind = String(platformToken.kind);
  const inputs = THEME_OVERRIDE_FIELDS[kind] ?? [];
  return {
    type: "custom",
    label: tokenLabel(tokenKey),
    render: ({ id, name, value, onChange, readOnly }): ReactElement => {
      const override = value as OverrideValue | undefined;
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Checkbox
              id={id}
              name={name}
              disabled={readOnly}
              checked={override !== undefined}
              onCheckedChange={(checked) =>
                onChange(
                  checked === true
                    ? Object.fromEntries([
                        ["kind", kind],
                        ...inputs.map((input) => [input.key, platformToken[input.key]]),
                      ])
                    : undefined,
                )
              }
            />
            <Label htmlFor={id}>{tokenLabel(tokenKey)}</Label>
          </div>
          {override === undefined
            ? null
            : inputs.map((input) => {
                const inputId = `${id}-${input.key}`;
                const current = override[input.key];
                const edit = (next: unknown): void => onChange({ ...override, [input.key]: next });
                return (
                  <div key={input.key} className="flex flex-col gap-1.5 pl-6">
                    <Label htmlFor={inputId}>{input.label}</Label>
                    {input.input === "density" ? (
                      <NativeSelect
                        id={inputId}
                        name={`${name}.${input.key}`}
                        disabled={readOnly}
                        value={String(current ?? "")}
                        onChange={(event) => edit(event.target.value)}
                      >
                        <NativeSelectOption value="compact">compact</NativeSelectOption>
                        <NativeSelectOption value="comfortable">comfortable</NativeSelectOption>
                      </NativeSelect>
                    ) : input.input === "text" ? (
                      <ColorTextInput
                        id={inputId}
                        name={`${name}.${input.key}`}
                        disabled={readOnly}
                        value={String(current ?? "")}
                        onCommit={edit}
                      />
                    ) : (
                      <Input
                        id={inputId}
                        name={`${name}.${input.key}`}
                        type="number"
                        min={0}
                        step={input.input === "level" ? 1 : 0.0625}
                        disabled={readOnly}
                        value={typeof current === "number" ? current : ""}
                        onChange={(event) => {
                          const next = event.target.valueAsNumber;
                          if (Number.isFinite(next)) edit(next);
                        }}
                      />
                    )}
                  </div>
                );
              })}
        </div>
      );
    },
  };
};

/** The theme override inspector: one typed field per overridable platform theme token. */
const themeOverridesField = (platformThemeTokens: PlatformThemeTokens): Field => ({
  type: "object",
  label: "Theme overrides",
  objectFields: Object.fromEntries(
    Object.entries(platformThemeTokens)
      .filter(([, token]) => THEME_OVERRIDE_FIELDS[token.kind] !== undefined)
      .map(([key, token]) => [key, themeOverrideField(key, token as Record<string, unknown>)]),
  ),
});

/** One breakpoint's visibility, width and height inspector, limited to what the release allows. */
const layoutField = (
  release: PlatformBlockRelease,
  breakpoint: Breakpoint,
  layout: Record<string, unknown> | undefined,
): Field => {
  const heightKind = (layout?.height as { kind?: unknown } | undefined)?.kind;
  const select = (label: string, values: readonly string[]): Field => ({
    type: "select",
    label,
    options: values.map((value) => ({ label: value, value })),
  });
  const heightFields: Record<string, Field> = {
    kind: select(
      "Height",
      release.capabilities.height === "content" ? ["content"] : ["content", "bounded"],
    ),
    ...(heightKind === "bounded"
      ? { units: { type: "number", label: "Height units", min: 1 } as Field }
      : {}),
  };
  return {
    type: "object",
    label: BREAKPOINT_TITLES[breakpoint],
    objectFields: {
      ...(release.capabilities.responsiveVisibility
        ? {
            visible: {
              type: "radio",
              label: "Visible",
              options: [
                { label: "Shown", value: true },
                { label: "Hidden", value: false },
              ],
            } as Field,
          }
        : {}),
      width: widthField(release),
      height: { type: "object", label: "Height", objectFields: heightFields },
    },
  };
};

const PALETTE_TITLES: Readonly<Record<string, string>> = Object.freeze({
  layout: "Layout",
  content: "Content",
  data: "Data",
  figures: "Figures",
  record: "Record",
  input: "Inputs",
  actions: "Actions",
});

type VortexComponentConfig = ComponentConfig<Record<string, unknown>>;

/**
 * Builds the Puck config for every release in the registry: one component per renderer key, typed
 * from that key's newest release. Every registered release renders through its key's component;
 * the placement's own `vortex.block` selects the exact release at render time.
 */
export function createVortexPuckConfig(
  registry: PlatformComponentRegistry,
  fieldInputControlReleases: FieldInputControlReleases,
  platformThemeTokens: PlatformThemeTokens,
): Config {
  const newestByKey = new Map<string, PlatformBlockRelease>();
  for (const { metadata } of registry.list()) {
    const current = newestByKey.get(metadata.rendererKey);
    if (
      current === undefined ||
      compareVersions(metadata.releaseVersion, current.releaseVersion) > 0
    )
      newestByKey.set(metadata.rendererKey, metadata);
  }

  const keysByCategory = new Map<string, string[]>();
  for (const [key, release] of newestByKey) {
    const keys = keysByCategory.get(release.paletteGroup) ?? [];
    keys.push(key);
    keysByCategory.set(release.paletteGroup, keys);
  }

  const buildFields = (
    release: PlatformBlockRelease,
    settings: PlacementSettings,
    responsive?: unknown,
  ) => {
    const fields: Record<string, Field> = {
      vortex: {
        type: "object",
        label: "Layout",
        objectFields: {
          themeOverrides: themeOverridesField(platformThemeTokens),
          responsive: {
            type: "object",
            label: "Responsive layout",
            objectFields: Object.fromEntries(
              RESPONSIVE_BREAKPOINT_ORDER.map((breakpoint) => [
                breakpoint,
                layoutField(release, breakpoint, layoutAt(responsive, breakpoint)),
              ]),
            ),
          },
        },
      },
      ...Object.fromEntries(
        release.properties.map((property) => [property.key, propertyField(property)]),
      ),
    };
    for (const slot of release.slots) {
      const allow = slot.allowedChildCategories.flatMap(
        (category) => keysByCategory.get(category) ?? [],
      );
      const keys =
        slot.repeats === undefined
          ? [slot.key]
          : repeatableSlotItemIdentities(slot, settings).map((identity) =>
              repeatableSlotKey(slot.key, identity),
            );
      for (const key of keys) fields[key] = { type: "slot", label: slot.label, allow };
    }
    return fields;
  };

  const components: Record<string, VortexComponentConfig> = {};
  for (const [rendererKey, release] of newestByKey) {
    implementationFor(release);
    const defaults = defaultSettingsFor(release);
    const hasRepeatableSlot = release.slots.some((slot) => slot.repeats !== undefined);
    components[rendererKey] = {
      label: release.name,
      defaultProps: {
        ...defaults,
        vortex: {
          block: { blockId: release.blockId, releaseVersion: release.releaseVersion },
          themeOverrides: {},
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
          hasRepeatableSlot ? placementSettingsOf(release, data.props) : defaults,
          (data.props.vortex as { responsive?: unknown } | undefined)?.responsive,
        ),
      render: (componentProps) => (
        <PlacementBlock
          registry={registry}
          fieldInputControlReleases={fieldInputControlReleases}
          platformThemeTokens={platformThemeTokens}
          componentProps={componentProps as unknown as VortexPuckComponentProps}
        />
      ),
    } as VortexComponentConfig;
  }

  return {
    categories: Object.fromEntries(
      [...keysByCategory].map(([category, components]) => [
        category,
        { title: PALETTE_TITLES[category] ?? category, components, defaultExpanded: true },
      ]),
    ),
    components,
    root: {
      defaultProps: {
        gap: "medium",
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

const configs = new WeakMap<PlatformComponentRegistry, Config>();

/** The registry's Puck config, built once per registry. */
export function getVortexPuckConfig(
  registry: PlatformComponentRegistry,
  fieldInputControlReleases: FieldInputControlReleases,
  platformThemeTokens: PlatformThemeTokens,
): Config {
  let config = configs.get(registry);
  if (config === undefined) {
    config = createVortexPuckConfig(registry, fieldInputControlReleases, platformThemeTokens);
    configs.set(registry, config);
  }
  return config;
}
