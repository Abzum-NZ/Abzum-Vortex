import fs from "node:fs";
import path from "node:path";
import {
  applicationCanonicalDocumentV2Schema,
  applicationCompilationOutputV2Schema,
  applicationCompilationRequestV2Schema,
  applicationContentV2Schema,
  applicationDraftSchema,
  applicationDraftV2Schema,
  applicationSourceDocumentV2Schema,
  blockPropertySchemaV2Schema,
  blockPropertyValueV2Schema,
  definitionCompilationOutputSchema,
  definitionCompilationRequestSchema,
  definitionResolutionSnapshotSchema,
  definitionResolutionSnapshotV2Schema,
  immutablePlatformBlockCatalogueV2Schema,
  platformBlockReleaseV2Schema,
  platformBlockDependenciesV2SchemaForCatalogue,
  selectApplicationContractPair,
  sourceBlockPropertyValueV2Schema,
  sourceIdentityAssignmentSchema,
  sourceIdentityAssignmentV2Schema,
  sourceIdentityKindSchema,
  sourceIdentityKindV2Schema,
} from "../src";
import { describe, expect, it, test } from "vitest";

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const fingerprint = (letter: string) => `sha256:${letter.repeat(64)}`;

const blockOne = {
  kind: "platform_block",
  blockId: id(610),
  releaseVersion: "1.0.0",
  contentFingerprint: fingerprint("a"),
  catalogueFingerprint: fingerprint("b"),
} as const;
const blockTwo = {
  kind: "platform_block",
  blockId: id(611),
  releaseVersion: "2.1.0",
  contentFingerprint: fingerprint("c"),
  catalogueFingerprint: fingerprint("d"),
} as const;
const sourceBlockOne = {
  kind: "platform_block",
  block_id: id(610),
  release_version: "1.0.0",
  content_fingerprint: fingerprint("a"),
  catalogue_fingerprint: fingerprint("b"),
} as const;
const sourceBlockTwo = {
  kind: "platform_block",
  block_id: id(611),
  release_version: "2.1.0",
  content_fingerprint: fingerprint("c"),
  catalogue_fingerprint: fingerprint("d"),
} as const;

const canonicalLayout = {
  visible: true,
  width: { kind: "fill" },
  height: { kind: "content" },
} as const;
const responsive = {
  desktop: canonicalLayout,
  tablet: canonicalLayout,
  phone: canonicalLayout,
} as const;
const sourceResponsive = { desktop: canonicalLayout, phone: canonicalLayout } as const;

const canonicalPlacement = (
  block: typeof blockOne | typeof blockTwo,
  slots: Record<string, unknown> = {},
) => ({
  block: { blockId: block.blockId, releaseVersion: block.releaseVersion },
  settings: {},
  themeOverrides: {},
  responsive,
  slots,
});
const sourcePlacement = (
  block: typeof sourceBlockOne | typeof sourceBlockTwo,
  slots: Record<string, unknown> = {},
) => ({
  block: { block_id: block.block_id, release_version: block.release_version },
  settings: {},
  theme_overrides: {},
  responsive: sourceResponsive,
  slots,
});

const canonicalEmptySlot = { placements: {}, order: { desktop: [], tablet: [], phone: [] } };
const sourceEmptySlot = { placements: {}, order: { desktop: [] } };

const shellRootId = id(620);
const shellPrimarySlotId = id(621);
const shellAsideSlotId = id(622);
const pageId = id(623);
const mainPlacementId = id(624);
const nestedPlacementId = id(625);
const asidePlacementId = id(626);

