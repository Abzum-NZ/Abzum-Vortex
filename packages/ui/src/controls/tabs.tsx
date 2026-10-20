"use client";

import type { ReactElement } from "react";
import { isRepeatableSlotIdentity, repeatableSlotKey } from "@vortex/platform/schema";
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

/** One rendered tab: its semantic key, its label and the child slot its panel content lives in. */
type Tab = Readonly<{ key: string; label: string; slotKey: string }>;

/**
 * WAI-ARIA tabs with automatic activation, rendered by the shadcn Tabs component (Base UI): the
 * tablist owns the arrow key, Home and End keyboard behaviour, a tab activates as soon as it takes
 * focus, and every tab is a native button.
 * Every panel stays mounted while inactive panels are hidden, so switching tabs never loses
 * entered values. The semantic tab key is the item's stable identity; only a change of tab emits
 * the declared `tab_changed` event.
 */
export function Tabs(props: TabsProps): ReactElement {
  const context = resolveControlContext<TabsPayload>(props, ["tab_changed"]);
  const settings = readControlSettings(props, context.location);

  // The tabs release declares its tabs as items keyed by a stable identity, each naming one child slot.
  const repeatableSlot = props.metadata.slots.find((slot) => slot.repeats !== undefined);
  const repeats = repeatableSlot?.repeats;
  if (repeatableSlot === undefined || repeats === undefined)
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "A tabs block release must declare its tabs as repeatable items",
      context.location,
    );
  const seen = new Set<string>();
  const tabs: readonly Tab[] = settings.groups(repeats.items).map((item): Tab => {
    const identityValue = item[repeats.identity];
    const identity = identityValue?.kind === "text" ? identityValue.value : "";
    if (!isRepeatableSlotIdentity(repeatableSlot.key, identity) || seen.has(identity))
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
    return { key: identity, label, slotKey: repeatableSlotKey(repeatableSlot.key, identity) };
  });
  if (tabs.length === 0)
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "A tabs block must declare at least one item",
      context.location,
    );

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

  // Only a declared tab key is a tab change; any other value the primitive reports is ignored and
  // never emits the declared event.
  const onValueChange = (value: unknown): void => {
    if (typeof value !== "string" || !isTab(value)) return;
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
      <TabsList aria-label={label} activateOnFocus>
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
