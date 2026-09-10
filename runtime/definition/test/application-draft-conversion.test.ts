import fs from "node:fs";
import path from "node:path";
import {
  applicationSourceDocumentV1Schema,
  type PlatformBlockReleaseV2,
  type PlatformThemeReleaseV2,
} from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue } from "@vortex/db";
import { describe, expect, it } from "vitest";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import type {
  DefinitionPublicationCandidate,
  DefinitionPublicationCatalogue,
} from "../src/definition-publication";
import {
  confirmApplicationDraftV2Conversion,
  convertApplicationSourceV1ToV2,
  prepareApplicationDraftV2Conversion,
} from "../src/application-draft-conversion";

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "../../../testing/fixtures/historical/module-v1/applications",
);
const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const fingerprint = (letter: string) => `sha256:${letter.repeat(64)}`;
const release = (suffix: number, query = false): PlatformBlockReleaseV2 => ({
  blockId: id(suffix) as PlatformBlockReleaseV2["blockId"],
  key: `vortex.block.${suffix}`,
  releaseVersion: "9.1.0",
  contentFingerprint: fingerprint("a"),
  catalogueFingerprint: fingerprint("b"),
  name: "Mapped block",
  icon: "box",
  paletteGroup: "content",
  rendererKey: "vortex.renderer.mapped",
  properties: query
    ? [{ kind: "query_reference", key: "source", label: "Source", required: true }]
    : [],
  slots: [
    { key: "content", label: "Content", required: false, allowedChildCategories: ["content"] },
  ],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    accessibleName: "not_applicable",
    publicSurface: "allowed",
  },
});
const theme: PlatformThemeReleaseV2 = {
  catalogueThemeId: id(800) as PlatformThemeReleaseV2["catalogueThemeId"],
  key: "vortex.theme.base",
  releaseVersion: "4.0.0",
  contentFingerprint: fingerprint("c"),
  catalogueFingerprint: fingerprint("d"),
  name: "Base",
  tokens: {},
};
const fixture = (name: string) =>
  applicationSourceDocumentV1Schema.parse(
    JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), "utf8")),
  );

const setup = (source: ReturnType<typeof fixture>) => {
  const used = new Set(
    source.body.pages.flatMap((page) =>
      page.type === "list"
        ? []
        : page.type === "guided_form"
          ? page.steps.flatMap((step) => step.blocks.map((block) => block.block))
          : page.blocks.map((block) => block.block),
    ),
  );
  const blocks = new Map<string, PlatformBlockReleaseV2>();
  let next = 810;
  const blockMappings = [...used].map((legacyRegistrationId) => {
    const selected = release(next++);
    blocks.set(legacyRegistrationId, selected);
    return {
      legacyRegistrationId,
      platformBlockId: selected.blockId,
      platformReleaseVersion: selected.releaseVersion,
      propertyMappings: [],
    };
  });
  const listRelease = release(899, true);
  const listBlocks = new Map<string, PlatformBlockReleaseV2>();
  const listPageMappings = source.body.pages
    .filter((page) => page.type === "list")
    .map((page) => {
      listBlocks.set(page.id, listRelease);
      return {
        pageId: page.id,
        placementId: `${page.id}_primary`,
        platformBlockId: listRelease.blockId,
        platformReleaseVersion: listRelease.releaseVersion,
        propertyMappings: [{ sourceSettingKey: "query", targetPropertyKey: "source" }],
      };
    });
  const selection = {
    rootId: id(1),
    expectedDraftRevision: 1,
    blockMappings,
    listPageMappings,
    theme: {
      catalogueThemeId: theme.catalogueThemeId,
      releaseVersion: theme.releaseVersion,
      legacyThemeHandling: {
        brand: { representedBy: "base" as const },
        density: { representedBy: "base" as const },
        corners: { representedBy: "base" as const },
        focus: { representedBy: "base" as const },
      },
      tokenOverrides: {},
    },
  };
  const resolved = {
    blocks,
    listBlocks,
    shellBlocks: new Map<string, PlatformBlockReleaseV2>(),
    theme,
  };
  return {
    selection,
    resolved,
    converted: convertApplicationSourceV1ToV2(source, selection, resolved),
  };
};
const conversion = (source: ReturnType<typeof fixture>) => setup(source).converted;

