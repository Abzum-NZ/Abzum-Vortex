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
  useContext,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ComponentConfig, Config, Field, PuckContext, SlotComponent } from "@puckeditor/core";
import {
  repeatableSlotItemIdentities,
  repeatableSlotKey,
  type BlockPlacementContract,
  type BlockPropertySchemaContract,
  type BlockPropertyValueContract,
  type ApplicationPuckRootShell,
  type PlatformBlockRelease,
  type ProjectedNavigation,
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
import {
  resolvePlacementTheme,
  type PlacementThemeScope,
  type PlatformThemeTokens,
} from "./theme";
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
import { BoardDisplay } from "./display/board";
import { CalendarDisplay } from "./display/calendar";
import { GroupedDataDisplay } from "./display/grouped-data";
import { ListDisplay } from "./display/list";
import { NoticeBlock } from "./display/notice";
import { QueryNoticeDisplay } from "./display/query-notice";
import { RecordDetailDisplay } from "./display/record-detail";
import { RichTextDisplay } from "./display/rich-text-component";
import { SummaryValuesDisplay } from "./display/summary-values";
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
 * The part of a placement that is not a block setting. It is the `vortex` prop the Vortex Puck
 * adapter writes, so a definition placement round-trips through Puck data without loss.
 */
export type VortexPlacementMeta = Readonly<{
  block: BlockPlacementContract["block"];
  responsive: BlockPlacementContract["responsive"];
  themeOverrides: BlockPlacementContract["themeOverrides"];
  /** Authored slot order retained for editing; preview Puck arrays use the selected breakpoint. */
  order?: Readonly<{
    desktop: readonly string[];
    tablet: readonly string[];
    phone: readonly string[];
  }>;
  availability?: "unavailable";
  unavailableReason?: "operation_unavailable";
}>;

type PlacementSettings = Readonly<Record<string, BlockPropertyValueContract>>;

/** Props every component of the config receives. Slot props are `SlotComponent` functions. */
export type VortexPuckComponentProps = Readonly<{
  id: string;
  settings: PlacementSettings;
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
  ["platform.renderer.grouped_data", GroupedDataDisplay],
  ["platform.renderer.summary_values", SummaryValuesDisplay],
  ["platform.renderer.notice", NoticeBlock],
  ["platform.renderer.query_notice", QueryNoticeDisplay],
  ["platform.renderer.calendar", CalendarDisplay],
  ["platform.renderer.board", BoardDisplay],
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
  const settings = componentProps.settings ?? {};
  validateAccessibleName(settings, release.capabilities, location);

  // A placement whose use is unavailable stays viewable but never receives an invocable callback,
  // which each block's own context enforces from the availability it receives. The parsed inputs
  // are spread first, so the props every block always receives cannot be replaced.
  const availability = projectedAvailability(
    {
      ...(vortex.availability === undefined
        ? {}
        : { availability: vortex.availability, unavailableReason: vortex.unavailableReason }),
    } as unknown as BlockPlacementContract,
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

  const buildFields = (release: PlatformBlockRelease, settings: PlacementSettings) => {
    const fields: Record<string, Field> = {
      settings: {
        type: "object",
        label: "Settings",
        objectFields: Object.fromEntries(
          release.properties.map((property) => [property.key, propertyField(property)]),
        ),
      },
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
        settings: defaults,
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
      ...(hasRepeatableSlot
        ? {
            resolveFields: (data: { props: Record<string, unknown> }) =>
              buildFields(release, (data.props.settings ?? {}) as PlacementSettings),
          }
        : {}),
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
