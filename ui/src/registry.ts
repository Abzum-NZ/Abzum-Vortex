import type { ComponentType, ReactNode } from "react";
import {
  immutablePlatformBlockCatalogueV2Schema,
  platformBlockReleaseV2Schema,
  type ApplicationCompositionPolicyV2,
  type BlockPropertyValueV2Contract,
  type ImmutablePlatformBlockCatalogueV2,
  type PlatformBlockReleaseV2,
  type ProjectedNavigation,
} from "@vortex/contracts";
import {
  DefinitionRenderError,
  type Breakpoint,
  type DefinitionRenderErrorLocation,
} from "./definition-error";

/**
 * The one generic runtime-input map a placement's renderer receives. Every component-specific
 * input arrives here under a name its own registration declares, so the renderer itself names no
 * payload field, event or callback, and a new data component needs no renderer change.
 */
export type PlatformBlockRuntimeInputs = Readonly<Record<string, unknown>>;

/**
 * One registration's fail-closed payload parser. It validates the raw runtime inputs supplied for
 * one placement identity and returns the frozen inputs that block's own renderer may read. A
 * supplied input that is unknown to that block, or shared with another block, is refused; an
 * absent input stays absent.
 */
export type PlatformComponentPayloadParser = (
  inputs: unknown,
  location: DefinitionRenderErrorLocation,
) => PlatformBlockRuntimeInputs;

/** Raw, not yet validated component runtime inputs keyed by stable placement identity. */
export type RuntimeInputsByPlacement = Readonly<Record<string, unknown>>;

/** The runtime inputs of a placement that declares none. */
export const EMPTY_RUNTIME_INPUTS: PlatformBlockRuntimeInputs = Object.freeze({});

/**
 * The parser for a block that binds no runtime input at all: a purely authored, purely structural
 * or purely navigational block. Any supplied input is refused, so a binding can never turn such a
 * block into a data surface.
 */
export const noRuntimeInputs: PlatformComponentPayloadParser = (inputs, location) => {
  if (inputs === undefined) return EMPTY_RUNTIME_INPUTS;
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs))
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "Component runtime inputs must be an object",
      location,
    );
  const supplied = Object.keys(inputs);
  if (supplied.length === 0) return EMPTY_RUNTIME_INPUTS;
  throw new DefinitionRenderError(
    "INVALID_COMPOSITION",
    `This block accepts no runtime input, but '${supplied.join(", ")}' was supplied`,
    location,
  );
};

/** How one registration reads one of the runtime inputs it declares. */
export type RuntimeInputReader = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
) => unknown;

/**
 * Prop names every block always receives from the page renderer. A runtime input can never use one,
 * so a supplied input cannot stand in for a placement's identity, settings, availability or the
 * page-scoped viewer context.
 */
const RESERVED_RENDER_PROP_NAMES: ReadonlySet<string> = new Set([
  "placementId",
  "settings",
  "slots",
  "breakpoint",
  "metadata",
  "themeOverrides",
  "availability",
  "unavailableReason",
  "projectedNavigation",
  "resolvePageHref",
  "currentPageId",
  "themeTokens",
  "componentBundleOrigin",
]);

/**
 * Builds a registration's parser from the exact inputs that block declares. An input that is absent
 * stays absent; an input this block does not declare is refused, so no field is over-shared with
 * another block. Each reader validates its own value and names it in the reported location. A
 * declared input may not reuse a prop name the renderer always supplies.
 */
export function createPayloadParser(
  readers: Readonly<Record<string, RuntimeInputReader>>,
): PlatformComponentPayloadParser {
  const declared = Object.keys(readers);
  for (const name of declared)
    if (RESERVED_RENDER_PROP_NAMES.has(name))
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Runtime input '${name}' reuses a prop every block always receives`,
      );
  return (inputs, location) => {
    if (inputs === undefined) return EMPTY_RUNTIME_INPUTS;
    if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs))
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        "Component runtime inputs must be an object",
        location,
      );
    const record = inputs as Readonly<Record<string, unknown>>;
    for (const supplied of Object.keys(record))
      if (!declared.includes(supplied))
        throw new DefinitionRenderError(
          "INVALID_COMPOSITION",
          `Unexpected runtime input '${supplied}'`,
          { ...location, propertyPath: [supplied] },
        );
    const parsed: Record<string, unknown> = {};
    for (const [name, read] of Object.entries(readers))
      if (Object.hasOwn(record, name))
        parsed[name] = read(record[name], { ...location, propertyPath: [name] });
    return Object.freeze(parsed);
  };
}

/**
 * Rejects runtime inputs that do not name a placement in the resolved tree. Absent entries are
 * allowed; a supplied entry must resolve to an exact stable placement identity.
 */
export function assertRuntimeInputKeysArePlacements(
  placementIds: ReadonlySet<string>,
  runtimeInputs: unknown,
  location: DefinitionRenderErrorLocation = {},
): void {
  if (runtimeInputs === undefined) return;
  if (typeof runtimeInputs !== "object" || runtimeInputs === null || Array.isArray(runtimeInputs))
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "Component runtime inputs must be keyed by placement identity",
      location,
    );
  for (const placementId of Object.keys(runtimeInputs)) {
    if (placementId.trim().length === 0)
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        "A runtime-input key must be a non-empty placement identity",
        location,
      );
    if (!placementIds.has(placementId))
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Runtime inputs name unknown placement '${placementId}'`,
        { ...location, placementId },
      );
  }
}

