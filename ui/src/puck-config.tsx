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
 * content width is a setting written into the placement (`LAYOUT_DEFAULTS` is what an inserted or
 * legacy placement receives), and nothing below the config changes layout because a setting is
 * absent.
 *
 * Page-runtime context (queries, forms, actions, flow runtime) reaches a render function through
 * Puck's `metadata` as `VortexPuckMetadata`; the registry's per-block payload parsers validate it.
 */

import {
  createContext,
  useContext,
  useRef,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ComponentConfig, Config, Field, PuckContext, SlotComponent } from "@puckeditor/core";
import {
  APPLICATION_ACCOUNT_ACTIONS_BLOCK_RELEASE,
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  APPLICATION_NAVIGATION_BLOCK_RELEASE,
  APPLICATION_PAGE_LINK_TILES_BLOCK_RELEASE,
  ATTACHMENT_LIST_BLOCK_RELEASE,
  BOARD_BLOCK_RELEASE,
  BOOLEAN_INPUT_BLOCK_RELEASE,
  BUTTON_BLOCK_RELEASE,
  CALENDAR_BLOCK_RELEASE,
  CHOICE_INPUT_BLOCK_RELEASE,
  CONTAINER_BLOCK_RELEASE,
  DATE_INPUT_BLOCK_RELEASE,
  DIALOG_BLOCK_RELEASE,
  DRAWER_BLOCK_RELEASE,
  FIELD_INPUT_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
  GROUPED_DATA_BLOCK_RELEASE,
  HEADING_BLOCK_RELEASE,
  LINK_INPUT_BLOCK_RELEASE,
  LINK_TILES_BLOCK_RELEASE,
  LIST_BLOCK_RELEASE,
  NOTICE_BLOCK_RELEASE,
  NUMBER_INPUT_BLOCK_RELEASE,
  QUERY_NOTICE_BLOCK_RELEASE,
  RECORD_DETAIL_BLOCK_RELEASE,
  RECORD_PIN_LINK_TILES_BLOCK_RELEASE,
  RICH_TEXT_BLOCK_RELEASE,
  RICH_TEXT_INPUT_BLOCK_RELEASE,
  SUMMARY_VALUES_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE,
  TABS_BLOCK_RELEASE,
  TEXT_BLOCK_RELEASE,
  TEXT_INPUT_BLOCK_RELEASE,
  VALIDATION_MESSAGE_BLOCK_RELEASE,
  VIEW_FILTER_BLOCK_RELEASE,
  repeatableSlotItemIdentitiesV2,
  repeatableSlotKeyV2,
  type BlockPlacementV2Contract,
  type BlockPropertySchemaV2Contract,
  type BlockPropertyValueV2Contract,
  type PlatformBlockReleaseV2,
  type ProjectedNavigation,
} from "@vortex/contracts";
import { Checkbox } from "./components/checkbox";
import { Input } from "./components/input";
import { Label } from "./components/label";
import { NativeSelect, NativeSelectOption } from "./components/native-select";
import { Textarea } from "./components/textarea";
import { DefinitionRenderError, validateAccessibleName, type Breakpoint } from "./definition-error";
import {
  computePlacementClassName,
  computePlacementStyle,
  computeResponsiveSelectorCss,
  LAYOUT_CLASS_NAMES,
  RESPONSIVE_BREAKPOINT_ORDER,
  slotGapLength,
  type ResponsivePlacementLayoutsV2,
  type SlotGapName,
} from "./layout-styles";
import { projectedAvailability } from "./placement-availability";
import {
  EMPTY_RUNTIME_INPUTS,
  type PlatformBlockRuntimeInputs,
  type PlatformComponentRegistry,
  type PlatformComponentRenderer,
  type RuntimeInputsByPlacement,
} from "./registry";
import { resolvePlacementTheme, VortexFontStylesheets, type PlacementThemeScope } from "./theme";
import { ApplicationLauncher } from "./launcher/application-launcher";
import { LinkTiles } from "./launcher/link-tiles";
import { ViewFilter } from "./launcher/view-filter";
import { ApplicationNavigationBlock } from "./navigation/navigation";
import { ApplicationAccountActionsBlock } from "./navigation/account-actions";
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
}>;

