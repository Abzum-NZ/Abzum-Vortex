"use client";

import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import type { ComponentConfig, Config, Field } from "@puckeditor/core";
import {
  canonicalResponsivePlacement,
  canonicalThemeTokenValue,
  plainSettingValue,
  releaseSettingDeclarations,
  typedSettingValue,
  type PlatformBlockRelease,
} from "@vortex/platform/schema";
import type { PlatformComponentRegistry } from "../registry";

/**
 * The Studio canvas renders the stored items Puck holds with the one Puck config. A block's render
 * function takes a compiled item's props, so each canvas component reads its stored item for
 * drawing only: its plain settings over the plain settings its last compiled version holds
 * (defaults the author left out, settings the compiler derived, references it resolved), and its
 * stored block, layout and theme in their canonical spelling. A stored value is drawn only when it
 * is already a compiled value of its declaration, so an unresolved reference draws as compiled.
 * Nothing here is written to Puck's data.
 */

type CompiledSettings = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

const CompiledSettingsContext = createContext<CompiledSettings>({});

/** Supplies, by block name, the settings each block's last compiled version holds. */
export function StudioCanvasCompiledSettings({
  settings,
  children,
}: Readonly<{ settings: CompiledSettings; children: ReactNode }>): ReactElement {
  return <CompiledSettingsContext.Provider value={settings}>{children}</CompiledSettingsContext.Provider>;
}

type StoredBlock = Readonly<{ block_id?: unknown; release_version?: unknown }>;
type StoredVortex = Readonly<{
  block?: StoredBlock;
  responsive?: Readonly<Record<string, unknown>>;
  theme_overrides?: Readonly<Record<string, Record<string, unknown>>>;
}>;

/** The props one block's render function takes, read from a stored item's props. */
const renderProps = (
  props: Readonly<Record<string, unknown>>,
  release: PlatformBlockRelease | undefined,
  compiled: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> => {
  const vortex = (props.vortex ?? {}) as StoredVortex;
  const result: Record<string, unknown> = { ...props };
  if (release !== undefined) {
    const authored: Record<string, unknown> = {};
    for (const property of releaseSettingDeclarations(release)) {
      const value = props[property.key];
      if (value !== undefined && typedSettingValue(value, property) !== undefined)
        authored[property.key] = value;
      delete result[property.key];
    }
    // A block added since the last compile draws with its release's defaults, as publication writes them.
    Object.assign(result, compiled ?? catalogueDefaults(release), authored);
  }
  result.vortex = {
    block: { blockId: vortex.block?.block_id, releaseVersion: vortex.block?.release_version },
    themeOverrides: Object.fromEntries(
      Object.entries(vortex.theme_overrides ?? {}).map(([key, value]) => [key, canonicalThemeTokenValue(value)]),
    ),
    responsive: vortex.responsive === undefined ? undefined : canonicalResponsivePlacement(vortex.responsive),
  };
  return result;
};

/** The release's declared defaults, as the plain values a compiled item carries. */
const catalogueDefaults = (release: PlatformBlockRelease): Record<string, unknown> =>
  Object.fromEntries(release.properties.flatMap((property) =>
    property.defaultValue === undefined ? [] : [[property.key, plainSettingValue(property.defaultValue)]]));

/**
 * The slot fields only, without Puck's `allow` lists: a block dropped or moved into any slot
 * reaches Studio, whose stored composition check admits it or refuses it with its place and rule.
 */
const slotFields = (fields: Record<string, Field> | undefined): Record<string, Field> =>
  Object.fromEntries(Object.entries(fields ?? {}).flatMap(([key, field]) => {
    if (field.type !== "slot") return [];
    const slot: Record<string, unknown> = { ...field };
    delete slot.allow;
    delete slot.disallow;
    return [[key, slot as unknown as Field]];
  }));

const releaseOf = (registry: PlatformComponentRegistry, props: Readonly<Record<string, unknown>>) => {
  const block = ((props.vortex ?? {}) as StoredVortex).block;
  return typeof block?.block_id === "string" && typeof block.release_version === "string"
    ? registry.get(block.block_id, block.release_version)?.metadata
    : undefined;
};

function CanvasBlock({
  component,
  registry,
  props,
}: Readonly<{
  component: ComponentConfig<Record<string, unknown>>;
  registry: PlatformComponentRegistry;
  props: Record<string, unknown>;
}>): ReactElement {
  const compiled = useContext(CompiledSettingsContext);
  const id = typeof props.id === "string" ? props.id : "";
  // A block just dropped from the palette is shown as a placeholder until Studio adds it.
  if (props.vortex === undefined)
    return <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">Adding the block…</div>;
  const render = component.render as (props: Record<string, unknown>) => ReactElement;
  return render(renderProps(props, releaseOf(registry, props), Object.hasOwn(compiled, id) ? compiled[id] : undefined));
}

const canvasConfigs = new WeakMap<Config, Config>();

/**
 * The canvas config: the one config's components and root, each component drawing its stored
 * item as above. Only slot fields remain, because Puck finds slots through them and Studio edits
 * settings in its inspector. No defaults are merged: a block dropped from the palette is added by
 * Studio's add command, never by Puck.
 */
export const studioCanvasConfig = (config: Config, registry: PlatformComponentRegistry): Config => {
  let canvas = canvasConfigs.get(config);
  if (canvas !== undefined) return canvas;
  const components = Object.fromEntries(
    Object.entries(config.components as Record<string, ComponentConfig<Record<string, unknown>>>).map(
      ([type, component]) => [
        type,
        {
          label: component.label,
          fields: slotFields(component.fields as Record<string, Field> | undefined),
          ...(component.resolveFields === undefined
            ? {}
            : {
                resolveFields: (data: { props: Record<string, unknown> }, params: unknown) => {
                  const props = renderProps(data.props, releaseOf(registry, data.props), undefined);
                  const resolve = component.resolveFields as unknown as (
                    data: { props: Record<string, unknown> },
                    params: unknown,
                  ) => Record<string, Field>;
                  return slotFields(resolve({ ...data, props }, params));
                },
              }),
          render: (props: Record<string, unknown>) => (
            <CanvasBlock component={component} registry={registry} props={props} />
          ),
        },
      ],
    ),
  );
  canvas = { ...config, components } as unknown as Config;
  canvasConfigs.set(config, canvas);
  return canvas;
};