/**
 * Properties every platform block's React renderer receives. The props here are the ones a block
 * always has; everything a particular component needs beyond them is a runtime input validated by
 * that block's own registration.
 */
export type PlatformBlockRenderProps = Readonly<{
  placementId: string;
  settings: Readonly<Record<string, BlockPropertyValueV2Contract>>;
  slots: Readonly<Record<string, ReactNode>>;
  breakpoint: Breakpoint;
  metadata: PlatformBlockReleaseV2;
  themeOverrides?: Readonly<Record<string, unknown>>;
  availability: "available" | "unavailable";
  unavailableReason?: "operation_unavailable";
  /**
   * The viewer's already permission-filtered application menu, projected by the server. It is the
   * one shared `ProjectedNavigation` type; a block that renders the menu never filters, rebuilds or
   * invents it. Absent evidence is an empty menu, never a guessed one.
   */
  projectedNavigation?: ProjectedNavigation;
  /**
   * Resolves one internal page identity to the address the shell routes on. Route composition owns
   * the address shape, so navigation never invents one; a navigation block given a non-empty menu
   * without a resolver is refused.
   */
  resolvePageHref?: (pageId: string) => string;
  /** Exact internal page identity currently shown, for the current-page state. */
  currentPageId?: string;
  /**
   * The resolved application theme tokens in force where this placement renders. A block that
   * passes the application theme outward, such as the sandboxed custom-component host, reads them
   * here rather than inventing a palette of its own.
   */
  themeTokens?: Readonly<Record<string, unknown>>;
  /**
   * The configured dedicated component origin. Only a block that frames the Vortex-owned bootstrap
   * document reads it, so publisher code is never loaded from a Vortex application origin.
   */
  componentBundleOrigin?: string;
}>;

/**
 * A browser-safe React component renderer for a platform block release.
 */
export type PlatformComponentRenderer = ComponentType<PlatformBlockRenderProps>;

/**
 * An immutable registration pairing exact block metadata with its React renderer and the parser
 * that validates that block's own runtime inputs. The parser is part of the registration, so a new
 * data component is a release, a component and a parser and nothing else.
 */
export type PlatformComponentRegistration = Readonly<{
  metadata: PlatformBlockReleaseV2;
  render: PlatformComponentRenderer;
  parsePayload: PlatformComponentPayloadParser;
}>;

/**
 * Immutable platform component registry.
 * The same registry used for validation is also used for renderer lookup.
 */
export interface PlatformComponentRegistry {
  /**
   * Look up exact registration by block ID and release version.
   */
  get(blockId: string, releaseVersion: string): PlatformComponentRegistration | undefined;

  /**
   * Check if an exact block ID and release version is registered.
   */
  has(blockId: string, releaseVersion: string): boolean;

  /**
   * Check if a block ID is known in any release version.
   */
  hasBlockId(blockId: string): boolean;

  /** Look up the one React renderer bound to a renderer key across exact releases. */
  getRenderer(rendererKey: string): PlatformComponentRenderer | undefined;

  /**
   * List all registered components.
   */
  list(): readonly PlatformComponentRegistration[];

  /**
   * List all block releases, matching the catalogue validation snapshot format.
   */
  getReleases(): readonly PlatformBlockReleaseV2[];

  /**
   * Export the registered releases to an immutable platform block catalogue for pure compilation snapshots.
   */
  toPlatformBlockCatalogue(
    compositionPolicy?: ApplicationCompositionPolicyV2,
  ): ImmutablePlatformBlockCatalogueV2;
}

const DEFAULT_COMPOSITION_POLICY: ApplicationCompositionPolicyV2 = {
  maximumDepth: 32,
  maximumPlacements: 512,
};

const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
};

/**
 * Creates a browser-safe immutable platform component registry.
 * Validates each metadata release against the contract schema at registration boundary.
 */