/**
 * The part of a placement that is not a block setting. It is the `vortex` prop the Vortex Puck
 * adapter writes, so a definition placement round-trips through Puck data without loss.
 */
export type VortexPlacementMeta = Readonly<{
  block: BlockPlacementV2Contract["block"];
  responsive: BlockPlacementV2Contract["responsive"];
  themeOverrides: BlockPlacementV2Contract["themeOverrides"];
  /** Authored slot order retained for editing; preview Puck arrays use the selected breakpoint. */
  order?: Readonly<{
    desktop: readonly string[];
    tablet: readonly string[];
    phone: readonly string[];
  }>;
  availability?: "unavailable";
  unavailableReason?: "operation_unavailable";
}>;

type PlacementSettings = Readonly<Record<string, BlockPropertyValueV2Contract>>;

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
  [CONTAINER_BLOCK_RELEASE.rendererKey, Container],
  [HEADING_BLOCK_RELEASE.rendererKey, Heading],
  [TABS_BLOCK_RELEASE.rendererKey, Tabs],
  [DIALOG_BLOCK_RELEASE.rendererKey, Dialog],
  [DRAWER_BLOCK_RELEASE.rendererKey, Drawer],
  [TEXT_BLOCK_RELEASE.rendererKey, PlainTextDisplay],
  [RICH_TEXT_BLOCK_RELEASE.rendererKey, RichTextDisplay],
  [LIST_BLOCK_RELEASE.rendererKey, ListDisplay],
  [TABLE_BLOCK_RELEASE.rendererKey, TableDisplay],
  [RECORD_DETAIL_BLOCK_RELEASE.rendererKey, RecordDetailDisplay],
  [GROUPED_DATA_BLOCK_RELEASE.rendererKey, GroupedDataDisplay],
  [SUMMARY_VALUES_BLOCK_RELEASE.rendererKey, SummaryValuesDisplay],
  [NOTICE_BLOCK_RELEASE.rendererKey, NoticeBlock],
  [QUERY_NOTICE_BLOCK_RELEASE.rendererKey, QueryNoticeDisplay],
  [CALENDAR_BLOCK_RELEASE.rendererKey, CalendarDisplay],
  [BOARD_BLOCK_RELEASE.rendererKey, BoardDisplay],
  [ATTACHMENT_LIST_BLOCK_RELEASE.rendererKey, SearchAttachmentDisplay],
  [FORM_CONTAINER_BLOCK_RELEASE.rendererKey, FormContainer],
  [FIELD_INPUT_BLOCK_RELEASE.rendererKey, FieldInput],
  [TEXT_INPUT_BLOCK_RELEASE.rendererKey, TextInput],
  [LINK_INPUT_BLOCK_RELEASE.rendererKey, LinkInput],
  [RICH_TEXT_INPUT_BLOCK_RELEASE.rendererKey, RichTextInput],
  [NUMBER_INPUT_BLOCK_RELEASE.rendererKey, NumberInput],
  [BOOLEAN_INPUT_BLOCK_RELEASE.rendererKey, BooleanInput],
  [DATE_INPUT_BLOCK_RELEASE.rendererKey, DateInput],
  [CHOICE_INPUT_BLOCK_RELEASE.rendererKey, ChoiceInput],
  [VALIDATION_MESSAGE_BLOCK_RELEASE.rendererKey, ValidationMessage],
  [BUTTON_BLOCK_RELEASE.rendererKey, Button],
  [APPLICATION_NAVIGATION_BLOCK_RELEASE.rendererKey, ApplicationNavigationBlock],
  [APPLICATION_ACCOUNT_ACTIONS_BLOCK_RELEASE.rendererKey, ApplicationAccountActionsBlock],
  [APPLICATION_LAUNCHER_BLOCK_RELEASE.rendererKey, ApplicationLauncher],
  [LINK_TILES_BLOCK_RELEASE.rendererKey, LinkTiles],
  [RECORD_PIN_LINK_TILES_BLOCK_RELEASE.rendererKey, LinkTiles],
  [APPLICATION_PAGE_LINK_TILES_BLOCK_RELEASE.rendererKey, LinkTiles],
  [VIEW_FILTER_BLOCK_RELEASE.rendererKey, ViewFilter],
]);

