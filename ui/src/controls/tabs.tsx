"use client";

import { useId, useRef, type KeyboardEvent, type ReactElement } from "react";
import { builderKeySchema, repeatableSlotKeyV2 } from "@vortex/contracts";
import { DefinitionRenderError } from "../definition-error";
import type { TabsPayload } from "./projected-data";
import {
  readControlSettings,
  resolveControlContext,
  type ControlRenderProps,
} from "./control-context";
import { useSeededState } from "./field-parts";

export type TabsProps = ControlRenderProps<TabsPayload>;

/** Declared tab slots in the tabs 1.0.0 release, in order, each with its label property. */
const TAB_SLOTS = [
  { key: "tab_one", labelKey: "tab_one_label", fallback: "Tab 1" },
  { key: "tab_two", labelKey: "tab_two_label", fallback: "Tab 2" },
  { key: "tab_three", labelKey: "tab_three_label", fallback: "Tab 3" },
  { key: "tab_four", labelKey: "tab_four_label", fallback: "Tab 4" },
] as const;

/** One rendered tab: its semantic key, its label and the child slot its panel content lives in. */
type Tab = Readonly<{ key: string; label: string; slotKey: string }>;

/**
 * WAI-ARIA tabs with automatic activation. Arrow keys, Home and End move between tabs; pointer,
 * Enter and Space use the native button. Every panel stays mounted and inactive panels are
 * hidden, so switching tabs never loses entered values. The semantic tab key is the declared
 * slot key in the 1.0.0 release and the stable item identity in the 2.0.0 release; only a change
 * of tab emits the declared `tab_changed` event.
 */
export function Tabs(props: TabsProps): ReactElement {
  const context = resolveControlContext<TabsPayload>(props, ["tab_changed"]);
  const settings = readControlSettings(props, context.location);
  const baseId = useId();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // A repeatable release declares its tabs as items keyed by a stable identity, so it has no fixed
  // slot list and may carry any number of tabs. A fixed release keeps its declared four slots.
  const repeatableSlot = props.metadata.slots.find((slot) => slot.repeats !== undefined);
  const repeats = repeatableSlot?.repeats;
  let tabs: readonly Tab[];
  if (repeatableSlot !== undefined && repeats !== undefined) {
    const items = settings.groups(repeats.items);
    tabs = items.flatMap((item): Tab[] => {
      const identityValue = item[repeats.identity];
      const identity = identityValue?.kind === "text" ? identityValue.value.trim() : "";
      if (identity.length === 0) return [];
      if (!builderKeySchema.safeParse(identity).success)
        throw new DefinitionRenderError(
          "INVALID_COMPOSITION",
          `Tab identity '${identity}' must be a lowercase builder key`,
          context.location,
        );
      const labelValue = item.label;
      const label =
        labelValue?.kind === "text" && labelValue.value.trim().length > 0
          ? labelValue.value.trim()
          : identity;
      return [
        {
          key: identity,
          label,
          slotKey: repeatableSlotKeyV2(repeatableSlot.key, identity),
        },
      ];
    });
    if (tabs.length === 0)
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        "A tabs block must declare at least one item",
        context.location,
      );
  } else {
    const present = TAB_SLOTS.filter(
      (tab) => props.slots[tab.key] !== undefined && props.slots[tab.key] !== null,
    );
    tabs = (present.length > 0 ? present : TAB_SLOTS.slice(0, 1)).map((tab) => ({
      key: tab.key,
      label: settings.text(tab.labelKey) ?? tab.fallback,
      slotKey: tab.key,
    }));
  }

  const isTab = (key: string | undefined): key is string =>
    key !== undefined && tabs.some((tab) => tab.key === key);

  const projected = context.values?.activeTab;
  let projectedTab: string | undefined;
  if (projected !== undefined) {
    if (!isTab(projected))
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Active tab '${projected}' is not a tab with content`,
        context.location,
      );
    projectedTab = projected;
  }
  const authoredDefault =
    repeatableSlot === undefined ? settings.choice<string>("default_tab", tabs[0]!.key) : undefined;
  const [selected, setSelected] = useSeededState<string>(
    projectedTab ?? (isTab(authoredDefault) ? authoredDefault : tabs[0]!.key),
  );
  const active = isTab(selected) ? selected : tabs[0]!.key;

  const select = (key: string): void => {
    if (key === active) return;
    setSelected(key);
    context.events?.tab_changed?.({ event: "tab_changed", tabKey: key });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight"
        ? index === last ? 0 : index + 1
        : event.key === "ArrowLeft"
          ? index === 0 ? last : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const target = tabs[next]!.key;
    tabRefs.current[target]?.focus();
    select(target);
  };

  const tabId = (key: string): string => `${baseId}-tab-${key}`;
  const panelId = (key: string): string => `${baseId}-panel-${key}`;
  const label = context.accessibleName ?? props.metadata.name;

  return (
    <div
      data-vortex-control="tabs"
      data-vortex-placement-id={props.placementId}
      data-vortex-active-tab={active}
      className="vortex-tabs"
    >
      <div role="tablist" aria-label={label} className="vortex-tablist">
        {tabs.map((tab, index) => (
          <button
            key={tab.key}
            ref={(element) => {
              tabRefs.current[tab.key] = element;
            }}
            id={tabId(tab.key)}
            type="button"
            role="tab"
            aria-selected={tab.key === active}
            aria-controls={panelId(tab.key)}
            tabIndex={tab.key === active ? 0 : -1}
            data-vortex-tab-key={tab.key}
            onClick={() => select(tab.key)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className="vortex-tab"
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.key}
          id={panelId(tab.key)}
          role="tabpanel"
          aria-labelledby={tabId(tab.key)}
          tabIndex={0}
          hidden={tab.key !== active}
          data-vortex-tab-key={tab.key}
          className="vortex-tabpanel"
        >
          {props.slots[tab.slotKey] ?? null}
        </div>
      ))}
    </div>
  );
}