const canonicalShell = {
  shellId: id(630),
  key: "standard_shell",
  name: "Standard shell",
  layout: {
    placements: {
      [shellRootId]: canonicalPlacement(blockOne, {
        primary: canonicalEmptySlot,
        aside: canonicalEmptySlot,
      }),
    },
    order: { desktop: [shellRootId], tablet: [shellRootId], phone: [shellRootId] },
  },
  contentSlots: [
    {
      slotId: shellPrimarySlotId,
      key: "primary",
      label: "Primary",
      required: true,
      allowedChildCategories: ["content"],
      parentPlacementId: shellRootId,
      parentSlotKey: "primary",
    },
    {
      slotId: shellAsideSlotId,
      key: "aside",
      label: "Aside",
      required: false,
      allowedChildCategories: ["content"],
      parentPlacementId: shellRootId,
      parentSlotKey: "aside",
    },
  ],
} as const;

const canonicalPageComposition = {
  shellKind: "application",
  shellId: canonicalShell.shellId,
  content: {
    [shellPrimarySlotId]: {
      placements: {
        [mainPlacementId]: canonicalPlacement(blockTwo, {
          body: {
            placements: {
              [nestedPlacementId]: canonicalPlacement(blockOne),
            },
            order: {
              desktop: [nestedPlacementId],
              tablet: [nestedPlacementId],
              phone: [nestedPlacementId],
            },
          },
        }),
      },
      order: {
        desktop: [mainPlacementId],
        tablet: [mainPlacementId],
        phone: [mainPlacementId],
      },
    },
    [shellAsideSlotId]: {
      placements: { [asidePlacementId]: canonicalPlacement(blockOne) },
      order: {
        desktop: [asidePlacementId],
        tablet: [asidePlacementId],
        phone: [asidePlacementId],
      },
    },
  },
} as const;

const canonicalApplication = {
  name: "Example application",
  description: "A generic V2 page-composition contract fixture.",
  icon: "layout-template",
  moduleBindings: [
    {
      moduleRootId: id(640),
      version: { selection: "exact", version: "1.0.0" },
      resolvedVersion: "1.0.0",
      purpose: "primary",
    },
  ],
  navigation: [],
  platformBlockDependencies: [blockOne, blockTwo],
  shells: [canonicalShell],
  pages: [
    {
      pageId,
      key: "home",
      name: "Home",
      type: "dashboard",
      accessPermissionKey: "example.application.open",
      states: ["normal"],
      composition: canonicalPageComposition,
    },
  ],
  roles: [
    {
      roleId: id(641),
      key: "reader",
      name: "Reader",
      homePageId: pageId,
      permissionKeys: ["example.application.open"],
      permissionSelection: { kind: "exact" },
    },
  ],
  queries: [],
  pipelines: [],
  permissions: [
    {
      permissionId: id(642),
      key: "example.application.open",
      label: "Open application",
      description: "Allows this generic application to be opened.",
      actionKind: "read",
      administrative: false,
    },
  ],
  actions: [],
  rules: [],
  events: [],
  workflows: [],
  connectionBindings: [],
  interfaces: [],
  publicAddresses: [],
  theme: {
    base: {
      kind: "platform_theme",
      catalogueThemeId: id(643),
      releaseVersion: "1.4.0",
      contentFingerprint: fingerprint("e"),
      catalogueFingerprint: fingerprint("f"),
    },
    tokens: {
      brand: { kind: "color_pair", light: "#123456", dark: "#abcdef" },
      density: { kind: "density", value: "comfortable" },
    },
  },
  homePageId: pageId,
} as const;

const sourceShell = {
  id: "standard_shell",
  key: "standard_shell",
  name: "Standard shell",
  layout: {
    placements: {
      shell_root: sourcePlacement(sourceBlockOne, {
        primary: sourceEmptySlot,
        aside: sourceEmptySlot,
      }),
    },
    order: { desktop: ["shell_root"], phone: ["shell_root"] },
  },
  content_slots: [
    {
      id: "shell_primary",
      key: "primary",
      label: "Primary",
      required: true,
      allowed_child_categories: ["content"],
      parent_placement: "shell_root",
      parent_slot: "primary",
    },
    {
      id: "shell_aside",
      key: "aside",
      label: "Aside",
      required: false,
      allowed_child_categories: ["content"],
      parent_placement: "shell_root",
      parent_slot: "aside",
    },
  ],
} as const;