describe("application draft V1 to V2 conversion", () => {
  it.each(["crm.json", "service-desk.json"])(
    "preserves page families and non-empty list composition for %s",
    (name) => {
      const source = fixture(name);
      const converted = conversion(source);
      expect(converted.body.shells).toEqual([]);
      expect(converted.body.pages.map((page) => [page.id, page.type])).toEqual(
        source.body.pages.map((page) => [page.id, page.type]),
      );
      for (const page of converted.body.pages)
        if (page.type === "guided_form")
          expect(Object.keys(page.composition.step_content)).toEqual(
            page.steps.map((step) => step.id),
          );
        else if (page.type === "list")
          expect(Object.keys(page.composition.main.placements)).toHaveLength(1);
      for (const sourcePage of source.body.pages) {
        const convertedPage = converted.body.pages.find((page) => page.id === sourcePage.id)!;
        if (sourcePage.type === "list") continue;
        const sourceBlocks =
          sourcePage.type === "guided_form"
            ? sourcePage.steps.flatMap((step) => step.blocks)
            : sourcePage.blocks;
        const targetSlots =
          convertedPage.type === "guided_form"
            ? Object.values(convertedPage.composition.step_content)
            : [convertedPage.composition.main];
        const targetPlacements = targetSlots.flatMap((slot) => Object.entries(slot.placements));
        for (const block of sourceBlocks) {
          const mapped = targetPlacements.find(([placementId]) => placementId === block.id)?.[1];
          expect(mapped?.visibility_condition).toEqual(block.visibility_condition);
          expect(mapped?.query).toBe(block.query);
        }
        if (sourcePage.type === "guided_form")
          for (const step of sourcePage.steps) {
            const ids = new Set(step.blocks.map((block) => block.id));
            const slot =
              convertedPage.type === "guided_form"
                ? convertedPage.composition.step_content[step.id]
                : undefined;
            expect(slot?.order.desktop).toEqual(
              sourcePage.layout.desktop.component_order.filter((id) => ids.has(id)),
            );
            expect(slot?.order.phone).toEqual(
              sourcePage.layout.phone.component_order.filter((id) => ids.has(id)),
            );
          }
        else if (sourcePage.type !== "list" && convertedPage.type !== "guided_form") {
          expect(convertedPage.composition.main.order.desktop).toEqual(
            sourcePage.layout.desktop.component_order,
          );
          expect(convertedPage.composition.main.order.phone).toEqual(
            sourcePage.layout.phone.component_order,
          );
        }
      }
    },
  );

  it("prepares without writes and confirms only the recomputed current preview through saveDraft", async () => {
    const source = fixture("crm.json");
    const { selection, resolved, converted } = setup(source);
    const candidate = {
      draft: {
        kind: "application",
        rootId: selection.rootId,
        source,
        organizationId: id(9),
        key: source.key,
        draftRevision: 1,
        sourceContractVersion: "1.0.0",
        sourceFingerprint: fingerprintCanonicalValue(source),
        createdAt: "2026-09-01T00:00:00.000Z",
        createdBy: id(10),
        updatedAt: "2026-09-01T00:00:00.000Z",
        updatedBy: id(10),
      },
      identities: [],
      history: { kind: "application", definitionKey: source.key, history: [] },
    } as unknown as DefinitionPublicationCandidate;
    const catalogue = {
      readPlatformBlockReleaseV2: async (blockId: string) =>
        [...resolved.blocks.values(), ...resolved.listBlocks.values()].find(
          (entry) => entry.blockId === blockId,
        ),
      readPlatformThemeReleaseV2: async () => theme,
    } as unknown as DefinitionPublicationCatalogue;
    let writes = 0;
    const transaction = {
      readCandidate: async () => candidate,
      listModuleReleases: async () => [],
      readModuleRelease: async () => undefined,
      query: async <Row extends DatabaseRow>(
        strings: TemplateStringsArray,
        ...values: readonly DatabaseValue[]
      ) => {
        void strings;
        void values;
        writes += 1;
        return [
          {
            root_id: selection.rootId,
            organization_id: id(9),
            kind: "application",
            definition_key: source.key,
            draft_revision: "2",
            published_revision: null,
            authored_source: converted,
            source_contract_version: "2.0.0",
            source_fingerprint: fingerprintCanonicalValue(converted),
            created_at: "2026-09-01T00:00:00.000Z",
            created_by: id(10),
            updated_at: "2026-09-01T00:00:00.000Z",
            updated_by: id(10),
          },
        ] as Row[];
      },
    };
    const preview = await prepareApplicationDraftV2Conversion(transaction, selection, catalogue);
    expect(writes).toBe(0);
    expect(preview.preparedSource).toEqual(converted);
    expect(preview.sourceFingerprint).toBe(candidate.draft.sourceFingerprint);
    expect(preview.preparedSourceFingerprint).toBe(fingerprintCanonicalValue(converted));
    expect(preview.resolvedTheme).toMatchObject({
      catalogueThemeId: theme.catalogueThemeId,
      releaseVersion: theme.releaseVersion,
      contentFingerprint: theme.contentFingerprint,
      catalogueFingerprint: theme.catalogueFingerprint,
    });
    await expect(
      confirmApplicationDraftV2Conversion(
        transaction,
        { ...selection, preparedSourceFingerprint: fingerprint("f"), confirmation: "convert" },
        catalogue,
      ),
    ).rejects.toMatchObject({ code: "CONVERSION_PREVIEW_CHANGED" });
    expect(writes).toBe(0);
    const saved = await confirmApplicationDraftV2Conversion(
      transaction,
      {
        ...selection,
        preparedSourceFingerprint: preview.preparedSourceFingerprint,
        confirmation: "convert",
      },
      catalogue,
    );
    expect(saved.draftRevision).toBe(2);
    expect(writes).toBe(1);

    const stale = {
      ...transaction,
      readCandidate: async () => ({
        ...candidate,
        draft: { ...candidate.draft, draftRevision: 2 },
      }),
    };
    await expect(
      prepareApplicationDraftV2Conversion(stale, selection, catalogue),
    ).rejects.toMatchObject({ code: "CONVERSION_REFUSED" });
    expect(writes).toBe(1);

    const foreign = {
      ...transaction,
      readCandidate: async () => ({
        ...candidate,
        draft: { ...candidate.draft, rootId: id(999) },
      }),
    };
    await expect(
      prepareApplicationDraftV2Conversion(foreign, selection, catalogue),
    ).rejects.toMatchObject({ reason: "stale_or_not_v1" });

    const missingCatalogue = {
      ...catalogue,
      readPlatformBlockReleaseV2: async () => undefined,
    } as unknown as DefinitionPublicationCatalogue;
    await expect(
      prepareApplicationDraftV2Conversion(transaction, selection, missingCatalogue),
    ).rejects.toMatchObject({ reason: "missing_catalogue_release" });
    expect(writes).toBe(1);

    const changedCatalogue = {
      ...catalogue,
      readPlatformThemeReleaseV2: async () => ({ ...theme, contentFingerprint: fingerprint("e") }),
    } as unknown as DefinitionPublicationCatalogue;
    await expect(
      confirmApplicationDraftV2Conversion(
        transaction,
        {
          ...selection,
          preparedSourceFingerprint: preview.preparedSourceFingerprint,
          confirmation: "convert",
        },
        changedCatalogue,
      ),
    ).rejects.toMatchObject({ code: "CONVERSION_PREVIEW_CHANGED" });
    expect(writes).toBe(1);
  });

  it("resolves a shell-only block and partitions ordinary and guided placements", async () => {
    const source = fixture("crm.json");
    const built = setup(source);
    const shellRelease = release(990);
    built.resolved.shellBlocks.set(
      `${shellRelease.blockId}:${shellRelease.releaseVersion}`,
      shellRelease,
    );
    const shell = {
      id: "converted_shell",
      key: "converted_shell",
      name: "Converted shell",
      layout: {
        placements: {
          shell_frame: {
            block: { block_id: shellRelease.blockId, release_version: shellRelease.releaseVersion },
            settings: {},
            theme_overrides: {},
            responsive: {
              desktop: {
                visible: true,
                width: { kind: "fill" as const },
                height: { kind: "content" as const },
              },
            },
            slots: { content: { placements: {}, order: { desktop: [] } } },
          },
        },
        order: { desktop: ["shell_frame"] },
      },
      content_slots: [
        {
          id: "primary",
          key: "primary",
          label: "Primary",
          required: true,
          allowed_child_categories: ["content" as const],
          parent_placement: "shell_frame",
          parent_slot: "content",
        },
      ],
    };
    const dashboard = source.body.pages.find((page) => page.type === "dashboard")!;
    const guided = source.body.pages.find((page) => page.type === "guided_form")!;
    const bind = (ids: string[]) =>
      Object.fromEntries(ids.map((placementId) => [placementId, "primary"]));
    const customShells = [
      {
        pageId: dashboard.id,
        shell,
        contentSlots: bind(dashboard.blocks.map((block) => block.id)),
      },
      {
        pageId: guided.id,
        shell,
        contentSlots: {},
        stepContentSlots: Object.fromEntries(
          guided.steps.map((step) => [step.id, bind(step.blocks.map((block) => block.id))]),
        ),
      },
    ];
    const converted = convertApplicationSourceV1ToV2(
      source,
      { ...built.selection, customShells },
      built.resolved,
    );
    expect(converted.body.shells).toEqual([shell]);
    expect(
      converted.body.pages.find((page) => page.id === dashboard.id)?.composition.shell_kind,
    ).toBe("application");
    const guidedPage = converted.body.pages.find((page) => page.id === guided.id)!;
    if (guidedPage.type !== "guided_form" || guidedPage.composition.shell_kind !== "application")
      throw new Error("Guided custom shell required");
    expect(
      Object.values(guidedPage.composition.step_content).every((content) =>
        Object.keys(content).includes("primary"),
      ),
    ).toBe(true);
    const candidate = {
      draft: {
        kind: "application",
        rootId: built.selection.rootId,
        source,
        organizationId: id(9),
        key: source.key,
        draftRevision: 1,
        sourceContractVersion: "1.0.0",
        sourceFingerprint: fingerprintCanonicalValue(source),
        createdAt: "2026-09-01T00:00:00.000Z",
        createdBy: id(10),
        updatedAt: "2026-09-01T00:00:00.000Z",
        updatedBy: id(10),
      },
      identities: [],
      history: { kind: "application", definitionKey: source.key, history: [] },
    } as unknown as DefinitionPublicationCandidate;
    const catalogue = {
      readPlatformBlockReleaseV2: async (blockId: string) =>
        [
          ...built.resolved.blocks.values(),
          ...built.resolved.listBlocks.values(),
          shellRelease,
        ].find((entry) => entry.blockId === blockId),
      readPlatformThemeReleaseV2: async () => theme,
    } as unknown as DefinitionPublicationCatalogue;
    const preview = await prepareApplicationDraftV2Conversion(
      {
        readCandidate: async () => candidate,
        listModuleReleases: async () => [],
        readModuleRelease: async () => undefined,
        query: async () => {
          throw new Error("prepare wrote");
        },
      },
      { ...built.selection, customShells },
      catalogue,
    );
    expect(preview.resolvedBlocks).toContainEqual(
      expect.objectContaining({
        blockId: shellRelease.blockId,
        releaseVersion: shellRelease.releaseVersion,
      }),
    );
    const conflictingShells = structuredClone(customShells);
    conflictingShells[1]!.shell = { ...conflictingShells[1]!.shell, name: "Conflicting shell" };
    expect(() =>
      convertApplicationSourceV1ToV2(
        source,
        { ...built.selection, customShells: conflictingShells },
        built.resolved,
      ),
    ).toThrowError("CONVERSION_REFUSED:duplicate_mapping");
    const incomplete = structuredClone(customShells);
    incomplete[0]!.contentSlots = {};
    expect(() =>
      convertApplicationSourceV1ToV2(
        source,
        { ...built.selection, customShells: incomplete },
        built.resolved,
      ),
    ).toThrowError("CONVERSION_REFUSED:incomplete_custom_shell");
  });

  it("validates explicit property and theme mappings without requiring override attribution", () => {
    const source = structuredClone(fixture("crm.json"));
    const dashboard = source.body.pages.find((page) => page.type === "dashboard")!;
    const built = setup(source);
    dashboard.blocks[0]!.settings.title = { kind: "literal", value: "Pipeline" };
    dashboard.blocks[0]!.settings.image = { kind: "literal", value: id(777) };
    dashboard.blocks[0]!.settings.details = {
      kind: "literal",
      value: { required_text: "Kept" },
    };
    dashboard.blocks[0]!.settings.body = {
      kind: "literal",
      value: { blocks: [{ kind: "paragraph", children: [{ kind: "text", text: "Hello" }] }] },
    };
    const mapping = built.selection.blockMappings.find(
      (entry) => entry.legacyRegistrationId === dashboard.blocks[0]!.block,
    )!;
    mapping.propertyMappings.push({ sourceSettingKey: "title", targetPropertyKey: "heading" });
    mapping.propertyMappings.push({ sourceSettingKey: "image", targetPropertyKey: "image" });
    mapping.propertyMappings.push({ sourceSettingKey: "details", targetPropertyKey: "details" });
    mapping.propertyMappings.push({ sourceSettingKey: "body", targetPropertyKey: "body" });
    const selected = built.resolved.blocks.get(mapping.legacyRegistrationId)!;
    built.resolved.blocks.set(mapping.legacyRegistrationId, {
      ...selected,
      properties: [
        {
          kind: "text",
          key: "heading",
          label: "Heading",
          required: true,
          minLength: 1,
          maxLength: 120,
        },
        { kind: "asset_reference", key: "image", label: "Image", required: true },
        {
          kind: "group",
          key: "details",
          label: "Details",
          required: true,
          properties: [
            {
              kind: "text",
              key: "required_text",
              label: "Required",
              required: true,
              minLength: 1,
              maxLength: 120,
            },
            { kind: "boolean", key: "optional_flag", label: "Optional", required: false },
            {
              kind: "text",
              key: "default_text",
              label: "Defaulted",
              required: true,
              minLength: 1,
              maxLength: 120,
              defaultValue: { kind: "text", value: "Default" },
            },
          ],
        },
        {
          kind: "rich_text",
          key: "body",
          label: "Body",
          required: true,
          allowedElements: ["paragraph"],
        },
      ],
    });
    built.resolved.theme = {
      ...built.resolved.theme,
      tokens: { extra_spacing: { kind: "spacing", rem: 1 } },
    };
    const selectedWithOverride = {
      ...built.selection,
      theme: {
        ...built.selection.theme,
        tokenOverrides: { extra_spacing: { kind: "spacing" as const, rem: 2 } },
      },
    };
    expect(() =>
      convertApplicationSourceV1ToV2(source, selectedWithOverride, built.resolved),
    ).not.toThrow();
    const converted = convertApplicationSourceV1ToV2(source, selectedWithOverride, built.resolved);
    const convertedDashboard = converted.body.pages.find((page) => page.type === "dashboard")!;
    if (convertedDashboard.composition.shell_kind !== "default")
      throw new Error("Default dashboard required");
    expect(
      Object.values(convertedDashboard.composition.main.placements)[0]!.settings,
    ).toMatchObject({
      image: { kind: "asset_reference", asset_id: id(777) },
      details: { kind: "group", properties: { required_text: { kind: "text", value: "Kept" } } },
    });
    const { legacyThemeHandling: _handling, ...themeWithoutHandling } = built.selection.theme;
    void _handling;
    expect(() =>
      convertApplicationSourceV1ToV2(
        source,
        { ...built.selection, theme: themeWithoutHandling },
        built.resolved,
      ),
    ).toThrowError("CONVERSION_REFUSED:theme_mapping");
    dashboard.blocks[0]!.settings.title = { kind: "literal", value: false };
    expect(() =>
      convertApplicationSourceV1ToV2(source, selectedWithOverride, built.resolved),
    ).toThrowError("CONVERSION_REFUSED");
    dashboard.blocks[0]!.settings.title = { kind: "literal", value: "Pipeline" };
    const richProperty = built.resolved.blocks
      .get(mapping.legacyRegistrationId)!
      .properties.find((property) => property.key === "body");
    if (!richProperty || richProperty.kind !== "rich_text")
      throw new Error("Rich property required");
    richProperty.allowedElements = ["heading"];
    expect(() =>
      convertApplicationSourceV1ToV2(source, selectedWithOverride, built.resolved),
    ).toThrowError("CONVERSION_REFUSED:incompatible_property");
    richProperty.allowedElements = ["paragraph"];
    const constrained = built.resolved.blocks.get(mapping.legacyRegistrationId)!;
    constrained.capabilities = {
      ...constrained.capabilities,
      accessibleName: "required",
      accessibleNamePropertyPath: ["heading"],
    };
    dashboard.blocks[0]!.settings.title = { kind: "literal", value: "   " };
    expect(() =>
      convertApplicationSourceV1ToV2(source, selectedWithOverride, built.resolved),
    ).toThrowError("CONVERSION_REFUSED:incompatible_property");
    constrained.capabilities = {
      ...constrained.capabilities,
      accessibleName: "optional",
      accessibleNamePropertyPath: ["heading"],
    };
    expect(() =>
      convertApplicationSourceV1ToV2(source, selectedWithOverride, built.resolved),
    ).toThrowError("CONVERSION_REFUSED:incompatible_property");
    dashboard.blocks[0]!.settings.title = { kind: "literal", value: "Pipeline" };
    constrained.capabilities = { ...constrained.capabilities, gridWidth: false };
    expect(() =>
      convertApplicationSourceV1ToV2(source, selectedWithOverride, built.resolved),
    ).toThrowError("CONVERSION_REFUSED:incompatible_property");
  });

  it("refuses a generated public placement whose selected block is not public-safe", () => {
    const source = fixture("service-desk.json");
    const built = setup(source);
    const publicPage = source.body.pages.find((page) => page.type === "public")!;
    const mapping = built.selection.blockMappings.find(
      (entry) => entry.legacyRegistrationId === publicPage.blocks[0]!.block,
    )!;
    const selected = built.resolved.blocks.get(mapping.legacyRegistrationId)!;
    selected.capabilities = { ...selected.capabilities, publicSurface: "refused" };
    expect(() =>
      convertApplicationSourceV1ToV2(source, built.selection, built.resolved),
    ).toThrowError("CONVERSION_REFUSED:incompatible_property");
  });
});