const implementationFor = (release: PlatformBlockReleaseV2): PlatformComponentRenderer => {
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

const choice = (value: string): BlockPropertyValueV2Contract => ({ kind: "choice", value });

/**
 * The layout and spacing a placement receives when it is inserted, and when a stored placement
 * predates a declared property. Each entry applies only to a release that declares the property
 * and the option, and is written into the placement's settings, so a render function always reads
 * an explicit value.
 */
const LAYOUT_DEFAULTS: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map([
  [
    CONTAINER_BLOCK_RELEASE.rendererKey,
    {
      direction: "column",
      gap: "medium",
      padding: "none",
      content_width: "fill",
      menu_placement: "flow",
    },
  ],
  [HEADING_BLOCK_RELEASE.rendererKey, { level: "two" }],
]);

/** The gap between slot children of a block whose release declares no `gap` property of its own. */
const UNDECLARED_SLOT_GAP: SlotGapName = "medium";

const isSlotGapName = (value: string): value is SlotGapName =>
  value === "none" || value === "small" || value === "medium" || value === "large";

/** The explicit layout settings a release declares, as a placement's default settings. */
const defaultSettingsFor = (release: PlatformBlockReleaseV2): PlacementSettings => {
  const defaults: Record<string, BlockPropertyValueV2Contract> = {};
  const layout = LAYOUT_DEFAULTS.get(release.rendererKey) ?? {};
  for (const property of release.properties) {
    if (property.defaultValue !== undefined) defaults[property.key] = property.defaultValue;
    const value = layout[property.key];
    if (
      value !== undefined &&
      property.kind === "choice" &&
      property.options.some((option) => option.key === value)
    )
      defaults[property.key] = choice(value);
  }
  return defaults;
};

/** A placement's settings with the config's explicit defaults beneath the authored values. */
export const resolveEffectiveSettings = (
  release: PlatformBlockReleaseV2,
  settings: PlacementSettings,
): PlacementSettings => {
  const effective: Record<string, BlockPropertyValueV2Contract> = {
    ...defaultSettingsFor(release),
  };
  // The editor lists every declared property, so an unset one can arrive as an explicit undefined.
  for (const [key, value] of Object.entries(settings))
    if (value !== undefined) effective[key] = value;
  return effective;
};

/**
 * The gap between the children of one of this placement's slots: the placement's own declared
 * `gap` setting, or the config's constant for blocks that declare none.
 */
export const resolveSlotGap = (
  release: PlatformBlockReleaseV2,
  settings: PlacementSettings,
): SlotGapName => {
  if (!release.properties.some((property) => property.key === "gap")) return UNDECLARED_SLOT_GAP;
  const value = settings.gap;
  if (value?.kind === "choice" && isSlotGapName(value.value)) return value.value;
  return UNDECLARED_SLOT_GAP;
};

// ---------------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------------

type TaggedValue = BlockPropertyValueV2Contract | undefined;

const jsonText = (value: TaggedValue): string =>
  value === undefined ? "" : JSON.stringify(value, null, 2);

/** Edits a value whose kind has no dedicated control as its canonical, kind-tagged JSON. */
function JsonValueEditor(props: {
  id: string;
  name: string;
  value: TaggedValue;
  readOnly: boolean | undefined;
  onChange: (value: TaggedValue) => void;
}): ReactElement {
  return (
    <Textarea
      id={props.id}
      name={props.name}
      disabled={props.readOnly}
      defaultValue={jsonText(props.value)}
      spellCheck={false}
      className="font-mono text-xs"
      onBlur={(event) => {
        const text = event.currentTarget.value.trim();
        if (text.length === 0) return props.onChange(undefined);
        try {
          props.onChange(JSON.parse(text) as BlockPropertyValueV2Contract);
        } catch {
          event.currentTarget.value = jsonText(props.value);
        }
      }}
    />
  );
}

/** One property's Puck field: an editor for exactly that property's kind-tagged value. */
const propertyField = (property: BlockPropertySchemaV2Contract): Field => ({
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
  property: BlockPropertySchemaV2Contract,
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
          <NativeSelectOption value="">Not set</NativeSelectOption>
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
  release: PlatformBlockReleaseV2,
  settings: PlacementSettings,
): readonly string[] =>
  release.slots.flatMap((slot) =>
    slot.repeats === undefined
      ? [slot.key]
      : repeatableSlotItemIdentitiesV2(slot, settings).map((identity) =>
          repeatableSlotKeyV2(slot.key, identity),
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
}): ReactElement {
  const { registry, componentProps } = props;
  const { id: placementId, vortex, puck, wrapper } = componentProps;
  const metadataIn = (puck.metadata ?? {}) as VortexPuckMetadata;
  const inheritedScope = useContext(ThemeScopeContext);
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
  const settings = resolveEffectiveSettings(release, componentProps.settings ?? {});
  validateAccessibleName(settings, release.capabilities, location);

  // A placement whose use is unavailable stays viewable but never receives an invocable callback,
  // which each block's own context enforces from the availability it receives. The parsed inputs
  // are spread first, so the props every block always receives cannot be replaced.
  const availability = projectedAvailability(
    {
      ...(vortex.availability === undefined
        ? {}
        : { availability: vortex.availability, unavailableReason: vortex.unavailableReason }),
    } as unknown as BlockPlacementV2Contract,
    location,
  );
  const suppliedInputs = ownEntry(metadataIn.runtimeInputs, placementId);
  const parsedInputs: PlatformBlockRuntimeInputs =
    suppliedInputs === undefined
      ? EMPTY_RUNTIME_INPUTS
      : registration.parsePayload(suppliedInputs, location);

  // Declared theme overrides apply to this placement and its subtree; a re-themed placement is
  // also a theme root, so its surface, text and typography repaint from its own variables.
  const placementTheme = resolvePlacementTheme(inheritedScope, vortex.themeOverrides);

  const slotStyle: CSSProperties = { gap: slotGapLength(resolveSlotGap(release, settings)) };
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
          vortex.responsive as ResponsivePlacementLayoutsV2,
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
        {/* A re-themed placement may paint another font; its links join the application's. */}
        {placementTheme.style === undefined ? null : (
          <VortexFontStylesheets tokens={placementTheme.scope.inherited} />
        )}
        {visible ? (
          <Implementation
            {...parsedInputs}
            placementId={placementId}
            settings={settings}
            slots={slots}
            breakpoint={activeBreakpoint}
            responsiveLayout={responsive}
            metadata={release}
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
export function createVortexPuckConfig(registry: PlatformComponentRegistry): Config {
  const newestByKey = new Map<string, PlatformBlockReleaseV2>();
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

  const buildFields = (release: PlatformBlockReleaseV2, settings: PlacementSettings) => {
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
          : repeatableSlotItemIdentitiesV2(slot, settings).map((identity) =>
              repeatableSlotKeyV2(slot.key, identity),
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
              buildFields(
                release,
                resolveEffectiveSettings(release, (data.props.settings ?? {}) as PlacementSettings),
              ),
          }
        : {}),
      render: (componentProps) => (
        <PlacementBlock
          registry={registry}
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
      defaultProps: { gap: "medium", padding: "medium" },
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
      }: {
        children: ReactNode;
        puck: PuckContext;
        gap: SlotGapName;
        padding: SlotGapName;
      }) => (
        <div
          data-vortex-puck-root=""
          className="vortex-puck-slot"
          style={{ gap: slotGapLength(gap), padding: slotGapLength(padding) }}
          {...(puck.isEditing ? { "data-vortex-editing": "" } : {})}
        >
          {children}
        </div>
      ),
    },
  } as unknown as Config;
}

const configs = new WeakMap<PlatformComponentRegistry, Config>();

/** The registry's Puck config, built once per registry. */
export function getVortexPuckConfig(registry: PlatformComponentRegistry): Config {
  let config = configs.get(registry);
  if (config === undefined) {
    config = createVortexPuckConfig(registry);
    configs.set(registry, config);
  }
  return config;
}