const sourcePageComposition = {
  shell_kind: "application",
  shell: "standard_shell",
  content: {
    shell_primary: {
      placements: {
        main_stack: sourcePlacement(sourceBlockTwo, {
          body: {
            placements: { nested_text: sourcePlacement(sourceBlockOne) },
            order: { desktop: ["nested_text"] },
          },
        }),
      },
      order: { desktop: ["main_stack"], phone: ["main_stack"] },
    },
    shell_aside: {
      placements: { aside_text: sourcePlacement(sourceBlockOne) },
      order: { desktop: ["aside_text"] },
    },
  },
} as const;

const sourceV1 = JSON.parse(
  fs.readFileSync(
    path.resolve(import.meta.dirname, "../../testing/fixtures/applications/crm.json"),
    "utf8",
  ),
) as { body: Record<string, unknown> };

const sourceApplication = (() => {
  const body = structuredClone(sourceV1.body);
  delete body.block_registrations;
  delete body.pages;
  delete body.theme;
  return {
    source_contract_version: "2.0.0",
    kind: "application",
    root_alias: "app_example",
    key: "example.application",
    body: {
      ...body,
      home_page: "home",
      navigation: [],
      roles: (body.roles as Record<string, unknown>[]).map((role) => ({
        ...role,
        home_page: "home",
      })),
      public_addresses: [],
      platform_block_dependencies: [sourceBlockOne, sourceBlockTwo],
      shells: [sourceShell],
      pages: [
        {
          id: "page_home",
          key: "home",
          name: "Home",
          type: "dashboard",
          permission: "application.crm.open",
          states: ["normal"],
          composition: sourcePageComposition,
        },
      ],
      theme: {
        base: {
          kind: "platform_theme",
          catalogue_theme_id: id(643),
          release_version: "1.4.0",
          content_fingerprint: fingerprint("e"),
          catalogue_fingerprint: fingerprint("f"),
        },
        token_overrides: {
          brand: { kind: "color_pair", light: "#123456", dark: "#abcdef" },
        },
      },
    },
  } as const;
})();

const canonicalDraftV2 = {
  envelope: {
    kind: "application",
    rootId: id(650),
    organizationId: id(651),
    key: "example.application",
    draftRevision: 3,
    createdAt: "2026-09-05T00:00:00.000Z",
    createdBy: id(652),
    updatedAt: "2026-09-05T00:01:00.000Z",
    updatedBy: id(653),
  },
  content: canonicalApplication,
} as const;

const resolutionV2 = {
  contractVersion: "2.0.0",
  fingerprint: fingerprint("9"),
  definitions: [
    {
      kind: "application",
      key: "example.application",
      rootId: id(650),
      exactVersion: "1.0.0",
    },
  ],
  identities: [
    {
      definitionKey: "example.application",
      scope: "content",
      kind: "shell",
      componentOwner: "standard_shell",
      alias: "standard_shell",
      identifier: canonicalShell.shellId,
    },
  ],
} as const;

const catalogueSnapshotV2 = {
  contractVersion: "2.0.0",
  fingerprint: fingerprint("8"),
  platformBlocks: {
    compositionPolicy: { maximumDepth: 12, maximumPlacements: 1_000 },
    releases: [
      {
        blockId: blockOne.blockId,
        key: "vortex.block.layout",
        releaseVersion: blockOne.releaseVersion,
        contentFingerprint: blockOne.contentFingerprint,
        catalogueFingerprint: blockOne.catalogueFingerprint,
        name: "Layout",
        icon: "layout-template",
        paletteGroup: "layout",
        rendererKey: "vortex.renderer.layout",
        properties: [],
        slots: [],
        capabilities: {
          responsiveVisibility: true,
          responsiveOrder: true,
          gridWidth: true,
          height: "content_or_bounded",
          accessibleName: "not_applicable",
          publicSurface: "allowed",
        },
      },
    ],
  },
  platformTheme: {
    catalogueThemeId: id(643),
    releaseVersion: "1.4.0",
    contentFingerprint: fingerprint("e"),
    catalogueFingerprint: fingerprint("f"),
    tokens: canonicalApplication.theme.tokens,
  },
} as const;

