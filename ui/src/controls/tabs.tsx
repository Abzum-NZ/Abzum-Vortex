"use client";

import type { ReactElement } from "react";
import { isRepeatableSlotIdentityV2, repeatableSlotKeyV2 } from "@vortex/contracts";
import { DefinitionRenderError } from "../definition-error";
import { Tabs as ShadcnTabs, TabsContent, TabsList, TabsTrigger } from "../components/tabs";
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
 * WAI-ARIA tabs with automatic activation, rendered by the shadcn Tabs component (Base UI): the
 * tablist owns the arrow key, Home and End keyboard behaviour and every tab is a native button.
 * Every panel stays mounted while inactive panels are hidden, so switching tabs never loses
 * entered values. The semantic tab key is the declared slot key in the 1.0.0 release and the
 * stable item identity in the 2.0.0 release; only a change of tab emits the declared
 * `tab_changed` event.
 */
export function Tabs(props: TabsProps): ReactElement {
  const context = resolveControlContext<TabsPayload>(props, ["tab_changed"]);
  const settings = readControlSettings(props, context.location);

  // A repeatable release declares its tabs as items keyed by a stable identity, so it has no fixed
  // slot list and may carry any number of tabs. A fixed release keeps its declared four slots.
  const repeatableSlot = props.metadata.slots.find((slot) => slot.repeats !== undefined);
  const repeats = repeatableSlot?.repeats;
  let tabs: readonly Tab[];
  if (repeatableSlot !== undefined && repeats !== undefined) {
    const seen = new Set<string>();
    tabs = settings.groups(repeats.items).map((item): Tab => {
      const identityValue = item[repeats.identity];
      const identity = identityValue?.kind === "text" ? identityValue.value : "";
      if (!isRepeatableSlotIdentityV2(repeatableSlot.key, identity) || seen.has(identity))
        throw new DefinitionRenderError(
          "INVALID_COMPOSITION",
          "Every tab needs its own stable key of lowercase words separated by underscores",
          context.location,
        );
      seen.add(identity);
      const labelValue = item.label;
      const label =
        labelValue?.kind === "text" && labelValue.value.trim().length > 0
          ? labelValue.value
          : identity;
      return { key: identity, label, slotKey: repeatableSlotKeyV2(repeatableSlot.key, identity) };
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

  // A declared tab key is always a string, so a value the primitive can report without one is not a
  // tab change and never emits the declared event.
  const onValueChange = (value: unknown): void => {
    if (typeof value !== "string") return;
    select(value);
  };

  const label = context.accessibleName ?? props.metadata.name;

  return (
    <ShadcnTabs
      value={active}
      onValueChange={onValueChange}
      data-vortex-control="tabs"
      data-vortex-placement-id={props.placementId}
      data-vortex-active-tab={active}
    >
      <TabsList aria-label={label}>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.key} value={tab.key} data-vortex-tab-key={tab.key}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.key} value={tab.key} keepMounted data-vortex-tab-key={tab.key}>
          {props.slots[tab.slotKey] ?? null}
        </TabsContent>
      ))}
    </ShadcnTabs>
  );
}
