import fs from "node:fs";
import path from "node:path";
import {
  applicationCompositionCatalogueSnapshotV2Schema,
  applicationSourceDocumentV2Schema,
  type ApplicationCompositionCatalogueSnapshotV2,
  type ApplicationSourceDocumentV2,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import {
  materialiseApplicationCompositionV2,
  type MaterialisedApplicationCompositionV2,
} from "../src/application-v2-composition";
import type { ApplicationCompositionResolutionV2 } from "../src/application-v2-resolution";

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const fingerprint = (letter: string) => `sha256:${letter.repeat(64)}`;
const layout = (visible = true) => ({
  visible,
  width: { kind: "fill" as const },
  height: { kind: "content" as const },
});

const layoutBlock = {
  kind: "platform_block" as const,
  block_id: id(610),
  release_version: "1.0.0",
  content_fingerprint: fingerprint("a"),
  catalogue_fingerprint: fingerprint("b"),
};
const contentBlock = {
  kind: "platform_block" as const,
  block_id: id(611),
  release_version: "2.0.0",
  content_fingerprint: fingerprint("c"),
  catalogue_fingerprint: fingerprint("d"),
};
const themeDependency = {
  kind: "platform_theme" as const,
  catalogue_theme_id: id(620),
  release_version: "1.0.0",
  content_fingerprint: fingerprint("e"),
  catalogue_fingerprint: fingerprint("f"),
};

const emptySlot = () => ({ placements: {}, order: { desktop: [] as string[] } });
const sourcePlacement = (
  block: typeof layoutBlock | typeof contentBlock,
  settings: Record<string, unknown> = {},
  slots: Record<string, unknown> = {},
) => ({
  block: { block_id: block.block_id, release_version: block.release_version },
  settings,
  theme_overrides: {},
  responsive: { desktop: layout() },
  slots,
});

const contentProperties = [
  {
    kind: "group",
    key: "presentation",
    label: "Presentation",
    required: true,
    properties: [
      {
        kind: "text",
        key: "title",
        label: "Title",
        required: true,
        minLength: 1,
        maxLength: 120,
        defaultValue: { kind: "text", value: "Default title" },
      },
    ],
  },
  {
    kind: "text",
    key: "literal",
    label: "Literal",
    required: true,
    minLength: 1,
    maxLength: 200,
  },
  {
    kind: "number",
    key: "columns",
    label: "Columns",
    required: true,
    integer: true,
    minimum: 1,
    maximum: 12,
  },
  { kind: "field_reference", key: "field", label: "Field", required: true },
  {
    kind: "relationship_reference",
    key: "relationship",
    label: "Relationship",
    required: true,
  },
  { kind: "action_reference", key: "action", label: "Action", required: true },
  { kind: "page_reference", key: "page", label: "Page", required: true },
  { kind: "query_reference", key: "query", label: "Query", required: true },
  { kind: "pipeline_reference", key: "pipeline", label: "Pipeline", required: true },
  {
    kind: "record_type_reference",
    key: "record_type",
    label: "Record type",
    required: true,
  },
  { kind: "record_reference", key: "record", label: "Record", required: true },
  {
    kind: "theme_token",
    key: "colour",
    label: "Colour",
    required: true,
    tokenKind: "color_pair",
  },
  {
    kind: "list",
    key: "items",
    label: "Items",
    required: true,
    minimumItems: 1,
    maximumItems: 2,
    item: {
      kind: "text",
      key: "item",
      label: "Item",
      required: true,
      minLength: 1,
      maxLength: 40,
    },
  },
  {
    kind: "group",
    key: "default_group",
    label: "Default group",
    required: false,
    properties: [
      {
        kind: "theme_token",
        key: "colour",
        label: "Colour",
        required: true,
        tokenKind: "color_pair",
      },
    ],
    defaultValue: {
      kind: "group",
      properties: { colour: { kind: "theme_token", tokenKey: "brand" } },
    },
  },
  {
    kind: "list",
    key: "default_list",
    label: "Default list",
    required: false,
    minimumItems: 1,
    maximumItems: 2,
    item: {
      kind: "theme_token",
      key: "colour",
      label: "Colour",
      required: true,
      tokenKind: "color_pair",
    },
    defaultValue: {
      kind: "list",
      items: [{ kind: "theme_token", tokenKey: "brand" }],
    },
  },
] as const;

const contentSettings = {
  presentation: { kind: "group", properties: {} },
  literal: { kind: "text", value: "field: vortex.crm.people:contact.name" },
  columns: { kind: "number", value: 2 },
  field: { kind: "field_reference", field: "vortex.crm.people:contact.name" },
  relationship: {
    kind: "relationship_reference",
    relationship: "vortex.crm.activities:activity.regarding",
  },
  action: { kind: "action_reference", action: "example.application.open" },
  page: { kind: "page_reference", page: "home" },
  query: { kind: "query_reference", query: "people" },
  pipeline: { kind: "pipeline_reference", pipeline: "standard" },
  record_type: { kind: "record_type_reference", record_type: "vortex.crm.people:contact" },
  record: {
    kind: "record_reference",
    record_type: "vortex.crm.people:contact",
    record_id: id(621),
  },
  colour: { kind: "theme_token", token: "brand" },
  items: { kind: "list", items: [{ kind: "text", value: "One" }] },
} as const;

const createSource = (): ApplicationSourceDocumentV2 => {
  const sourceV1 = JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, "../../../testing/fixtures/applications/crm.json"),
      "utf8",
    ),
  ) as { body: Record<string, unknown> };
  const body = structuredClone(sourceV1.body);
  delete body.block_registrations;
  delete body.pages;
  delete body.theme;
  return applicationSourceDocumentV2Schema.parse({
    source_contract_version: "2.0.0",
    root_alias: "app_example",
    key: "example.application",
    kind: "application",
    body: {
      ...body,
      home_page: "home",
      navigation: [],
      roles: (body.roles as Record<string, unknown>[]).map((role) => ({
        ...role,
        home_page: "home",
      })),
      public_addresses: [],
      platform_block_dependencies: [layoutBlock, contentBlock],
      shells: [
        {
          id: "standard_shell",
          key: "standard_shell",
          name: "Standard shell",
          layout: {
            placements: {
              shell_root: sourcePlacement(
                layoutBlock,
                {},
                {
                  primary: emptySlot(),
                  aside: emptySlot(),
                },
              ),
            },
            order: { desktop: ["shell_root"] },
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
        },
      ],
      pages: [
        {
          id: "page_home",
          key: "home",
          name: "Home",
          type: "dashboard",
          permission: "application.crm.open",
          states: ["normal"],
          composition: {
            shell_kind: "application",
            shell: "standard_shell",
            content: {
              shell_primary: {
                placements: {
                  main_content: {
                    ...sourcePlacement(contentBlock, contentSettings, {
                      body: {
                        placements: {
                          nested_content: sourcePlacement(contentBlock, contentSettings),
                        },
                        order: { desktop: ["nested_content"] },
                      },
                    }),
                    responsive: {
                      desktop: {
                        visible: true,
                        width: { kind: "grid", start_column: 2, span: 8 },
                        height: { kind: "content" },
                      },
                      phone: layout(false),
                    },
                    theme_overrides: {
                      brand: { kind: "color_pair", light: "#222222", dark: "#dddddd" },
                    },
                  },
                },
                order: { desktop: ["main_content"] },
              },
            },
          },
        },
      ],
      theme: {
        base: themeDependency,
        token_overrides: {
          brand: { kind: "color_pair", light: "#123456", dark: "#abcdef" },
        },
      },
    },
  });
};

