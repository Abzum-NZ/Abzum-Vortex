import fs from "node:fs";
import path from "node:path";
import {
  connectionTypeSourceDocumentSchema,
  definitionResolutionSnapshotSchema,
  type BlockId,
  type ConnectionTypeId,
  type PlatformId,
  type SemanticVersion,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import { createImmutableDefinitionPublicationCatalogue } from "../src/definition-publication-catalogue";

const fixtureRoot = path.resolve(import.meta.dirname, "../../../testing/fixtures");
const source = connectionTypeSourceDocumentSchema.parse(
  JSON.parse(fs.readFileSync(path.join(fixtureRoot, "connection-types/email.json"), "utf8")),
);
const fixtureResolution = definitionResolutionSnapshotSchema.parse(
  JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "definition-resolution-snapshot.json"), "utf8"),
  ),
);
const resolvedConnection = fixtureResolution.definitions.find(
  (definition) => definition.kind === "connection_type" && definition.key === source.key,
);
if (resolvedConnection?.kind !== "connection_type") throw new Error("Connection fixture missing");
const rootId = resolvedConnection.rootId;
const themeId = "70000000-0000-4000-8000-000000000001" as PlatformId;
const themeContentFingerprint = `sha256:${"b".repeat(64)}`;
const connectionRelease = (releaseVersion: SemanticVersion) => ({
  source,
  rootId,
  releaseVersion,
});
const blockId = "70000000-0000-4000-8000-000000000010" as BlockId;
const secondBlockId = "70000000-0000-4000-8000-000000000011" as BlockId;
const blockDefinition = (id: BlockId = blockId) => ({
  blockId: id,
  key: id === blockId ? "vortex.block.content" : "vortex.block.layout",
  releaseVersion: "1.0.0" as const,
  name: id === blockId ? "Content" : "Layout",
  icon: "layout-template",
  paletteGroup: id === blockId ? ("content" as const) : ("layout" as const),
  rendererKey: id === blockId ? "vortex.renderer.content" : "vortex.renderer.layout",
  properties: [],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded" as const,
    accessibleName: "not_applicable" as const,
    publicSurface: "allowed" as const,
  },
});
const themeDefinitionV2 = {
  catalogueThemeId: themeId,
  releaseVersion: "2.1.0" as const,
  tokens: {
    brand: { kind: "color_pair" as const, light: "#123456", dark: "#abcdef" },
    density: { kind: "density" as const, value: "comfortable" as const },
  },
};
const applicationCompositionV2 = {
  compositionPolicy: { maximumDepth: 12, maximumPlacements: 1_000 },
  platformBlockReleases: [blockDefinition(), blockDefinition(secondBlockId)],
  platformThemeReleases: [themeDefinitionV2],
};

