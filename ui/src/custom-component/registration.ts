import {
  jsonValueSchema,
  type CustomComponentReleaseV2,
  type PlatformBlockReleaseV2,
} from "@vortex/contracts";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import {
  createPayloadParser,
  createPlatformComponentRegistry,
  type PlatformComponentPayloadParser,
  type PlatformComponentRegistration,
  type PlatformComponentRegistry,
} from "../registry";
import {
  CustomComponentHost,
  type CustomComponentEventBinding,
} from "./custom-component-host";

/**
 * Registers a custom component release with the sandboxed host. Custom component releases are
 * application or module data, not platform blocks, so a registration is built from the exact release
 * metadata and its own contract: the parser accepts only the values the release's data contract
 * maps and only the bindings its declared events name.
 */

const fail = (message: string, location: DefinitionRenderErrorLocation): never => {
  throw new DefinitionRenderError("INVALID_COMPOSITION", message, location);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseValues = (
  custom: CustomComponentReleaseV2,
  value: unknown,
  location: DefinitionRenderErrorLocation,
): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) fail("Custom component values must be an object", location);
  const declared = new Map(custom.dataContract.values.map((field) => [field.key, field]));
  for (const key of Object.keys(value))
    if (!declared.has(key)) fail(`Unexpected custom component value '${key}'`, location);
  const parsed: Record<string, unknown> = {};
  for (const field of custom.dataContract.values) {
    if (!Object.hasOwn(value, field.key)) {
      if (field.required)
        fail(`Missing required custom component value '${field.key}'`, {
          ...location,
          propertyPath: [field.key],
        });
      continue;
    }
    if (!jsonValueSchema.safeParse(value[field.key]).success)
      fail(`Custom component value '${field.key}' must be a JSON value`, {
        ...location,
        propertyPath: [field.key],
      });
    parsed[field.key] = value[field.key];
  }
  return Object.freeze(parsed);
};

const parseBindings = (
  custom: CustomComponentReleaseV2,
  value: unknown,
  location: DefinitionRenderErrorLocation,
): Readonly<Record<string, CustomComponentEventBinding>> => {
  if (!isRecord(value)) fail("Custom component event bindings must be an object", location);
  const declared = new Set(custom.events.map((event) => event.key));
  for (const key of Object.keys(value))
    if (!declared.has(key)) fail(`Custom component does not declare event '${key}'`, location);
  const parsed: Record<string, CustomComponentEventBinding> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) fail(`Event binding '${key}' must be an object`, location);
    for (const bindingKey of Object.keys(raw))
      if (bindingKey !== "run" && bindingKey !== "changesData")
        fail(`Unexpected event binding field '${bindingKey}'`, {
          ...location,
          propertyPath: [key, bindingKey],
        });
    if (typeof raw.run !== "function")
      fail(`Event binding '${key}' must provide a run function`, location);
    if (typeof raw.changesData !== "boolean")
      fail(`Event binding '${key}' must declare whether it changes data`, location);
    parsed[key] = Object.freeze({
      run: raw.run as CustomComponentEventBinding["run"],
      changesData: raw.changesData,
    });
  }
  return Object.freeze(parsed);
};

/** Builds the fail-closed parser for one custom component release's own contract. */
export const createCustomComponentPayloadParser = (
  custom: CustomComponentReleaseV2,
): PlatformComponentPayloadParser =>
  createPayloadParser({
    values: (value, location) => parseValues(custom, value, location),
    events: (value, location) => parseBindings(custom, value, location),
  });

/**
 * Pairs one custom component release with the sandboxed host. The release carries the renderer key,
 * ownership, declared events, data contract, text alternative and bundle manifest, so the parser is
 * derived from it rather than registered statically.
 */
export const createCustomComponentRegistration = (
  release: PlatformBlockReleaseV2,
): PlatformComponentRegistration => {
  const custom = release.customComponent;
  if (custom === undefined)
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `Block '${release.key}' is not a custom component release`,
      { blockId: release.blockId, releaseVersion: release.releaseVersion },
    );
  return Object.freeze({
    metadata: release,
    render: CustomComponentHost,
    parsePayload: createCustomComponentPayloadParser(custom),
  });
};

/** Builds the exact registrations for the resolved custom component releases of one installation. */
export const createCustomComponentRegistrations = (
  releases: readonly PlatformBlockReleaseV2[],
): readonly PlatformComponentRegistration[] =>
  Object.freeze(releases.map((release) => createCustomComponentRegistration(release)));

/** Creates an immutable registry over exactly the supplied custom component releases. */
export const createCustomComponentRegistry = (
  releases: readonly PlatformBlockReleaseV2[],
): PlatformComponentRegistry => createPlatformComponentRegistry(createCustomComponentRegistrations(releases));