const snapshotEvidence = () => ({
  contractVersion: "2.0.0" as const,
  platformBlocks: {
    compositionPolicy: { maximumDepth: 12, maximumPlacements: 100 },
    releases: [
      {
        blockId: layoutBlock.block_id,
        key: "vortex.block.layout",
        releaseVersion: layoutBlock.release_version,
        contentFingerprint: layoutBlock.content_fingerprint,
        catalogueFingerprint: layoutBlock.catalogue_fingerprint,
        name: "Layout",
        icon: "layout-template",
        paletteGroup: "layout" as const,
        rendererKey: "vortex.renderer.layout",
        properties: [],
        slots: [
          {
            key: "primary",
            label: "Primary",
            required: true,
            allowedChildCategories: ["content" as const],
          },
          {
            key: "aside",
            label: "Aside",
            required: false,
            allowedChildCategories: ["content" as const],
          },
        ],
        capabilities: {
          responsiveVisibility: true,
          responsiveOrder: true,
          gridWidth: true,
          height: "content_or_bounded" as const,
          accessibleName: { requirement: "not_applicable" as const },
          publicSurface: "allowed" as const,
        },
      },
      {
        blockId: contentBlock.block_id,
        key: "vortex.block.content",
        releaseVersion: contentBlock.release_version,
        contentFingerprint: contentBlock.content_fingerprint,
        catalogueFingerprint: contentBlock.catalogue_fingerprint,
        name: "Content",
        icon: "panel-top",
        paletteGroup: "content" as const,
        rendererKey: "vortex.renderer.content",
        properties: structuredClone(contentProperties),
        slots: [
          {
            key: "body",
            label: "Body",
            required: false,
            allowedChildCategories: ["content" as const],
          },
        ],
        capabilities: {
          responsiveVisibility: true,
          responsiveOrder: false,
          gridWidth: true,
          height: "content_or_bounded" as const,
          accessibleName: {
            requirement: "required" as const,
            propertyPath: ["presentation", "title"],
          },
          publicSurface: "allowed" as const,
        },
      },
    ],
  },
  platformTheme: {
    catalogueThemeId: themeDependency.catalogue_theme_id,
    releaseVersion: themeDependency.release_version,
    contentFingerprint: themeDependency.content_fingerprint,
    catalogueFingerprint: themeDependency.catalogue_fingerprint,
    tokens: {
      brand: { kind: "color_pair" as const, light: "#000000", dark: "#ffffff" },
      focus: { kind: "focus" as const, colorToken: "brand", widthRem: 0.125 },
      density: { kind: "density" as const, value: "comfortable" as const },
    },
  },
});

