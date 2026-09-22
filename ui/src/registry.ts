import type { ComponentType, CSSProperties, ReactNode } from "react";
import {
  platformBlockReleaseV2Schema,
  type ApplicationCompositionPolicyV2,
  type BlockPropertyValueV2Contract,
  type ImmutablePlatformBlockCatalogueV2,
  type PlatformBlockReleaseV2,
} from "@vortex/contracts";
import { DefinitionRenderError, type Breakpoint } from "./definition-error";

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
  className?: string;
  style?: CSSProperties;
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

  /**
   * Look up registration by renderer key (e.g. "platform.renderer.stack").
   */
  getByRendererKey(rendererKey: string): PlatformComponentRegistration | undefined;

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

/**
 * Creates a browser-safe immutable platform component registry.
 * Validates each metadata release against the contract schema at registration boundary.
 */
export function createPlatformComponentRegistry(
  registrations: Iterable<PlatformComponentRegistration> = [],
): PlatformComponentRegistry {
  const byIdentity = new Map<string, PlatformComponentRegistration>();
  const byRendererKey = new Map<string, PlatformComponentRegistration>();
  const knownBlockIds = new Set<string>();
  const list: PlatformComponentRegistration[] = [];

  for (const registration of registrations) {
    const parsedMetadata = platformBlockReleaseV2Schema.safeParse(registration.metadata);
    if (!parsedMetadata.success) {
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Invalid platform block release metadata for '${registration.metadata?.blockId ?? "unknown"}': ${parsedMetadata.error.message}`,
        {
          blockId: registration.metadata?.blockId,
          releaseVersion: registration.metadata?.releaseVersion,
        },
      );
    }

    const metadata = parsedMetadata.data;
    if (!metadata.rendererKey || metadata.rendererKey.trim().length === 0) {
      throw new DefinitionRenderError(
        "ABSENT_RENDERER_KEY",
        `Block release '${metadata.key}' (${metadata.blockId}:${metadata.releaseVersion}) has no rendererKey`,
        { blockId: metadata.blockId, releaseVersion: metadata.releaseVersion },
      );
    }

    if (typeof registration.render !== "function" && typeof registration.render !== "object") {
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

    const frozenRegistration: PlatformComponentRegistration = Object.freeze({
      metadata,
      render: registration.render,
    });

    byIdentity.set(identityKey, frozenRegistration);
    knownBlockIds.add(metadata.blockId);
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

    getByRendererKey(rendererKey: string): PlatformComponentRegistration | undefined {
      return byRendererKey.get(rendererKey);
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
      return Object.freeze({
        compositionPolicy: Object.freeze({ ...compositionPolicy }),
        releases: Object.freeze(
          [...frozenReleases].sort((first, second) => first.blockId.localeCompare(second.blockId)),
        ),
      });
    },
  };

  return Object.freeze(registry);
}
