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
const SHELL_OUTLET_ID = "vortex-shell-outlet";

const ShellOutletContext = createContext<ReactNode>(null);

export function ShellOutletProvider({
  content,
  children,
}: Readonly<{ content: ReactNode; children: ReactNode }>) {
  return <ShellOutletContext.Provider value={content}>{children}</ShellOutletContext.Provider>;
}

function ShellOutlet() {
  return <>{useContext(ShellOutletContext)}</>;
}

const outletItem: ComponentData = { type: SHELL_OUTLET_TYPE, props: { id: SHELL_OUTLET_ID } };

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
        [SHELL_OUTLET_TYPE]: { fields: {}, render: () => <ShellOutlet /> },
      },
    } as Config;
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
  location: Exclude<ShellOutletLocation, { kind: "root" }>,
): Content =>
  content.map((item) => {
    if (item.props.id === location.placementId) {
      if (location.kind === "placement") return outletItem;
      return { ...item, props: { ...item.props, [location.slotKey]: [outletItem] } };
    }
    const props = Object.fromEntries(
      Object.entries(item.props).map(([key, value]) => [
        key,
        key !== "id" && isContent(value) ? replaceIn(value, location) : value,
      ]),
    );
    return { ...item, props } as ComponentData;
  });

const framedData = new WeakMap<Data, Map<string, Data>>();

/** The frame's Puck data with the outlet placed at the shell's declared content location. */
export const withShellOutlet = (data: Data, location: ShellOutletLocation): Data => {
  const key = JSON.stringify(location);
  const cached = framedData.get(data)?.get(key);
  if (cached !== undefined) return cached;
  const framed: Data = {
    ...data,
    content: location.kind === "root" ? [outletItem] : replaceIn(data.content, location),
  };
  const entries = framedData.get(data) ?? new Map<string, Data>();
  entries.set(key, framed);
  framedData.set(data, entries);
  return framed;
};