describe("immutable Definition publication catalogue", () => {
  it("lists governed connection releases deterministically and reads only an exact identity", async () => {
    const catalogue = createImmutableDefinitionPublicationCatalogue({
      connectionTypeReleases: [connectionRelease("1.4.0"), connectionRelease("1.0.0")],
      platformThemeReleases: [],
    });

    const releases = await catalogue.listConnectionTypeReleases(source.key);
    expect(releases.map((release) => release.releaseVersion)).toEqual(["1.0.0", "1.4.0"]);
    expect(releases[1]?.compilationOutput.canonical.operations.map(({ key }) => key)).toEqual([
      "send_message",
      "send_template",
    ]);
    await expect(catalogue.readConnectionTypeRelease(rootId, "1.0.0")).resolves.toBe(releases[0]);
    await expect(
      catalogue.readConnectionTypeRelease(
        "70000000-0000-4000-8000-000000000099" as ConnectionTypeId,
        "1.0.0",
      ),
    ).resolves.toBeUndefined();
    await expect(catalogue.readConnectionTypeRelease(rootId, "1.0.1")).resolves.toBeUndefined();
    await expect(
      catalogue.listConnectionTypeReleases("vortex.connection.missing"),
    ).resolves.toEqual([]);
    expect(Object.isFrozen(releases)).toBe(true);
    expect(Object.isFrozen(releases[0]?.compilationOutput.canonical)).toBe(true);
  });

  it("looks up platform themes only by their exact immutable release", async () => {
    const catalogue = createImmutableDefinitionPublicationCatalogue({
      connectionTypeReleases: [],
      platformThemeReleases: [
        {
          catalogueThemeId: themeId,
          releaseVersion: "2.1.0",
          contentFingerprint: themeContentFingerprint,
        },
      ],
    });

    const theme = await catalogue.readPlatformThemeRelease(themeId, "2.1.0");
    expect(theme).toMatchObject({
      catalogueThemeId: themeId,
      releaseVersion: "2.1.0",
      contentFingerprint: themeContentFingerprint,
    });
    expect(theme?.catalogueFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(catalogue.readPlatformThemeRelease(themeId, "2.1.1")).resolves.toBeUndefined();
    await expect(
      catalogue.readPlatformThemeRelease("70000000-0000-4000-8000-000000000002", "2.1.0"),
    ).resolves.toBeUndefined();
  });

  it("keeps exact release evidence stable when unrelated catalogue releases are added", async () => {
    const original = createImmutableDefinitionPublicationCatalogue({
      connectionTypeReleases: [connectionRelease("1.0.0")],
      platformThemeReleases: [
        {
          catalogueThemeId: themeId,
          releaseVersion: "2.1.0",
          contentFingerprint: themeContentFingerprint,
        },
      ],
    });
    const extended = createImmutableDefinitionPublicationCatalogue({
      connectionTypeReleases: [connectionRelease("1.0.0"), connectionRelease("1.1.0")],
      platformThemeReleases: [
        {
          catalogueThemeId: themeId,
          releaseVersion: "2.1.0",
          contentFingerprint: themeContentFingerprint,
        },
        {
          catalogueThemeId: "70000000-0000-4000-8000-000000000002",
          releaseVersion: "1.0.0",
          contentFingerprint: `sha256:${"c".repeat(64)}`,
        },
      ],
    });

    await expect(original.readConnectionTypeRelease(rootId, "1.0.0")).resolves.toMatchObject({
      catalogueFingerprint: (await extended.readConnectionTypeRelease(rootId, "1.0.0"))
        ?.catalogueFingerprint,
    });
    await expect(original.readPlatformThemeRelease(themeId, "2.1.0")).resolves.toMatchObject({
      catalogueFingerprint: (await extended.readPlatformThemeRelease(themeId, "2.1.0"))
        ?.catalogueFingerprint,
    });
  });

  it("reads exact V2 composition releases and locks a deterministic fingerprinted snapshot", async () => {
    const catalogue = createImmutableDefinitionPublicationCatalogue({
      connectionTypeReleases: [],
      platformThemeReleases: [],
      applicationCompositionV2,
    });
    const content = await catalogue.readPlatformBlockReleaseV2(blockId, "1.0.0");
    const theme = await catalogue.readPlatformThemeReleaseV2(themeId, "2.1.0");
    expect(content).toMatchObject({
      blockId,
      key: "vortex.block.content",
      releaseVersion: "1.0.0",
    });
    expect(content?.contentFingerprint).toBe(
      fingerprintCanonicalValue({
        name: "Content",
        icon: "layout-template",
        paletteGroup: "content",
        rendererKey: "vortex.renderer.content",
        properties: [],
        slots: [],
        capabilities: blockDefinition().capabilities,
      }),
    );
    expect(theme?.contentFingerprint).toBe(fingerprintCanonicalValue(themeDefinitionV2.tokens));

    const snapshot = await catalogue.readApplicationCompositionCatalogueSnapshotV2({
      platformBlocks: [
        { blockId: secondBlockId, releaseVersion: "1.0.0" },
        { blockId, releaseVersion: "1.0.0" },
      ],
      platformTheme: { catalogueThemeId: themeId, releaseVersion: "2.1.0" },
    });
    expect(snapshot?.platformBlocks.releases.map((release) => release.blockId)).toEqual([
      blockId,
      secondBlockId,
    ]);
    if (snapshot === undefined) throw new Error("V2 snapshot missing");
    const { fingerprint, ...evidence } = snapshot;
    expect(fingerprint).toBe(fingerprintCanonicalValue(evidence));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.platformBlocks.releases[0])).toBe(true);
    await expect(
      catalogue.readApplicationCompositionCatalogueSnapshotV2({
        platformBlocks: [{ blockId, releaseVersion: "9.0.0" }],
        platformTheme: { catalogueThemeId: themeId, releaseVersion: "2.1.0" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      catalogue.readApplicationCompositionCatalogueSnapshotV2({
        platformBlocks: [
          { blockId, releaseVersion: "1.0.0" },
          { blockId, releaseVersion: "1.0.0" },
        ],
        platformTheme: { catalogueThemeId: themeId, releaseVersion: "2.1.0" },
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps V2 catalogue methods unavailable without governed V2 definitions", async () => {
    const catalogue = createImmutableDefinitionPublicationCatalogue({
      connectionTypeReleases: [],
      platformThemeReleases: [],
    });
    await expect(catalogue.readPlatformBlockReleaseV2(blockId, "1.0.0")).resolves.toBeUndefined();
    await expect(catalogue.readPlatformThemeReleaseV2(themeId, "2.1.0")).resolves.toBeUndefined();
    await expect(
      catalogue.readApplicationCompositionCatalogueSnapshotV2({
        platformBlocks: [{ blockId, releaseVersion: "1.0.0" }],
        platformTheme: { catalogueThemeId: themeId, releaseVersion: "2.1.0" },
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses ambiguous versions and connection-key substitutions at construction", () => {
    expect(() =>
      createImmutableDefinitionPublicationCatalogue({
        connectionTypeReleases: [connectionRelease("1.0.0"), connectionRelease("1.0.0")],
        platformThemeReleases: [],
      }),
    ).toThrow("INVALID_PLATFORM_RELEASE_CATALOGUE");

    expect(() =>
      createImmutableDefinitionPublicationCatalogue({
        connectionTypeReleases: [
          connectionRelease("1.0.0"),
          {
            source,
            rootId: "70000000-0000-4000-8000-000000000003",
            releaseVersion: "1.1.0",
          },
        ],
        platformThemeReleases: [],
      }),
    ).toThrow("INVALID_PLATFORM_RELEASE_CATALOGUE");

    expect(() =>
      createImmutableDefinitionPublicationCatalogue({
        connectionTypeReleases: [],
        platformThemeReleases: [],
        applicationCompositionV2: {
          ...applicationCompositionV2,
          platformBlockReleases: [blockDefinition(), blockDefinition()],
        },
      }),
    ).toThrow("INVALID_PLATFORM_RELEASE_CATALOGUE");
  });
});
