"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ComponentData, Config, Content, Data } from "@puckeditor/core";
import type { ShellOutletLocation } from "@vortex/platform/schema";
import type { SlotGapName } from "./layout-styles";
import { RootSlotGapProvider } from "./puck-config";

/**
 * The application frame and the page content are two renders of one projected page. The frame
 * renders the shell with one outlet where the content goes; the page renders only its content and
 * the host places it in that outlet, so the frame stays mounted while pages change.
 */
const SHELL_OUTLET_TYPE = "VortexShellOutlet";
/** The outlet of a page frame, which holds the whole page. */
export const PAGE_OUTLET = "page";

/** What each outlet of the rendered data shows, by outlet name. */
const ShellOutletContext = createContext<Readonly<Record<string, ReactNode>>>({});

export function ShellOutletProvider({
  outlets,
  children,
}: Readonly<{ outlets: Readonly<Record<string, ReactNode>>; children: ReactNode }>) {
  return <ShellOutletContext.Provider value={outlets}>{children}</ShellOutletContext.Provider>;
}

function ShellOutlet({ outlet }: Readonly<{ outlet: string }>) {
  return <>{useContext(ShellOutletContext)[outlet]}</>;
}

const outletItem = (outlet: string): ComponentData => ({
  type: SHELL_OUTLET_TYPE,
  props: { id: `vortex-shell-outlet-${outlet}`, outlet },
});

const frameConfigs = new WeakMap<Config, Config>();
const contentConfigs = new WeakMap<Config, Config>();

/** The frame's config: the shared config plus the outlet, which no definition can place. */
export const frameConfigFor = (config: Config): Config => {
  let frame = frameConfigs.get(config);
  if (frame === undefined) {
    frame = {
      ...config,
      components: {
        ...config.components,
        [SHELL_OUTLET_TYPE]: {
          fields: {},
          render: ({ outlet }: { outlet?: string }) => <ShellOutlet outlet={String(outlet)} />,
        },
      },
    } as unknown as Config;
    frameConfigs.set(config, frame);
  }
  return frame;
};

/**
 * The content's config: the frame's root already supplies the shell and theme, so the content's own
 * root renders only its placements, directly inside the outlet, with its own root slot gap (the
 * same page root's gap the frame's root has). Content therefore renders correctly wherever it is
 * mounted, including while it leaves the outlet or before its frame has arrived.
 */
export const contentConfigFor = (config: Config): Config => {
  let content = contentConfigs.get(config);
  if (content === undefined) {
    content = {
      ...config,
      root: {
        ...config.root,
        render: ({ children, gap }: { children: ReactNode; gap: SlotGapName }) => (
          <RootSlotGapProvider gap={gap}>{children}</RootSlotGapProvider>
        ),
      },
    } as unknown as Config;
    contentConfigs.set(config, content);
  }
  return content;
};

const isContent = (value: unknown): value is Content =>
  Array.isArray(value) &&
  value.every(
    (item) => typeof item === "object" && item !== null && "type" in item && "props" in item,
  );

const replaceIn = (
  content: Content,
  outlets: ReadonlyMap<string, Exclude<ShellOutletLocation, { kind: "root" }>>,
): Content =>
  content.map((item) => {
    const here = [...outlets].filter(([, location]) => location.placementId === item.props.id);
    // A placement that is an outlet is replaced; one that holds outlets gets them in its slots.
    const replaced = here.find(([, location]) => location.kind === "placement");
    if (replaced !== undefined) return outletItem(replaced[0]);
    const props = { ...item.props } as Record<string, unknown>;
    for (const [outlet, location] of here)
      if (location.kind === "slot") props[location.slotKey] = [outletItem(outlet)];
    // The item's slots are exactly those its `vortex.slotOrders` orders.
    const slotKeys = new Set(
      Object.keys((item.props.vortex as { slotOrders?: object } | undefined)?.slotOrders ?? {}),
    );
    return {
      ...item,
      props: Object.fromEntries(
        Object.entries(props).map(([key, value]) => [
          key,
          slotKeys.has(key) &&
          isContent(value) &&
          !here.some(([, l]) => l.kind === "slot" && l.slotKey === key)
            ? replaceIn(value, outlets)
            : value,
        ]),
      ),
    } as ComponentData;
  });

const framedData = new WeakMap<Data, Map<string, Data>>();

/**
 * The Puck data with an outlet placed at each declared location: the frame's one page outlet, or
 * the content slots of a page's shell region.
 */
export const withShellOutlets = (
  data: Data,
  locations: Readonly<Record<string, ShellOutletLocation>>,
): Data => {
  const key = JSON.stringify(locations);
  const cached = framedData.get(data)?.get(key);
  if (cached !== undefined) return cached;
  const root = Object.entries(locations).find(([, location]) => location.kind === "root");
  const placed = new Map(
    Object.entries(locations).filter(
      (entry): entry is [string, Exclude<ShellOutletLocation, { kind: "root" }>] =>
        entry[1].kind !== "root",
    ),
  );
  const framed: Data = {
    ...data,
    content: root !== undefined ? [outletItem(root[0])] : replaceIn(data.content, placed),
  };
  const entries = framedData.get(data) ?? new Map<string, Data>();
  entries.set(key, framed);
  framedData.set(data, entries);
  return framed;
};
