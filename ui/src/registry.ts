import type { ComponentType, ReactNode } from "react";
import {
  immutablePlatformBlockCatalogueV2Schema,
  platformBlockReleaseV2Schema,
  type ApplicationCompositionPolicyV2,
  type BlockPropertyValueV2Contract,
  type ImmutablePlatformBlockCatalogueV2,
  type PlatformBlockReleaseV2,
} from "@vortex/contracts";
import type { Breakpoint } from "./definition-error";
import { DefinitionRenderError } from "./definition-error";
import type {
  DisplayEventHandlers,
  ProjectedDisplayData,
} from "./display/projected-data";

/**
 * Properties passed to a platform block's React renderer.
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
  projectedData?: ProjectedDisplayData;
  displayEvents?: DisplayEventHandlers;
}>;

/**
 * A browser-safe React component renderer for a platform block release.
 */
export type PlatformComponentRenderer = ComponentType<PlatformBlockRenderProps>;

/**
 * An immutable registration pairing exact block metadata with its React renderer.
 */
export type PlatformComponentRegistration = Readonly<{
  metadata: PlatformBlockReleaseV2;
  render: PlatformComponentRenderer;
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