const createSnapshot = (): ApplicationCompositionCatalogueSnapshotV2 => {
  const evidence = snapshotEvidence();
  return applicationCompositionCatalogueSnapshotV2Schema.parse({
    ...evidence,
    fingerprint: fingerprintCanonicalValue(evidence),
  });
};

const createResolution = () => {
  const calls: Array<{ kind: string; value: string }> = [];
  const known = new Map<string, string>([
    ["shell:standard_shell", id(700)],
    ["shell_content_slot:shell_primary", id(701)],
    ["shell_content_slot:shell_aside", id(702)],
    ["block_placement:shell_root", id(703)],
    ["block_placement:main_content", id(704)],
    ["block_placement:nested_content", id(705)],
    ["page:page_home", id(706)],
    ["page:home", id(706)],
    ["query:people", id(707)],
    ["pipeline:standard", id(708)],
  ]);
  let next = 800;
  const dynamic = new Map<string, string>();
  const valueFor = (key: string) => {
    const existing = known.get(key) ?? dynamic.get(key);
    if (existing !== undefined) return existing;
    const created = id(next++);
    dynamic.set(key, created);
    return created;
  };
  const resolution: ApplicationCompositionResolutionV2 = {
    identity: (kind, alias) => {
      calls.push({ kind, value: alias });
      return valueFor(`${kind}:${alias}`);
    },
    field: (reference) => {
      calls.push({ kind: "field", value: reference });
      return id(710);
    },
    relationship: (reference) => {
      calls.push({ kind: "relationship", value: reference });
      return id(711);
    },
    action: (reference) => {
      calls.push({ kind: "action", value: reference });
      return "example.application.resolved";
    },
    recordType: (reference) => {
      calls.push({ kind: "record_type", value: reference });
      return { state: "resolved", moduleRootId: id(712), recordTypeId: id(713) };
    },
  };
  return { calls, resolution };
};

const materialise = (
  source = createSource(),
  snapshot = createSnapshot(),
): {
  result: MaterialisedApplicationCompositionV2;
  calls: Array<{ kind: string; value: string }>;
} => {
  const { calls, resolution } = createResolution();
  return { result: materialiseApplicationCompositionV2(source, snapshot, resolution), calls };
};

const expectRefusal = (operation: () => unknown, ruleCode: string) => {
  expect(operation).toThrowError(expect.objectContaining({ ruleCode }));
};