describe("Application V2 composition contracts", () => {
  type MutableTestSlot = {
    placements: Record<
      string,
      { responsive: { desktop?: unknown; tablet?: unknown; phone?: unknown } }
    >;
    order: { desktop: string[]; tablet: string[]; phone: string[] };
  };

  const parsedCanonical = () => {
    const value = applicationContentV2Schema.parse(canonicalApplication);
    const page = value.pages[0]!;
    if (page.composition.shellKind !== "application") throw new Error("Shell fixture required");
    return {
      value,
      content: page.composition.content as unknown as Record<string, MutableTestSlot>,
    };
  };

  it("parses strict authored and canonical V2 application documents", () => {
    expect(applicationSourceDocumentV2Schema.safeParse(sourceApplication).success).toBe(true);
    expect(applicationContentV2Schema.safeParse(canonicalApplication).success).toBe(true);
  });

  it("exposes V2-only canonical, resolution, compilation request and output envelopes", () => {
    const request = {
      sourceContractVersion: "2.0.0",
      validationContractVersion: "2.0.0",
      source: sourceApplication,
      resolution: resolutionV2,
      catalogueSnapshot: catalogueSnapshotV2,
      draftMetadata: {
        organizationId: id(651),
        draftRevision: 3,
        createdAt: "2026-09-05T00:00:00.000Z",
        createdBy: id(652),
        updatedAt: "2026-09-05T00:01:00.000Z",
        updatedBy: id(653),
      },
    } as const;
    const output = {
      kind: "application",
      validationContractVersion: "2.0.0",
      canonical: canonicalDraftV2,
      artifact: {
        kind: "application",
        definitionKey: "example.application",
        rootId: id(650),
        exactVersion: "1.0.0",
        contentFingerprint: fingerprint("7"),
        resolutionFingerprint: resolutionV2.fingerprint,
      },
      provenance: [],
      dependencyOrder: ["example.application"],
      resolvedDependencies: [],
      resolutionFingerprint: resolutionV2.fingerprint,
    } as const;

    expect(applicationDraftV2Schema.safeParse(canonicalDraftV2).success).toBe(true);
    expect(
      applicationCanonicalDocumentV2Schema.safeParse({
        validationContractVersion: "2.0.0",
        canonical: canonicalDraftV2,
      }).success,
    ).toBe(true);
    expect(definitionResolutionSnapshotV2Schema.safeParse(resolutionV2).success).toBe(true);
    expect(applicationCompilationRequestV2Schema.safeParse(request).success).toBe(true);
    expect(applicationCompilationOutputV2Schema.safeParse(output).success).toBe(true);
  });

  it("keeps every generic V1 decoder closed to V2-only envelopes and identity kinds", () => {
    expect(sourceIdentityKindV2Schema.safeParse("shell").success).toBe(true);
    expect(sourceIdentityKindSchema.safeParse("shell").success).toBe(false);
    expect(sourceIdentityKindSchema.safeParse("shell_content_slot").success).toBe(false);
    expect(sourceIdentityAssignmentV2Schema.safeParse(resolutionV2.identities[0]).success).toBe(
      true,
    );
    expect(sourceIdentityAssignmentSchema.safeParse(resolutionV2.identities[0]).success).toBe(
      false,
    );
    expect(definitionResolutionSnapshotSchema.safeParse(resolutionV2).success).toBe(false);
    expect(applicationDraftSchema.safeParse(canonicalDraftV2).success).toBe(false);
    expect(
      definitionCompilationRequestSchema.safeParse({
        source: sourceApplication,
        resolution: resolutionV2,
        draftMetadata: {
          organizationId: id(651),
          draftRevision: 3,
          createdAt: "2026-09-05T00:00:00.000Z",
          createdBy: id(652),
          updatedAt: "2026-09-05T00:01:00.000Z",
          updatedBy: id(653),
        },
      }).success,
    ).toBe(false);
    expect(
      definitionCompilationOutputSchema.safeParse({
        kind: "application",
        validationContractVersion: "2.0.0",
        canonical: canonicalDraftV2,
        artifact: {
          kind: "application",
          definitionKey: "example.application",
          rootId: id(650),
          exactVersion: "1.0.0",
          contentFingerprint: fingerprint("7"),
          resolutionFingerprint: resolutionV2.fingerprint,
        },
        provenance: [],
        dependencyOrder: ["example.application"],
        resolvedDependencies: [],
        resolutionFingerprint: resolutionV2.fingerprint,
      }).success,
    ).toBe(false);
  });

  it("requires exact trusted V2 request metadata without inferring from source shape", () => {
    const request = {
      sourceContractVersion: "2.0.0",
      validationContractVersion: "2.0.0",
      source: sourceApplication,
      resolution: resolutionV2,
      catalogueSnapshot: catalogueSnapshotV2,
      draftMetadata: {
        organizationId: id(651),
        draftRevision: 3,
        createdAt: "2026-09-05T00:00:00.000Z",
        createdBy: id(652),
        updatedAt: "2026-09-05T00:01:00.000Z",
        updatedBy: id(653),
      },
    } as const;
    expect(
      applicationCompilationRequestV2Schema.safeParse({
        ...request,
        sourceContractVersion: "1.0.0",
      }).success,
    ).toBe(false);
    expect(
      applicationCompilationRequestV2Schema.safeParse({
        ...request,
        validationContractVersion: "1.0.0",
      }).success,
    ).toBe(false);
    expect(
      applicationCompilationRequestV2Schema.safeParse({
        ...request,
        source: { ...sourceApplication, source_contract_version: "1.0.0" },
      }).success,
    ).toBe(false);
  });

  it("does not enable the V2 selector before compiler and runtime support exist", () => {
    expect(() => selectApplicationContractPair("2.0.0", "2.0.0")).toThrowError(
      expect.objectContaining({ code: "APPLICATION_CONTRACT_DECODER_NOT_IMPLEMENTED" }),
    );
  });

  it("requires a complete unique order at each declared breakpoint", () => {
    const fixture = parsedCanonical();
    fixture.content[shellPrimarySlotId]!.order.phone = [];
    expect(applicationContentV2Schema.safeParse(fixture.value).success).toBe(false);
  });

  it("requires canonical responsive values to be materialised at all three breakpoints", () => {
    const fixture = parsedCanonical();
    delete fixture.content[shellPrimarySlotId]!.placements[mainPlacementId]!.responsive.tablet;
    expect(applicationContentV2Schema.safeParse(fixture.value).success).toBe(false);
  });

  it("refuses unknown, missing and duplicate placement ownership", () => {
    const unknownSlot = parsedCanonical();
    Object.assign(unknownSlot.content, { [id(999)]: canonicalEmptySlot });
    expect(applicationContentV2Schema.safeParse(unknownSlot.value).success).toBe(false);

    const missingRequired = parsedCanonical();
    delete (missingRequired.content as Record<string, unknown>)[shellPrimarySlotId];
    expect(applicationContentV2Schema.safeParse(missingRequired.value).success).toBe(false);

    const emptyRequired = parsedCanonical();
    emptyRequired.content[shellPrimarySlotId] = canonicalEmptySlot;
    expect(applicationContentV2Schema.safeParse(emptyRequired.value).success).toBe(false);

    const duplicatePlacement = parsedCanonical();
    Object.assign(duplicatePlacement.content[shellAsideSlotId]!.placements, {
      [mainPlacementId]: canonicalPlacement(blockOne),
    });
    duplicatePlacement.content[shellAsideSlotId]!.order = {
      desktop: [asidePlacementId, mainPlacementId],
      tablet: [asidePlacementId, mainPlacementId],
      phone: [asidePlacementId, mainPlacementId],
    };
    expect(applicationContentV2Schema.safeParse(duplicatePlacement.value).success).toBe(false);
  });

  test.each([
    ["missing", [blockOne]],
    ["extra", [blockOne, blockTwo, { ...blockTwo, blockId: id(612) }]],
    ["reordered", [blockTwo, blockOne]],
  ])("refuses %s platform-block dependency evidence", (_name, dependencies) => {
    const invalid = { ...canonicalApplication, platformBlockDependencies: dependencies };
    expect(applicationContentV2Schema.safeParse(invalid).success).toBe(false);
  });

  it("requires shell content slots to resolve to one declared placement slot", () => {
    const fixture = parsedCanonical();
    fixture.value.shells[0]!.contentSlots[0]!.parentSlotKey = "missing";
    expect(applicationContentV2Schema.safeParse(fixture.value).success).toBe(false);
  });

  it("reserves exposed shell targets exclusively for page-owned content", () => {
    const canonical = parsedCanonical();
    const canonicalRoot = Object.values(canonical.value.shells[0]!.layout.placements)[0]!;
    const canonicalTarget = canonicalRoot.slots.primary!;
    const canonicalFallbackId = id(627);
    Object.assign(canonicalTarget.placements, {
      [canonicalFallbackId]: canonicalPlacement(blockOne),
    });
    canonicalTarget.order = {
      desktop: [canonicalFallbackId],
      tablet: [canonicalFallbackId],
      phone: [canonicalFallbackId],
    };
    expect(applicationContentV2Schema.safeParse(canonical.value).success).toBe(false);

    const source = applicationSourceDocumentV2Schema.parse(sourceApplication);
    const sourceRoot = Object.values(source.body.shells[0]!.layout.placements)[0]!;
    const sourceTarget = sourceRoot.slots.primary!;
    Object.assign(sourceTarget.placements, {
      shell_fallback: sourcePlacement(sourceBlockOne),
    });
    sourceTarget.order = { desktop: ["shell_fallback"] };
    expect(applicationSourceDocumentV2Schema.safeParse(source).success).toBe(false);
  });

  it("rejects authored contract extras rather than treating them as editor-private data", () => {
    const invalid = structuredClone(sourceApplication) as typeof sourceApplication & {
      editor_state?: unknown;
    };
    invalid.editor_state = {};
    expect(applicationSourceDocumentV2Schema.safeParse(invalid).success).toBe(false);
  });
});