export function createPlatformComponentRegistry(
  registrations: Iterable<PlatformComponentRegistration> = [],
): PlatformComponentRegistry {
  const byIdentity = new Map<string, PlatformComponentRegistration>();
  const byRendererKey = new Map<string, PlatformComponentRegistration>();
  const blockKeyById = new Map<string, string>();
  const blockIdByKey = new Map<string, string>();
  const knownBlockIds = new Set<string>();
  const list: PlatformComponentRegistration[] = [];

  for (const registration of registrations) {
    const parsedMetadata = platformBlockReleaseV2Schema.safeParse(registration.metadata);
    if (!parsedMetadata.success) {
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Invalid platform block release metadata for '${registration.metadata?.blockId ?? "unknown"}': ${parsedMetadata.error.message}`,
        {
          ...(registration.metadata?.blockId === undefined
            ? {}
            : { blockId: registration.metadata.blockId }),
          ...(registration.metadata?.releaseVersion === undefined
            ? {}
            : { releaseVersion: registration.metadata.releaseVersion }),
        },
      );
    }

    const metadata = deepFreeze(parsedMetadata.data);
    if (!metadata.rendererKey || metadata.rendererKey.trim().length === 0) {
      throw new DefinitionRenderError(
        "ABSENT_RENDERER_KEY",
        `Block release '${metadata.key}' (${metadata.blockId}:${metadata.releaseVersion}) has no rendererKey`,
        { blockId: metadata.blockId, releaseVersion: metadata.releaseVersion },
      );
    }

    if (typeof registration.render !== "function") {
      throw new DefinitionRenderError(
        "ABSENT_RENDERER_KEY",
        `Block release '${metadata.key}' (${metadata.blockId}:${metadata.releaseVersion}) has no valid React renderer component`,
        { blockId: metadata.blockId, releaseVersion: metadata.releaseVersion },
      );
    }

    if (typeof registration.parsePayload !== "function") {
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Block release '${metadata.key}' (${metadata.blockId}:${metadata.releaseVersion}) registers no payload parser`,
        { blockId: metadata.blockId, releaseVersion: metadata.releaseVersion },
      );
    }

    const identityKey = `${metadata.blockId}:${metadata.releaseVersion}`;
    if (byIdentity.has(identityKey)) {
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Duplicate registration for block identity '${identityKey}'`,
        { blockId: metadata.blockId, releaseVersion: metadata.releaseVersion },
      );
    }

    const knownKey = blockKeyById.get(metadata.blockId);
    const knownId = blockIdByKey.get(metadata.key);
    if (
      (knownKey !== undefined && knownKey !== metadata.key) ||
      (knownId !== undefined && knownId !== metadata.blockId)
    ) {
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Block key '${metadata.key}' and permanent identity '${metadata.blockId}' must map one to one`,
        { blockId: metadata.blockId, releaseVersion: metadata.releaseVersion },
      );
    }

    const rendererRegistration = byRendererKey.get(metadata.rendererKey);
    if (rendererRegistration !== undefined && rendererRegistration.render !== registration.render) {
      throw new DefinitionRenderError(
        "RENDERER_KEY_CONFLICT",
        `Renderer key '${metadata.rendererKey}' resolves to more than one React renderer`,
        { blockId: metadata.blockId, releaseVersion: metadata.releaseVersion },
      );
    }

    const frozenRegistration: PlatformComponentRegistration = Object.freeze({
      metadata,
      render: registration.render,
      parsePayload: registration.parsePayload,
    });

    byIdentity.set(identityKey, frozenRegistration);
    knownBlockIds.add(metadata.blockId);
    blockKeyById.set(metadata.blockId, metadata.key);
    blockIdByKey.set(metadata.key, metadata.blockId);
    if (!byRendererKey.has(metadata.rendererKey)) {
      byRendererKey.set(metadata.rendererKey, frozenRegistration);
    }
    list.push(frozenRegistration);
  }

  const frozenList = Object.freeze([...list]);
  const frozenReleases = Object.freeze(list.map((item) => item.metadata));

  const registry: PlatformComponentRegistry = {
    get(blockId: string, releaseVersion: string): PlatformComponentRegistration | undefined {
      return byIdentity.get(`${blockId}:${releaseVersion}`);
    },

    has(blockId: string, releaseVersion: string): boolean {
      return byIdentity.has(`${blockId}:${releaseVersion}`);
    },

    hasBlockId(blockId: string): boolean {
      return knownBlockIds.has(blockId);
    },

    getRenderer(rendererKey: string): PlatformComponentRenderer | undefined {
      return byRendererKey.get(rendererKey)?.render;
    },

    list(): readonly PlatformComponentRegistration[] {
      return frozenList;
    },

    getReleases(): readonly PlatformBlockReleaseV2[] {
      return frozenReleases;
    },

    toPlatformBlockCatalogue(
      compositionPolicy: ApplicationCompositionPolicyV2 = DEFAULT_COMPOSITION_POLICY,
    ): ImmutablePlatformBlockCatalogueV2 {
      const parsed = immutablePlatformBlockCatalogueV2Schema.safeParse({
        compositionPolicy,
        releases: [...frozenReleases].sort(
          (first, second) =>
            first.blockId.localeCompare(second.blockId) ||
            first.releaseVersion.localeCompare(second.releaseVersion),
        ),
      });
      if (!parsed.success) {
        throw new DefinitionRenderError(
          "INVALID_COMPOSITION",
          `Invalid platform block catalogue: ${parsed.error.message}`,
        );
      }
      return deepFreeze(parsed.data);
    },
  };

  return Object.freeze(registry);
}