describe("Application V2 composition materialisation", () => {
  it("materialises exact catalogue evidence, typed references, defaults, theme and inheritance", () => {
    const { result, calls } = materialise();
    const page = result.pages[0]!;
    expect(page.pageId).toBe(id(706));
    expect(page.composition.shellKind).toBe("application");
    if (page.composition.shellKind !== "application" || !("content" in page.composition))
      throw new Error("Application-shell fixture required");
    const primary = page.composition.content[id(701)]!;
    const placement = primary.placements[id(704)]!;
    expect(placement.settings.presentation).toEqual({
      kind: "group",
      properties: { title: { kind: "text", value: "Default title" } },
    });
    expect(placement.settings.field).toEqual({ kind: "field_reference", fieldId: id(710) });
    expect(placement.settings.action).toEqual({
      kind: "action_reference",
      actionKey: "example.application.resolved",
    });
    expect(placement.settings.default_group).toEqual({
      kind: "group",
      properties: { colour: { kind: "theme_token", tokenKey: "brand" } },
    });
    expect(placement.responsive).toEqual({
      desktop: {
        visible: true,
        width: { kind: "grid", startColumn: 2, span: 8 },
        height: { kind: "content" },
      },
      tablet: {
        visible: true,
        width: { kind: "grid", startColumn: 2, span: 8 },
        height: { kind: "content" },
      },
      phone: layout(false),
    });
    expect(placement.themeOverrides.brand).toEqual({
      kind: "color_pair",
      light: "#222222",
      dark: "#dddddd",
    });
    expect(result.theme.tokens.brand).toEqual({
      kind: "color_pair",
      light: "#123456",
      dark: "#abcdef",
    });
    expect(calls.filter((call) => call.kind === "field")).toEqual([
      { kind: "field", value: "vortex.crm.people:contact.name" },
      { kind: "field", value: "vortex.crm.people:contact.name" },
    ]);
    expect(calls.filter((call) => call.kind === "action")).toHaveLength(2);
    expect(calls.some((call) => call.value.startsWith("field:"))).toBe(false);
  });

  it("materialises every guided step through its one selected application shell", () => {
    const base = createSource();
    const guided = applicationSourceDocumentV2Schema.parse({
      ...base,
      body: {
        ...base.body,
        pages: [
          {
            id: "guided_page",
            key: "guided",
            name: "Guided",
            type: "guided_form",
            permission: "application.crm.open",
            states: ["normal"],
            record_type: "vortex.crm.people:contact",
            commit_action: "example.application.open",
            steps: [
              { id: "details_step", name: "Details", summary: false },
              { id: "summary_step", name: "Summary", summary: true },
            ],
            composition: {
              shell_kind: "application",
              shell: "standard_shell",
              step_content: {
                details_step: {
                  shell_primary: {
                    placements: {
                      details_content: sourcePlacement(contentBlock, contentSettings),
                    },
                    order: { desktop: ["details_content"] },
                  },
                },
                summary_step: {
                  shell_primary: {
                    placements: {
                      summary_content: sourcePlacement(contentBlock, contentSettings),
                    },
                    order: { desktop: ["summary_content"] },
                  },
                },
              },
            },
          },
        ],
      },
    });
    const { result } = materialise(guided, createSnapshot());
    const composition = result.pages[0]!.composition;
    expect(composition.shellKind).toBe("application");
    if (!("stepContent" in composition)) throw new Error("Guided fixture required");
    expect(Object.keys(composition.stepContent)).toHaveLength(2);
    for (const content of Object.values(composition.stepContent))
      expect(Object.keys(content)).toEqual([id(701)]);
  });

  it("materialises the default main slot without guessing a page-owned shell", () => {
    const source = createSource();
    const page = source.body.pages[0]!;
    if (page.type === "guided_form") throw new Error("Ordinary page fixture required");
    page.composition = {
      shell_kind: "default",
      main: {
        placements: { default_content: sourcePlacement(contentBlock, contentSettings) },
        order: { desktop: ["default_content"] },
      },
    };
    const { result } = materialise(source, createSnapshot());
    expect(result.pages[0]!.composition.shellKind).toBe("default");
  });

  it("refuses duplicate resolved placement identities across composition trees", () => {
    const { resolution } = createResolution();
    const duplicate: ApplicationCompositionResolutionV2 = {
      ...resolution,
      identity: (kind, alias, scope) =>
        kind === "block_placement" ? id(799) : resolution.identity(kind, alias, scope),
    };
    expectRefusal(
      () => materialiseApplicationCompositionV2(createSource(), createSnapshot(), duplicate),
      "vortex.definition.application_identity_unique",
    );
  });

  it("rejects tampered catalogue evidence and exact dependency disagreement", () => {
    const snapshot = createSnapshot();
    snapshot.platformBlocks.releases[1]!.capabilities.accessibleName = {
      requirement: "not_applicable",
    };
    expectRefusal(
      () => materialise(createSource(), snapshot),
      "vortex.definition.application_dependency_manifest",
    );

    const source = createSource();
    source.body.platform_block_dependencies[1]!.content_fingerprint = fingerprint("9");
    expectRefusal(
      () => materialise(source, createSnapshot()),
      "vortex.definition.application_dependency_manifest",
    );
  });

  it("rejects unknown, missing, wrong-kind and out-of-range settings", () => {
    for (const mutate of [
      (settings: Record<string, unknown>) => (settings.unknown = { kind: "text", value: "x" }),
      (settings: Record<string, unknown>) => delete settings.columns,
      (settings: Record<string, unknown>) => (settings.columns = { kind: "text", value: "two" }),
      (settings: Record<string, unknown>) => (settings.columns = { kind: "number", value: 13 }),
      (settings: Record<string, unknown>) => (settings.items = { kind: "list", items: [] }),
    ]) {
      const source = createSource();
      const page = source.body.pages[0]!;
      if (page.type === "guided_form" || page.composition.shell_kind !== "application")
        throw new Error("Application-shell fixture required");
      const settings = page.composition.content.shell_primary!.placements.main_content!
        .settings as Record<string, unknown>;
      mutate(settings);
      expectRefusal(
        () => materialise(source, createSnapshot()),
        "vortex.definition.application_block_settings",
      );
    }
  });

  it("enforces accessible-name requirements after nested defaults", () => {
    const required = createSource();
    const page = required.body.pages[0]!;
    if (page.type === "guided_form" || page.composition.shell_kind !== "application")
      throw new Error("Application-shell fixture required");
    page.composition.content.shell_primary!.placements.main_content!.settings.presentation = {
      kind: "group",
      properties: { title: { kind: "text", value: " " } },
    };
    expectRefusal(
      () => materialise(required, createSnapshot()),
      "vortex.definition.application_block_settings",
    );

    const optionalSource = createSource();
    const optionalPage = optionalSource.body.pages[0]!;
    if (
      optionalPage.type === "guided_form" ||
      optionalPage.composition.shell_kind !== "application"
    )
      throw new Error("Application-shell fixture required");
    for (const placement of [
      optionalPage.composition.content.shell_primary!.placements.main_content!,
      optionalPage.composition.content.shell_primary!.placements.main_content!.slots.body!
        .placements.nested_content!,
    ])
      delete placement.settings.presentation;
    const evidence = snapshotEvidence();
    const content = evidence.platformBlocks.releases[1]!;
    content.properties = content.properties.map((property) =>
      property.key === "presentation" ? { ...property, required: false } : property,
    ) as typeof content.properties;
    content.capabilities.accessibleName = {
      requirement: "optional",
      propertyPath: ["presentation", "title"],
    };
    const optionalSnapshot = applicationCompositionCatalogueSnapshotV2Schema.parse({
      ...evidence,
      fingerprint: fingerprintCanonicalValue(evidence),
    });
    expect(() => materialise(optionalSource, optionalSnapshot)).not.toThrow();
  });

  it("recursively validates theme-token references inside group and list defaults", () => {
    for (const propertyKey of ["default_group", "default_list"]) {
      const evidence = snapshotEvidence();
      const property = evidence.platformBlocks.releases[1]!.properties.find(
        (entry) => entry.key === propertyKey,
      );
      if (property?.defaultValue?.kind === "group")
        property.defaultValue.properties.colour = {
          kind: "theme_token",
          tokenKey: "missing",
        };
      else if (property?.defaultValue?.kind === "list")
        property.defaultValue.items[0] = { kind: "theme_token", tokenKey: "missing" };
      else throw new Error("Nested default fixture required");
      const snapshot = applicationCompositionCatalogueSnapshotV2Schema.parse({
        ...evidence,
        fingerprint: fingerprintCanonicalValue(evidence),
      });
      expectRefusal(
        () => materialise(createSource(), snapshot),
        "vortex.definition.application_block_settings",
      );
    }
  });

  it("enforces declared child slots, categories and global composition bounds", () => {
    const unknownSlot = createSource();
    const page = unknownSlot.body.pages[0]!;
    if (page.type === "guided_form" || page.composition.shell_kind !== "application")
      throw new Error("Application-shell fixture required");
    page.composition.content.shell_primary!.placements.main_content!.slots.unknown = emptySlot();
    expectRefusal(
      () => materialise(unknownSlot, createSnapshot()),
      "vortex.definition.application_block_references",
    );

    const requiredEvidence = snapshotEvidence();
    requiredEvidence.platformBlocks.releases[1]!.slots[0]!.required = true;
    const requiredSnapshot = applicationCompositionCatalogueSnapshotV2Schema.parse({
      ...requiredEvidence,
      fingerprint: fingerprintCanonicalValue(requiredEvidence),
    });
    expectRefusal(
      () => materialise(createSource(), requiredSnapshot),
      "vortex.definition.application_block_references",
    );

    const categoryEvidence = snapshotEvidence();
    categoryEvidence.platformBlocks.releases[1]!.paletteGroup = "actions";
    const categorySnapshot = applicationCompositionCatalogueSnapshotV2Schema.parse({
      ...categoryEvidence,
      fingerprint: fingerprintCanonicalValue(categoryEvidence),
    });
    expectRefusal(
      () => materialise(createSource(), categorySnapshot),
      "vortex.definition.application_block_references",
    );

    const boundedEvidence = snapshotEvidence();
    boundedEvidence.platformBlocks.compositionPolicy = {
      maximumDepth: 2,
      maximumPlacements: 2,
    };
    const boundedSnapshot = applicationCompositionCatalogueSnapshotV2Schema.parse({
      ...boundedEvidence,
      fingerprint: fingerprintCanonicalValue(boundedEvidence),
    });
    expectRefusal(
      () => materialise(createSource(), boundedSnapshot),
      "vortex.definition.application_layout_complete",
    );
  });

  it("enforces responsive capabilities, responsive sibling order and public safety", () => {
    const capabilityEvidence = snapshotEvidence();
    capabilityEvidence.platformBlocks.releases[1]!.capabilities.responsiveVisibility = false;
    const capabilitySnapshot = applicationCompositionCatalogueSnapshotV2Schema.parse({
      ...capabilityEvidence,
      fingerprint: fingerprintCanonicalValue(capabilityEvidence),
    });
    expectRefusal(
      () => materialise(createSource(), capabilitySnapshot),
      "vortex.definition.application_layout_complete",
    );

    const gridEvidence = snapshotEvidence();
    gridEvidence.platformBlocks.releases[1]!.capabilities.gridWidth = false;
    const gridSnapshot = applicationCompositionCatalogueSnapshotV2Schema.parse({
      ...gridEvidence,
      fingerprint: fingerprintCanonicalValue(gridEvidence),
    });
    expectRefusal(
      () => materialise(createSource(), gridSnapshot),
      "vortex.definition.application_layout_complete",
    );

    const bounded = createSource();
    const boundedPage = bounded.body.pages[0]!;
    if (boundedPage.type === "guided_form" || boundedPage.composition.shell_kind !== "application")
      throw new Error("Application-shell fixture required");
    boundedPage.composition.content.shell_primary!.placements.main_content!.responsive.desktop.height =
      { kind: "bounded", units: 2 };
    const heightEvidence = snapshotEvidence();
    heightEvidence.platformBlocks.releases[1]!.capabilities.height = "content";
    const heightSnapshot = applicationCompositionCatalogueSnapshotV2Schema.parse({
      ...heightEvidence,
      fingerprint: fingerprintCanonicalValue(heightEvidence),
    });
    expectRefusal(
      () => materialise(bounded, heightSnapshot),
      "vortex.definition.application_layout_complete",
    );

    const ordered = createSource();
    const orderedPage = ordered.body.pages[0]!;
    if (orderedPage.type === "guided_form" || orderedPage.composition.shell_kind !== "application")
      throw new Error("Application-shell fixture required");
    const body =
      orderedPage.composition.content.shell_primary!.placements.main_content!.slots.body!;
    body.placements.second_nested = sourcePlacement(contentBlock, contentSettings);
    body.order.desktop = ["nested_content", "second_nested"];
    body.order.tablet = ["second_nested", "nested_content"];
    expectRefusal(
      () => materialise(ordered, createSnapshot()),
      "vortex.definition.application_layout_complete",
    );

    const shellOrdered = createSource();
    const shellPage = shellOrdered.body.pages[0]!;
    if (shellPage.type === "guided_form" || shellPage.composition.shell_kind !== "application")
      throw new Error("Application-shell fixture required");
    const shellContent = shellPage.composition.content.shell_primary!;
    shellContent.placements.second_content = sourcePlacement(contentBlock, contentSettings);
    shellContent.order.desktop = ["main_content", "second_content"];
    shellContent.order.tablet = ["second_content", "main_content"];
    const shellCapabilityEvidence = snapshotEvidence();
    shellCapabilityEvidence.platformBlocks.releases[0]!.capabilities.responsiveOrder = false;
    const shellCapabilitySnapshot = applicationCompositionCatalogueSnapshotV2Schema.parse({
      ...shellCapabilityEvidence,
      fingerprint: fingerprintCanonicalValue(shellCapabilityEvidence),
    });
    expectRefusal(
      () => materialise(shellOrdered, shellCapabilitySnapshot),
      "vortex.definition.application_layout_complete",
    );

    const publicSource = createSource();
    const current = publicSource.body.pages[0]!;
    publicSource.body.pages[0] = applicationSourceDocumentV2Schema.parse({
      ...publicSource,
      body: {
        ...publicSource.body,
        pages: [
          {
            id: current.id,
            key: current.key,
            name: current.name,
            type: "public",
            permission: "application.crm.open",
            states: current.states,
            public_fields: [],
            rate_limit_per_minute: 60,
            composition: current.composition,
          },
        ],
      },
    }).body.pages[0]!;
    const publicEvidence = snapshotEvidence();
    publicEvidence.platformBlocks.releases[1]!.capabilities.publicSurface = "refused";
    const publicSnapshot = applicationCompositionCatalogueSnapshotV2Schema.parse({
      ...publicEvidence,
      fingerprint: fingerprintCanonicalValue(publicEvidence),
    });
    expectRefusal(
      () => materialise(publicSource, publicSnapshot),
      "vortex.definition.application_public_surface",
    );

    const unsafeShellEvidence = snapshotEvidence();
    unsafeShellEvidence.platformBlocks.releases[0]!.capabilities.publicSurface = "refused";
    const unsafeShellSnapshot = applicationCompositionCatalogueSnapshotV2Schema.parse({
      ...unsafeShellEvidence,
      fingerprint: fingerprintCanonicalValue(unsafeShellEvidence),
    });
    expectRefusal(
      () => materialise(publicSource, unsafeShellSnapshot),
      "vortex.definition.application_public_surface",
    );
  });

  it("enforces theme token kinds and internal colour-token references", () => {
    const source = createSource();
    source.body.theme.token_overrides.brand = { kind: "spacing", rem: 1 };
    expectRefusal(
      () => materialise(source, createSnapshot()),
      "vortex.definition.application_block_settings",
    );

    const evidence = snapshotEvidence();
    evidence.platformTheme.tokens.focus = {
      kind: "focus",
      colorToken: "missing",
      widthRem: 0.125,
    };
    const snapshot = applicationCompositionCatalogueSnapshotV2Schema.parse({
      ...evidence,
      fingerprint: fingerprintCanonicalValue(evidence),
    });
    expectRefusal(
      () => materialise(createSource(), snapshot),
      "vortex.definition.application_block_settings",
    );

    const placementOverride = createSource();
    const page = placementOverride.body.pages[0]!;
    if (page.type === "guided_form" || page.composition.shell_kind !== "application")
      throw new Error("Application-shell fixture required");
    page.composition.content.shell_primary!.placements.main_content!.theme_overrides.focus = {
      kind: "focus",
      color_token: "missing",
      width_rem: 0.125,
    };
    expectRefusal(
      () => materialise(placementOverride, createSnapshot()),
      "vortex.definition.application_block_settings",
    );
  });
});