describe("V2 property and immutable block catalogue contracts", () => {
  const properties = [
    {
      kind: "text",
      key: "title",
      label: "Title",
      required: true,
      minLength: 1,
      maxLength: 120,
      defaultValue: { kind: "text", value: "Untitled" },
    },
    {
      kind: "number",
      key: "columns",
      label: "Columns",
      required: true,
      integer: true,
      minimum: 1,
      maximum: 12,
      defaultValue: { kind: "number", value: 2 },
    },
    { kind: "boolean", key: "visible", label: "Visible", required: true },
    {
      kind: "choice",
      key: "tone",
      label: "Tone",
      required: false,
      options: [
        { key: "neutral", label: "Neutral" },
        { key: "accent", label: "Accent" },
      ],
    },
    {
      kind: "rich_text",
      key: "body",
      label: "Body",
      required: false,
      allowedElements: ["paragraph", "heading", "emphasis", "link"],
    },
    { kind: "url", key: "address", label: "Address", required: false },
    { kind: "asset_reference", key: "image", label: "Image", required: false },
    { kind: "icon", key: "icon", label: "Icon", required: false },
    {
      kind: "theme_token",
      key: "colour",
      label: "Colour",
      required: false,
      tokenKind: "color_pair",
    },
    { kind: "field_reference", key: "field", label: "Field", required: false },
    {
      kind: "relationship_reference",
      key: "relationship",
      label: "Relationship",
      required: false,
    },
    { kind: "action_reference", key: "action", label: "Action", required: false },
    { kind: "page_reference", key: "page", label: "Page", required: false },
    { kind: "query_reference", key: "query", label: "Query", required: false },
    { kind: "pipeline_reference", key: "pipeline", label: "Pipeline", required: false },
    {
      kind: "record_type_reference",
      key: "record_type",
      label: "Record type",
      required: false,
    },
    { kind: "record_reference", key: "record", label: "Record", required: false },
    {
      kind: "group",
      key: "caption",
      label: "Caption",
      required: false,
      properties: [
        {
          kind: "text",
          key: "text",
          label: "Text",
          required: true,
          minLength: 1,
          maxLength: 80,
        },
      ],
    },
    {
      kind: "list",
      key: "items",
      label: "Items",
      required: false,
      minimumItems: 0,
      maximumItems: 20,
      item: {
        kind: "text",
        key: "item",
        label: "Item",
        required: true,
        minLength: 1,
        maxLength: 80,
      },
    },
  ] as const;

  const registration = {
    blockId: blockOne.blockId,
    key: "platform.layout.stack",
    releaseVersion: blockOne.releaseVersion,
    contentFingerprint: blockOne.contentFingerprint,
    catalogueFingerprint: blockOne.catalogueFingerprint,
    name: "Stack",
    icon: "rows-3",
    paletteGroup: "layout",
    rendererKey: "platform.renderer.stack",
    properties,
    slots: [{ key: "body", label: "Body", required: false, allowedChildCategories: ["content"] }],
    capabilities: {
      responsiveVisibility: true,
      responsiveOrder: true,
      gridWidth: true,
      height: "content_or_bounded",
      accessibleName: "optional",
      publicSurface: "allowed",
    },
  } as const;

  it("accepts every recursive safe property declaration kind", () => {
    for (const property of properties)
      expect(blockPropertySchemaV2Schema.safeParse(property).success, property.kind).toBe(true);
    expect(platformBlockReleaseV2Schema.safeParse(registration).success).toBe(true);
  });

  it("rejects malformed bounds, defaults, duplicate options and unknown declaration keys", () => {
    expect(
      blockPropertySchemaV2Schema.safeParse({
        ...properties[0],
        minLength: 5,
        maxLength: 4,
      }).success,
    ).toBe(false);
    expect(
      blockPropertySchemaV2Schema.safeParse({
        ...properties[1],
        defaultValue: { kind: "number", value: 13 },
      }).success,
    ).toBe(false);
    expect(
      blockPropertySchemaV2Schema.safeParse({
        ...properties[3],
        options: [
          { key: "same", label: "First" },
          { key: "same", label: "Second" },
        ],
      }).success,
    ).toBe(false);
    expect(
      blockPropertySchemaV2Schema.safeParse({ ...properties[2], executable: true }).success,
    ).toBe(false);
    expect(
      blockPropertySchemaV2Schema.safeParse({
        ...properties[12],
        defaultValue: { kind: "page_reference", pageId: id(653) },
      }).success,
    ).toBe(false);
    expect(
      blockPropertySchemaV2Schema.safeParse({
        ...properties[4],
        allowedElements: ["paragraph"],
        defaultValue: {
          kind: "rich_text",
          value: {
            blocks: [
              {
                kind: "paragraph",
                children: [
                  {
                    kind: "link",
                    address: "https://example.test",
                    children: [{ kind: "text", text: "Link" }],
                  },
                ],
              },
            ],
          },
        },
      }).success,
    ).toBe(false);
  });

  test.each([
    { kind: "text", value: "Safe text" },
    { kind: "number", value: 12 },
    { kind: "boolean", value: true },
    { kind: "choice", value: "accent" },
    {
      kind: "rich_text",
      value: { blocks: [{ kind: "paragraph", children: [{ kind: "text", text: "Safe" }] }] },
    },
    { kind: "url", value: "https://example.test/path" },
    { kind: "asset_reference", assetId: id(650) },
    { kind: "icon", iconKey: "circle_check" },
    { kind: "theme_token", tokenKey: "brand" },
    { kind: "field_reference", fieldId: id(651) },
    { kind: "relationship_reference", relationshipId: id(652) },
    { kind: "action_reference", actionKey: "example.action.open" },
    { kind: "page_reference", pageId: id(653) },
    { kind: "query_reference", queryId: id(654) },
    { kind: "pipeline_reference", pipelineId: id(655) },
    {
      kind: "record_type_reference",
      recordType: { state: "resolved", moduleRootId: id(656), recordTypeId: id(657) },
    },
    {
      kind: "record_reference",
      recordType: { state: "resolved", moduleRootId: id(656), recordTypeId: id(657) },
      recordId: id(658),
    },
    { kind: "group", properties: { label: { kind: "text", value: "Safe" } } },
    { kind: "list", items: [{ kind: "text", value: "Safe" }] },
  ])("accepts closed canonical property value %#", (value) => {
    expect(blockPropertyValueV2Schema.safeParse(value).success).toBe(true);
  });

  it("rejects unsafe rich text, non-HTTPS URLs and arbitrary executable/literal objects", () => {
    expect(
      blockPropertyValueV2Schema.safeParse({
        kind: "rich_text",
        value: {
          blocks: [
            {
              kind: "paragraph",
              children: [{ kind: "link", address: "javascript:alert(1)", children: [] }],
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      blockPropertyValueV2Schema.safeParse({ kind: "url", value: "http://example.test" }).success,
    ).toBe(false);
    expect(
      blockPropertyValueV2Schema.safeParse({
        kind: "literal",
        value: { fieldId: id(651), script: "run()" },
      }).success,
    ).toBe(false);
    expect(
      blockPropertyValueV2Schema.safeParse({
        kind: "text",
        value: "Safe",
        fieldId: id(651),
      }).success,
    ).toBe(false);
  });

  it("keeps authored reference positions discriminated from opaque safe scalar values", () => {
    expect(
      sourceBlockPropertyValueV2Schema.safeParse({
        kind: "text",
        value: "field: example.module:record.field",
      }).success,
    ).toBe(true);
    expect(
      sourceBlockPropertyValueV2Schema.safeParse({
        kind: "field_reference",
        field: "example.module:record.field",
      }).success,
    ).toBe(true);
    expect(
      sourceBlockPropertyValueV2Schema.safeParse({
        kind: "text",
        value: { field: "example.module:record.field" },
      }).success,
    ).toBe(false);
  });

  it("keeps block registrations platform-owned, immutable and identity-stable", () => {
    const next = { ...registration, releaseVersion: "1.1.0" };
    const compositionPolicy = { maximumDepth: 20, maximumPlacements: 2_000 };
    expect(
      immutablePlatformBlockCatalogueV2Schema.safeParse({
        compositionPolicy,
        releases: [registration, next],
      }).success,
    ).toBe(true);
    expect(
      immutablePlatformBlockCatalogueV2Schema.safeParse({
        compositionPolicy,
        releases: [registration, { ...next, key: "platform.layout.other" }],
      }).success,
    ).toBe(false);
    expect(
      immutablePlatformBlockCatalogueV2Schema.safeParse({
        compositionPolicy,
        releases: [registration, registration],
      }).success,
    ).toBe(false);
    expect(
      immutablePlatformBlockCatalogueV2Schema.safeParse({
        compositionPolicy: { ...compositionPolicy, maximumDepth: 0 },
        releases: [registration],
      }).success,
    ).toBe(false);
  });

  it("checks dependency fingerprints against the exact immutable catalogue release", () => {
    const catalogue = {
      compositionPolicy: { maximumDepth: 20, maximumPlacements: 2_000 },
      releases: [registration],
    };
    const dependencySchema = platformBlockDependenciesV2SchemaForCatalogue(catalogue);
    expect(dependencySchema.safeParse([blockOne]).success).toBe(true);
    expect(
      dependencySchema.safeParse([{ ...blockOne, contentFingerprint: fingerprint("9") }]).success,
    ).toBe(false);
  });
});
