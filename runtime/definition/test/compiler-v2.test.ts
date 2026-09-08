import fs from "node:fs";
import path from "node:path";
import {
  applicationCompositionCatalogueSnapshotV2Schema,
  applicationSourceDocumentV2Schema,
  connectionTypeSourceDocumentSchema,
  definitionResolutionSnapshotSchema,
  definitionSourceDocumentSchema,
  moduleSourceDocumentSchema,
  publishedApplicationDefinitionV1Schema,
  publishedApplicationDefinitionV2Schema,
  publishedModuleDefinitionSchema,
  sessionContextSchema,
  selectApplicationContractPair,
  selectApplicationValidationContract,
  storedDefinitionDraftSchema,
  type ApplicationDraftV2,
  type ApplicationSourceDocumentV2,
  type BlockPlacementV2Contract,
  type PageCompositionV2,
  type PublishDefinitionResult,
} from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import { describe, expect, it } from "vitest";
import { compileDefinition } from "../src/compiler";
import { createDefinitionStore } from "../src/definition-store";
import { createDefinitionConsumerReadService } from "../src/definition-consumer-read";
import {
  createDefinitionHistoryService,
  type DefinitionHistoryRepository,
} from "../src/definition-history";
import { createImmutableDefinitionPublicationCatalogue } from "../src/definition-publication-catalogue";
import {
  createDefinitionPublicationService,
  type DefinitionPublicationCandidate,
  type DefinitionPublicationCatalogue,
  type DefinitionPublicationReader,
  type DefinitionPublicationRepository,
  type DefinitionPublicationTransaction,
  type DefinitionReleaseAppend,
  type ResolvableModuleRelease,
} from "../src/definition-publication";
import {
  compareDefinitionVersionImpact,
  confirmDefinitionVersionImpact,
} from "../src/version-impact";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import { DefinitionVersionImpactError } from "../src/version-impact-error";
import { extractApplicationSourceIdentityRequirementsV2 } from "../src/source-identities";
import { createApplicationResolutionSnapshotV2 } from "../src/application-v2-resolution";
import { validateDefinitionSet, validateDefinitionSource } from "../src/validation";

const fixtureRoot = path.resolve(import.meta.dirname, "../../../testing/fixtures");
const baseSource = JSON.parse(
  fs.readFileSync(path.join(fixtureRoot, "applications/crm.json"), "utf8"),
) as { root_alias: string; key: string; body: Record<string, unknown> };
const baseResolution = definitionResolutionSnapshotSchema.parse(
  JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "definition-resolution-snapshot.json"), "utf8"),
  ),
);
const id = (suffix: number) => "00000000-0000-4000-8000-" + String(suffix).padStart(12, "0");
const fingerprint = (letter: string) => "sha256:" + letter.repeat(64);
const layout = (visible = true, startColumn?: number) => ({
  visible,
  width:
    startColumn === undefined
      ? ({ kind: "fill" } as const)
      : ({ kind: "grid", start_column: startColumn, span: 6 } as const),
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
const sourceTypography = {
  kind: "typography" as const,
  family: "body",
  size_rem: 1,
  line_height: 1.5,
  weight: 400,
};
const emptySlot = () => ({ placements: {}, order: { desktop: [] as string[] } });
const placement = (
  block: typeof layoutBlock | typeof contentBlock,
  options: {
    settings?: Record<string, unknown>;
    slots?: Record<string, unknown>;
    viewPermission?: string;
    usePermission?: string;
    tablet?: ReturnType<typeof layout>;
    themeOverrides?: Record<string, unknown>;
  } = {},
) => ({
  block: { block_id: block.block_id, release_version: block.release_version },
  ...(options.viewPermission ? { view_permission: options.viewPermission } : {}),
  ...(options.usePermission ? { use_permission: options.usePermission } : {}),
  settings: options.settings ?? {},
  theme_overrides: options.themeOverrides ?? {},
  responsive: {
    desktop: layout(),
    ...(options.tablet ? { tablet: options.tablet } : {}),
  },
  slots: options.slots ?? {},
});
const slot = (alias: string, value: ReturnType<typeof placement>) => ({
  placements: { [alias]: value },
  order: { desktop: [alias] },
});

const createSource = (): ApplicationSourceDocumentV2 => {
  type LegacyStep = Record<string, unknown> & { id: string };
  type LegacyPage = Record<string, unknown> & { type: string; steps?: LegacyStep[] };
  type MutableBody = Record<string, unknown> & { pages: LegacyPage[] };
  const body = structuredClone(baseSource.body) as unknown as MutableBody;
  const legacyPages = body.pages;
  delete body.pages;
  delete body.block_registrations;
  delete body.theme;
  const pages = legacyPages.map((legacy, pageIndex) => {
    const page = { ...legacy };
    const steps = page.steps;
    delete page.layout;
    delete page.blocks;
    delete page.steps;
    if (legacy.type === "guided_form") {
      const compiledSteps = (steps as LegacyStep[]).map((legacyStep) => {
        const step = { ...legacyStep };
        delete step.blocks;
        return step;
      });
      return {
        ...page,
        steps: compiledSteps,
        composition: {
          shell_kind: "application",
          shell: "standard_shell",
          step_content: Object.fromEntries(
            compiledSteps.map((step, stepIndex) => [
              step.id,
              {
                shell_primary: slot(
                  "guided_" + stepIndex,
                  placement(contentBlock, {
                    viewPermission: "application.crm.open",
                    tablet: layout(stepIndex % 2 === 0, 2),
                  }),
                ),
              },
            ]),
          ),
        },
      };
    }
    if (pageIndex === 0)
      return {
        ...page,
        composition: {
          shell_kind: "application",
          shell: "standard_shell",
          content: {
            shell_primary: slot(
              "dashboard_content",
              placement(contentBlock, {
                settings: {
                  field: {
                    kind: "field_reference",
                    field: "vortex.crm.people:contact.full_name",
                  },
                  opaque_group: {
                    kind: "group",
                    properties: {
                      snake_case: { kind: "text", value: "Preserve this key" },
                      field: { kind: "text", value: "Field is a literal property key" },
                      action: {
                        kind: "group",
                        properties: {
                          field: { kind: "text", value: "Nested field is also literal" },
                        },
                      },
                    },
                  },
                },
                slots: {
                  body: slot(
                    "nested_content",
                    placement(contentBlock, {
                      viewPermission: "application.crm.open",
                      usePermission: "application.crm.open",
                      tablet: layout(false, 3),
                      themeOverrides: {
                        kind: { ...sourceTypography, size_rem: 1.25 },
                      },
                    }),
                  ),
                },
              }),
            ),
          },
        },
      };
    return {
      ...page,
      composition: {
        shell_kind: "default",
        main: slot("page_content_" + pageIndex, placement(contentBlock)),
      },
    };
  });
  return applicationSourceDocumentV2Schema.parse({
    source_contract_version: "2.0.0",
    root_alias: baseSource.root_alias,
    key: baseSource.key,
    kind: "application",
    body: {
      ...body,
      platform_block_dependencies: [layoutBlock, contentBlock],
      shells: [
        {
          id: "standard_shell",
          key: "standard_shell",
          name: "Standard shell",
          layout: {
            placements: {
              shell_root: placement(layoutBlock, {
                slots: { primary: emptySlot(), aside: emptySlot() },
              }),
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
      pages,
      theme: {
        base: themeDependency,
        token_overrides: {
          brand: { kind: "color_pair", light: "#123456", dark: "#abcdef" },
          kind: sourceTypography,
        },
      },
    },
  });
};

const createCatalogueSnapshot = () => {
  const evidence = {
    contractVersion: "2.0.0" as const,
    platformBlocks: {
      compositionPolicy: { maximumDepth: 20, maximumPlacements: 200 },
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
            accessibleName: "not_applicable" as const,
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
          properties: [
            {
              kind: "text" as const,
              key: "title",
              label: "Title",
              required: true,
              minLength: 1,
              maxLength: 120,
              defaultValue: { kind: "text" as const, value: "Default title" },
            },
            {
              kind: "field_reference" as const,
              key: "field",
              label: "Field",
              required: false,
            },
            {
              kind: "group" as const,
              key: "opaque_group",
              label: "Opaque group",
              required: false,
              properties: [
                {
                  kind: "text" as const,
                  key: "snake_case",
                  label: "Snake case",
                  required: true,
                  minLength: 1,
                  maxLength: 120,
                },
                {
                  kind: "text" as const,
                  key: "field",
                  label: "Literal field",
                  required: true,
                  minLength: 1,
                  maxLength: 120,
                },
                {
                  kind: "group" as const,
                  key: "action",
                  label: "Literal action",
                  required: true,
                  properties: [
                    {
                      kind: "text" as const,
                      key: "field",
                      label: "Nested literal field",
                      required: true,
                      minLength: 1,
                      maxLength: 120,
                    },
                  ],
                },
              ],
            },
          ],
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
            responsiveOrder: true,
            gridWidth: true,
            height: "content_or_bounded" as const,
            accessibleName: "not_applicable" as const,
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
        kind: {
          kind: "typography" as const,
          family: "body",
          sizeRem: 0.875,
          lineHeight: 1.25,
          weight: 400,
        },
      },
    },
  };
  return applicationCompositionCatalogueSnapshotV2Schema.parse({
    ...evidence,
    fingerprint: fingerprintCanonicalValue(evidence),
  });
};

const createResolution = (source: ApplicationSourceDocumentV2) => {
  const requirements = extractApplicationSourceIdentityRequirementsV2(source);
  const external = baseResolution.identities.filter(
    (identity) => identity.definitionKey !== source.key,
  );
  const existing = baseResolution.identities.filter(
    (identity) => identity.definitionKey === source.key,
  );
  let next = 900;
  const generated = new Map<string, string>();
  const own = requirements.flatMap((requirement) => {
    const group = requirement.scope + ":" + requirement.kind + ":" + requirement.componentOwner;
    const identifier =
      existing.find(
        (identity) =>
          identity.kind === requirement.kind &&
          identity.scope === requirement.scope &&
          requirement.aliases.includes(identity.alias),
      )?.identifier ??
      generated.get(group) ??
      id(next++);
    generated.set(group, identifier);
    return requirement.aliases.map((alias) => ({
      definitionKey: source.key,
      scope: requirement.scope,
      kind: requirement.kind,
      componentOwner: requirement.componentOwner,
      alias,
      identifier,
    }));
  });
  return createApplicationResolutionSnapshotV2({
    definitions: baseResolution.definitions,
    identities: [...external, ...own],
  });
};

const metadata = {
  organizationId: "10000000-0000-4000-a000-000000000001",
  draftRevision: 1,
  createdAt: "2026-09-01T00:00:00+00:00",
  createdBy: "10000000-0000-4000-a000-000000000002",
  updatedAt: "2026-09-01T00:00:00+00:00",
  updatedBy: "10000000-0000-4000-a000-000000000002",
} as const;
const requestFor = (source = createSource()) => ({
  sourceContractVersion: "2.0.0" as const,
  validationContractVersion: "2.0.0" as const,
  source,
  resolution: createResolution(source),
  catalogueSnapshot: createCatalogueSnapshot(),
  draftMetadata: metadata,
});
const leaves = (value: unknown, currentPath: (string | number)[] = []): string[] =>
  Array.isArray(value)
    ? value.flatMap((entry, index) => leaves(entry, [...currentPath, index]))
    : value !== null && typeof value === "object"
      ? Object.entries(value).flatMap(([key, entry]) => leaves(entry, [...currentPath, key]))
      : [JSON.stringify(currentPath)];

describe("native Application V2 compiler", () => {
  it("compiles complete shell, nested and guided-step composition deterministically", () => {
    const request = requestFor();
    const output = compileDefinition(request);
    const repeated = compileDefinition({
      ...request,
      resolution: createApplicationResolutionSnapshotV2({
        definitions: [...request.resolution.definitions].reverse(),
        identities: [...request.resolution.identities].reverse(),
      }),
    });
    expect(output).toEqual(repeated);
    expect(output.validationContractVersion).toBe("2.0.0");
    expect(output.canonical.content.shells).toHaveLength(1);
    const guided = output.canonical.content.pages.find((page) => page.type === "guided_form");
    expect(guided?.composition.shellKind).toBe("application");
    if (!guided || guided.composition.shellKind !== "application")
      throw new Error("Guided application-shell page required");
    expect(Object.keys(guided.composition.stepContent)).toHaveLength(guided.steps.length);
    const dashboard = output.canonical.content.pages[0]!;
    if (dashboard.composition.shellKind !== "application" || !("content" in dashboard.composition))
      throw new Error("Dashboard application-shell page required");
    const primary = Object.values(dashboard.composition.content)[0]!;
    const top = Object.values(primary.placements)[0]!;
    const nested = Object.values(top.slots.body!.placements)[0]!;
    expect(top.settings.title).toEqual({ kind: "text", value: "Default title" });
    expect(top.settings.field).toEqual(
      expect.objectContaining({ kind: "field_reference", fieldId: expect.any(String) }),
    );
    expect(top.settings.opaque_group).toEqual({
      kind: "group",
      properties: {
        snake_case: { kind: "text", value: "Preserve this key" },
        field: { kind: "text", value: "Field is a literal property key" },
        action: {
          kind: "group",
          properties: {
            field: { kind: "text", value: "Nested field is also literal" },
          },
        },
      },
    });
    expect(nested).toMatchObject({
      viewPermissionKey: "application.crm.open",
      usePermissionKey: "application.crm.open",
    });
    expect(nested.themeOverrides.kind).toEqual({
      kind: "typography",
      family: "body",
      sizeRem: 1.25,
      lineHeight: 1.5,
      weight: 400,
    });
    expect(output.canonical.content.theme.tokens.brand).toEqual({
      kind: "color_pair",
      light: "#123456",
      dark: "#abcdef",
    });
    expect(output.canonical.content.theme.tokens.kind).toEqual({
      kind: "typography",
      family: "body",
      sizeRem: 1,
      lineHeight: 1.5,
      weight: 400,
    });

    const sourcePaths = new Set(
      output.provenance.flatMap((entry) =>
        entry.sourcePath ? [JSON.stringify(entry.sourcePath)] : [],
      ),
    );
    const canonicalPaths = new Set(
      output.provenance.map((entry) => JSON.stringify(entry.canonicalPath)),
    );
    for (const sourcePath of leaves(request.source))
      if (sourcePath !== '["source_contract_version"]' && sourcePath !== '["kind"]')
        expect(sourcePaths.has(sourcePath), sourcePath).toBe(true);
    for (const canonicalPath of leaves(output.canonical))
      expect(canonicalPaths.has(canonicalPath), canonicalPath).toBe(true);

    const permission = output.provenance.find(
      (entry) => entry.sourcePath?.at(-1) === "view_permission",
    );
    expect(permission).toMatchObject({ origin: "resolved" });
    expect(permission?.canonicalPath.at(-1)).toBe("viewPermissionKey");
    const commitAction = output.provenance.find(
      (entry) => entry.sourcePath?.at(-1) === "commit_action",
    );
    expect(commitAction).toMatchObject({ origin: "resolved" });

    const firstTabletLayout = output.provenance.find(
      (entry) => entry.sourcePath?.includes("tablet") && entry.sourcePath.at(-1) === "start_column",
    );
    expect(firstTabletLayout).toBeDefined();
    const tabletLayout = output.provenance.filter(
      (entry) => JSON.stringify(entry.sourcePath) === JSON.stringify(firstTabletLayout!.sourcePath),
    );
    expect(tabletLayout.map((entry) => entry.canonicalPath.at(-3))).toEqual(["tablet", "phone"]);
    const responsiveRoot = tabletLayout[0]!.canonicalPath.slice(0, -3);
    expect(
      output.provenance.some(
        (entry) =>
          responsiveRoot.every((segment, index) => entry.canonicalPath[index] === segment) &&
          entry.sourcePath?.includes("desktop") &&
          entry.canonicalPath.includes("phone"),
      ),
    ).toBe(false);

    const defaultTitle = output.provenance.find(
      (entry) =>
        entry.canonicalPath.includes("settings") &&
        entry.canonicalPath.at(-2) === "title" &&
        entry.canonicalPath.at(-1) === "value",
    );
    expect(defaultTitle?.sourcePath).toEqual([
      "body",
      "platform_block_dependencies",
      1,
      "content_fingerprint",
    ]);
  });

  it("rejects mismatched evidence, unsupported pairs and foreign placement permissions", () => {
    const request = requestFor();
    expect(() =>
      compileDefinition({ ...request, validationContractVersion: "1.0.0" }),
    ).toThrowError("vortex.definition.invalid_compilation_request");

    const catalogueSnapshot = structuredClone(request.catalogueSnapshot);
    catalogueSnapshot.platformTheme.tokens.brand = {
      kind: "color_pair",
      light: "#111111",
      dark: "#ffffff",
    };
    expect(() => compileDefinition({ ...request, catalogueSnapshot })).toThrowError(
      "vortex.definition.application_dependency_manifest",
    );

    const source = structuredClone(request.source);
    const dashboard = source.body.pages[0]!;
    if (dashboard.type === "guided_form" || dashboard.composition.shell_kind !== "application")
      throw new Error("Dashboard application-shell source required");
    const top = Object.values(dashboard.composition.content.shell_primary!.placements)[0]!;
    top.view_permission = "foreign.application.view";
    const sourceResolution = createResolution(source);
    const foreignResolution = createApplicationResolutionSnapshotV2({
      definitions: [
        ...sourceResolution.definitions,
        {
          kind: "application",
          key: "foreign.application",
          rootId: id(990),
          exactVersion: "1.0.0",
        },
      ],
      identities: [
        ...sourceResolution.identities,
        {
          definitionKey: "foreign.application",
          scope: "content",
          kind: "permission",
          componentOwner: "foreign_view",
          alias: "foreign.application.view",
          identifier: id(991),
        },
      ],
    });
    expect(() =>
      compileDefinition({ ...request, source, resolution: foreignResolution }),
    ).toThrowError("vortex.definition.missing_identity");
  });

  it("rejects duplicate definition and identity lookup evidence", () => {
    const request = requestFor();
    expect(() =>
      createApplicationResolutionSnapshotV2({
        definitions: [...request.resolution.definitions, request.resolution.definitions[0]!],
        identities: request.resolution.identities,
      }),
    ).toThrowError("duplicate definition selections");
    expect(() =>
      createApplicationResolutionSnapshotV2({
        definitions: request.resolution.definitions,
        identities: [...request.resolution.identities, request.resolution.identities[0]!],
      }),
    ).toThrowError("duplicate identity lookup keys");
  });

  it("enforces the catalogue-declared accessible-name property path", () => {
    const request = requestFor();
    const catalogueWith = (
      configure: (
        release: (typeof request.catalogueSnapshot.platformBlocks.releases)[number],
      ) => void,
    ) => {
      const snapshot = structuredClone(request.catalogueSnapshot);
      const release = snapshot.platformBlocks.releases[1]!;
      configure(release);
      snapshot.fingerprint = fingerprintCanonicalValue({
        contractVersion: snapshot.contractVersion,
        platformBlocks: snapshot.platformBlocks,
        platformTheme: snapshot.platformTheme,
      });
      return snapshot;
    };
    const textProperty = (
      release: (typeof request.catalogueSnapshot.platformBlocks.releases)[number],
      key: string,
    ) => {
      const property = release.properties.find((candidate) => candidate.key === key);
      if (property?.kind !== "text") throw new Error("Text property required");
      return property;
    };

    const requiredDefault = catalogueWith((release) => {
      release.capabilities = {
        ...release.capabilities,
        accessibleName: "required",
        accessibleNamePropertyPath: ["title"],
      };
    });
    expect(() =>
      compileDefinition({ ...request, catalogueSnapshot: requiredDefault }),
    ).not.toThrow();

    const explicitSource = structuredClone(request.source);
    const dashboard = explicitSource.body.pages[0]!;
    if (dashboard.type === "guided_form" || dashboard.composition.shell_kind !== "application")
      throw new Error("Dashboard application-shell source required");
    const top = Object.values(dashboard.composition.content.shell_primary!.placements)[0]!;
    top.settings.title = { kind: "text", value: "Explicit accessible name" };
    expect(() =>
      compileDefinition({ ...request, source: explicitSource, catalogueSnapshot: requiredDefault }),
    ).not.toThrow();

    const requiredMissing = catalogueWith((release) => {
      const title = textProperty(release, "title");
      title.required = false;
      delete title.defaultValue;
      release.capabilities = {
        ...release.capabilities,
        accessibleName: "required",
        accessibleNamePropertyPath: ["title"],
      };
    });
    expect(() =>
      compileDefinition({ ...request, catalogueSnapshot: requiredMissing }),
    ).toThrowError("vortex.definition.application_block_settings");

    const requiredBlank = catalogueWith((release) => {
      const title = textProperty(release, "title");
      title.minLength = 0;
      title.defaultValue = { kind: "text", value: " " };
      release.capabilities = {
        ...release.capabilities,
        accessibleName: "required",
        accessibleNamePropertyPath: ["title"],
      };
    });
    expect(() => compileDefinition({ ...request, catalogueSnapshot: requiredBlank })).toThrowError(
      "vortex.definition.application_block_settings",
    );

    const nestedGroup = catalogueWith((release) => {
      const group = release.properties.find((property) => property.key === "opaque_group");
      if (group?.kind !== "group") throw new Error("Accessible-name group required");
      group.defaultValue = {
        kind: "group",
        properties: {
          snake_case: { kind: "text", value: "Default snake case" },
          field: { kind: "text", value: "Default field" },
          action: {
            kind: "group",
            properties: {
              field: { kind: "text", value: "Default nested accessible name" },
            },
          },
        },
      };
      release.capabilities = {
        ...release.capabilities,
        accessibleName: "required",
        accessibleNamePropertyPath: ["opaque_group", "action", "field"],
      };
    });
    expect(() => compileDefinition({ ...request, catalogueSnapshot: nestedGroup })).not.toThrow();

    const optionalMissing = catalogueWith((release) => {
      const title = textProperty(release, "title");
      title.required = false;
      delete title.defaultValue;
      release.capabilities = {
        ...release.capabilities,
        accessibleName: "optional",
        accessibleNamePropertyPath: ["title"],
      };
    });
    expect(() =>
      compileDefinition({ ...request, catalogueSnapshot: optionalMissing }),
    ).not.toThrow();
  });
});

type PlacementSlotV2 = Extract<PageCompositionV2, { shellKind: "default" }>["main"];

const compiledV2Draft = (): ApplicationDraftV2 => compileDefinition(requestFor()).canonical;

const publishedV2 = (draft: ApplicationDraftV2, version = "1.0.0", revision = 1) => ({
  publication: {
    kind: "application" as const,
    rootId: draft.envelope.rootId,
    revision,
    releaseVersion: version,
    contentFingerprint: fingerprintCanonicalValue(draft.content),
    publishedAt: metadata.createdAt,
    publishedBy: metadata.createdBy,
    validationContractVersion: "2.0.0" as const,
  },
  content: structuredClone(draft.content),
  dependencyManifest: [],
  releaseNote: "Published native V2 application.",
});

const v2RequestAfter = (draft: ApplicationDraftV2) => {
  const candidate = structuredClone(draft);
  candidate.envelope.draftRevision = 2;
  candidate.envelope.publishedRevision = 1;
  return {
    kind: "application" as const,
    validationContractVersion: "2.0.0" as const,
    history: [publishedV2(draft)],
    candidate,
  };
};

const expectVersionImpactCode = (operation: () => unknown, code: string): void => {
  try {
    operation();
    throw new Error("Expected version-impact refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(DefinitionVersionImpactError);
    expect((error as DefinitionVersionImpactError).code).toBe(code);
  }
};

const applicationDashboardV2 = (draft: ApplicationDraftV2) => {
  const page = draft.content.pages.find(
    (candidate) =>
      candidate.type === "dashboard" && candidate.composition.shellKind === "application",
  );
  if (page === undefined || page.composition.shellKind !== "application")
    throw new Error("Application-shell dashboard required");
  return page;
};

type PublicPageV2 = Extract<ApplicationDraftV2["content"]["pages"][number], { type: "public" }>;

const publicPageV2 = (draft: ApplicationDraftV2, pageId = id(989)): PublicPageV2 => {
  const dashboard = applicationDashboardV2(draft);
  return {
    ...structuredClone(dashboard),
    pageId,
    key: "public_view",
    name: "Public view",
    type: "public",
    composition: { shellKind: "default", main: canonicalEmptySlotV2() },
    publicFieldIds: [],
    rateLimitPerMinute: 60,
  };
};

const dashboardPrimaryV2 = (draft: ApplicationDraftV2): PlacementSlotV2 => {
  const page = applicationDashboardV2(draft);
  const result = Object.values(page.composition.content)[0];
  if (result === undefined) throw new Error("Dashboard content slot required");
  return result;
};

const presentationPlacementV2 = (draft: ApplicationDraftV2): BlockPlacementV2Contract => {
  const listSlot = rootSlotsForPageV2(draft, "list")[0];
  const placementId = listSlot?.order.desktop[0];
  const placement = placementId === undefined ? undefined : listSlot.placements[placementId];
  if (placement === undefined) throw new Error("Compiled content placement required");
  const result = structuredClone(placement);
  delete result.viewPermissionKey;
  delete result.usePermissionKey;
  delete result.settings.field;
  delete result.settings.opaque_group;
  return result;
};

const addPlacementV2 = (
  slotValue: PlacementSlotV2,
  placementId: string,
  placementValue: BlockPlacementV2Contract,
): void => {
  slotValue.placements[placementId] = placementValue;
  for (const breakpoint of ["desktop", "tablet", "phone"] as const)
    slotValue.order[breakpoint].push(placementId);
};

const removePlacementV2 = (slotValue: PlacementSlotV2, placementId: string): void => {
  delete slotValue.placements[placementId];
  for (const breakpoint of ["desktop", "tablet", "phone"] as const)
    slotValue.order[breakpoint] = slotValue.order[breakpoint].filter(
      (candidate) => candidate !== placementId,
    );
};

const reidentifyPlacementSlotV2 = (
  slotValue: PlacementSlotV2,
  nextId: { value: number },
): PlacementSlotV2 => {
  const identities = new Map(
    Object.keys(slotValue.placements).map((placementId) => [placementId, id(nextId.value++)]),
  );
  return {
    placements: Object.fromEntries(
      Object.entries(slotValue.placements).map(([placementId, placement]) => [
        identities.get(placementId)!,
        {
          ...structuredClone(placement),
          slots: Object.fromEntries(
            Object.entries(placement.slots).map(([slotKey, childSlot]) => [
              slotKey,
              reidentifyPlacementSlotV2(childSlot, nextId),
            ]),
          ),
        },
      ]),
    ),
    order: {
      desktop: slotValue.order.desktop.map((placementId) => identities.get(placementId)!),
      tablet: slotValue.order.tablet.map((placementId) => identities.get(placementId)!),
      phone: slotValue.order.phone.map((placementId) => identities.get(placementId)!),
    },
  };
};

const reidentifyPagePlacementsV2 = (
  page: ApplicationDraftV2["content"]["pages"][number],
  firstId: number,
): void => {
  const nextId = { value: firstId };
  const composition = page.composition;
  if ("stepContent" in composition) {
    composition.stepContent = Object.fromEntries(
      Object.entries(composition.stepContent).map(([stepId, stepContent]) => [
        stepId,
        composition.shellKind === "default"
          ? reidentifyPlacementSlotV2(stepContent, nextId)
          : Object.fromEntries(
              Object.entries(stepContent).map(([slotId, slotValue]) => [
                slotId,
                reidentifyPlacementSlotV2(slotValue, nextId),
              ]),
            ),
      ]),
    ) as typeof composition.stepContent;
  } else if (composition.shellKind === "default")
    composition.main = reidentifyPlacementSlotV2(composition.main, nextId);
  else
    composition.content = Object.fromEntries(
      Object.entries(composition.content).map(([slotId, slotValue]) => [
        slotId,
        reidentifyPlacementSlotV2(slotValue, nextId),
      ]),
    );
};

const rootSlotsForPageV2 = (draft: ApplicationDraftV2, pageType: string): PlacementSlotV2[] => {
  const page = draft.content.pages.find((candidate) => candidate.type === pageType);
  if (page === undefined) throw new Error(`${pageType} page required`);
  const composition = page.composition;
  if ("stepContent" in composition)
    return Object.values(composition.stepContent).flatMap((step) =>
      composition.shellKind === "default" ? [step] : Object.values(step),
    );
  return composition.shellKind === "default"
    ? [composition.main]
    : Object.values(composition.content);
};

describe("native Application V2 version impact", () => {
  it("uses strict homogeneous V2 metadata while stored V2 selectors remain closed", () => {
    const draft = compiledV2Draft();
    expect(
      compareDefinitionVersionImpact({
        kind: "application",
        validationContractVersion: "2.0.0",
        history: [],
        candidate: draft,
      }),
    ).toMatchObject({ outcome: "initial_release", assignedVersion: "1.0.0" });

    const missingOuter = v2RequestAfter(draft) as Record<string, unknown>;
    delete missingOuter.validationContractVersion;
    expectVersionImpactCode(() => compareDefinitionVersionImpact(missingOuter), "invalid_request");

    const unknownOuter = { ...v2RequestAfter(draft), validationContractVersion: "3.0.0" };
    expectVersionImpactCode(() => compareDefinitionVersionImpact(unknownOuter), "invalid_request");

    const wrongHistory = v2RequestAfter(draft);
    wrongHistory.history[0]!.publication.validationContractVersion = "1.0.0" as "2.0.0";
    expectVersionImpactCode(() => compareDefinitionVersionImpact(wrongHistory), "invalid_request");

    const staleFingerprint = v2RequestAfter(draft);
    staleFingerprint.history[0]!.content.theme.tokens.brand = {
      kind: "color_pair",
      light: "#000000",
      dark: "#ffffff",
    };
    expectVersionImpactCode(
      () => compareDefinitionVersionImpact(staleFingerprint),
      "content_fingerprint_mismatch",
    );

    expect(selectApplicationValidationContract("2.0.0")).toBe("v2");
    expect(selectApplicationContractPair("2.0.0", "2.0.0").schema).toBe("v2");
  });

  it("is deterministic, does not mutate input, and confirms only the exact V2 decision", () => {
    const request = v2RequestAfter(compiledV2Draft());
    const before = structuredClone(request);
    const unchanged = compareDefinitionVersionImpact(request);
    expect(unchanged).toMatchObject({ outcome: "no_change", currentVersion: "1.0.0" });
    expect(request).toEqual(before);

    const changed = structuredClone(request);
    changed.candidate.content.theme.tokens.brand = {
      kind: "color_pair",
      light: "#654321",
      dark: "#abcdef",
    };
    const first = compareDefinitionVersionImpact(changed);
    const repeated = compareDefinitionVersionImpact(structuredClone(changed));
    expect(first).toEqual(repeated);
    expect(first).toMatchObject({
      outcome: "release_required",
      impact: "patch",
      assignedVersion: "1.0.1",
    });
    if (first.outcome !== "release_required") throw new Error("Release-required result expected");
    expect(
      confirmDefinitionVersionImpact(changed, {
        subject: first.subject,
        comparisonFingerprint: first.comparisonFingerprint,
        assignedVersion: first.assignedVersion,
      }),
    ).toEqual(first);
    expectVersionImpactCode(
      () =>
        confirmDefinitionVersionImpact(changed, {
          subject: first.subject,
          comparisonFingerprint: fingerprint("9"),
          assignedVersion: first.assignedVersion,
        }),
      "confirmation_mismatch",
    );
  });

  it("classifies responsive geometry and same-slot breakpoint order as patch", () => {
    const draft = compiledV2Draft();
    const slotValue = dashboardPrimaryV2(draft);
    addPlacementV2(slotValue, id(990), presentationPlacementV2(draft));

    const geometry = v2RequestAfter(draft);
    const geometrySlot = dashboardPrimaryV2(geometry.candidate);
    const geometryId = geometrySlot.order.desktop[0]!;
    geometrySlot.placements[geometryId]!.responsive.desktop.width = { kind: "content" };
    expect(compareDefinitionVersionImpact(geometry)).toMatchObject({ impact: "patch" });

    const order = v2RequestAfter(draft);
    dashboardPrimaryV2(order.candidate).order.phone.reverse();
    expect(compareDefinitionVersionImpact(order)).toMatchObject({ impact: "patch" });
  });

  it("classifies reparenting, permission, setting and dependency changes as major", () => {
    const draft = compiledV2Draft();
    const primary = dashboardPrimaryV2(draft);
    const parentId = primary.order.desktop[0]!;
    const parent = primary.placements[parentId]!;
    const childSlot = parent.slots.body;
    if (childSlot === undefined) throw new Error("Nested body slot required");
    const childId = childSlot.order.desktop[0]!;

    const reparented = v2RequestAfter(draft);
    const nextPrimary = dashboardPrimaryV2(reparented.candidate);
    const nextParent = nextPrimary.placements[parentId]!;
    const moved = nextParent.slots.body!.placements[childId]!;
    removePlacementV2(nextParent.slots.body!, childId);
    addPlacementV2(nextPrimary, childId, moved);
    expect(compareDefinitionVersionImpact(reparented)).toMatchObject({ impact: "major" });

    for (const permission of ["viewPermissionKey", "usePermissionKey"] as const) {
      const request = v2RequestAfter(draft);
      dashboardPrimaryV2(request.candidate).placements[parentId]![permission] =
        "application.crm.open";
      expect(compareDefinitionVersionImpact(request)).toMatchObject({ impact: "major" });
    }

    const setting = v2RequestAfter(draft);
    const top = dashboardPrimaryV2(setting.candidate).placements[parentId]!;
    top.settings.title = { kind: "text", value: "Changed title" };
    expect(compareDefinitionVersionImpact(setting)).toMatchObject({ impact: "major" });

    const dependency = v2RequestAfter(draft);
    dependency.candidate.content.platformBlockDependencies[0]!.catalogueFingerprint =
      fingerprint("8");
    expect(compareDefinitionVersionImpact(dependency)).toMatchObject({ impact: "major" });
  });

  it("distinguishes optional presentation additions from semantic, public and guided additions", () => {
    const draft = compiledV2Draft();
    const defaultSlot = rootSlotsForPageV2(draft, "list")[0]!;
    const parentId = defaultSlot.order.desktop[0]!;
    defaultSlot.placements[parentId]!.slots.body = canonicalEmptySlotV2();
    const emptyChild = defaultSlot.placements[parentId]!.slots.body;
    if (emptyChild === undefined || emptyChild.order.desktop.length !== 0)
      throw new Error("Empty optional child slot required");

    const optionalChild = v2RequestAfter(draft);
    const optionalTarget = rootSlotsForPageV2(optionalChild.candidate, "list")[0]!.placements[
      parentId
    ]!.slots.body!;
    const heading = presentationPlacementV2(optionalChild.candidate);
    heading.settings.title = { kind: "text", value: "Optional heading" };
    addPlacementV2(optionalTarget, id(991), heading);
    expect(compareDefinitionVersionImpact(optionalChild)).toMatchObject({ impact: "minor" });

    const semantic = v2RequestAfter(draft);
    const semanticTarget = rootSlotsForPageV2(semantic.candidate, "list")[0]!.placements[parentId]!
      .slots.body!;
    const semanticPlacement = presentationPlacementV2(semantic.candidate);
    semanticPlacement.settings.field = structuredClone(
      Object.values(dashboardPrimaryV2(draft).placements)[0]!.settings.field!,
    );
    addPlacementV2(semanticTarget, id(992), semanticPlacement);
    expect(compareDefinitionVersionImpact(semantic)).toMatchObject({ impact: "major" });

    const publicBase = structuredClone(draft);
    publicBase.content.pages.push(publicPageV2(publicBase));
    const publicRequest = v2RequestAfter(publicBase);
    addPlacementV2(
      rootSlotsForPageV2(publicRequest.candidate, "public")[0]!,
      id(993),
      presentationPlacementV2(publicBase),
    );
    expect(compareDefinitionVersionImpact(publicRequest)).toMatchObject({ impact: "major" });

    const guided = v2RequestAfter(draft);
    addPlacementV2(
      rootSlotsForPageV2(guided.candidate, "guided_form")[0]!,
      id(994),
      presentationPlacementV2(draft),
    );
    expect(compareDefinitionVersionImpact(guided)).toMatchObject({ impact: "major" });
  });

  it("classifies page and shell consumer additions without using names", () => {
    const draft = compiledV2Draft();
    const listPage = draft.content.pages.find((page) => page.type === "list");
    const guidedPage = draft.content.pages.find((page) => page.type === "guided_form");
    if (listPage === undefined || guidedPage === undefined)
      throw new Error("List and guided pages required");

    const optionalPage = v2RequestAfter(draft);
    const clonedList = {
      ...structuredClone(listPage),
      pageId: id(995),
      key: "optional_view",
      name: "Not a policy signal",
    };
    reidentifyPagePlacementsV2(clonedList, 1100);
    optionalPage.candidate.content.pages.push(clonedList);
    expect(compareDefinitionVersionImpact(optionalPage)).toMatchObject({ impact: "minor" });

    const guidedAddition = v2RequestAfter(draft);
    const clonedGuided = {
      ...structuredClone(guidedPage),
      pageId: id(996),
      key: "optional_guided_view",
      name: "Optional guided capability",
    };
    reidentifyPagePlacementsV2(clonedGuided, 1200);
    guidedAddition.candidate.content.pages.push(clonedGuided);
    expect(compareDefinitionVersionImpact(guidedAddition)).toMatchObject({ impact: "minor" });

    const publicAddition = v2RequestAfter(draft);
    publicAddition.candidate.content.pages.push(publicPageV2(publicAddition.candidate, id(997)));
    expect(compareDefinitionVersionImpact(publicAddition)).toMatchObject({ impact: "major" });

    const replacementAddition = v2RequestAfter(draft);
    const replacement = {
      ...structuredClone(listPage),
      pageId: id(998),
      key: "replacement_view",
      name: "Standard replacement",
      standardPageReplacement: {
        standardPage: "list" as const,
        recordType: structuredClone(listPage.recordType),
      },
    };
    reidentifyPagePlacementsV2(replacement, 1300);
    replacementAddition.candidate.content.pages.push(replacement);
    expect(compareDefinitionVersionImpact(replacementAddition)).toMatchObject({ impact: "major" });

    const movedExisting = v2RequestAfter(draft);
    const oldSlot = rootSlotsForPageV2(movedExisting.candidate, "list")[0]!;
    const movedId = oldSlot.order.desktop[0]!;
    const placement = oldSlot.placements[movedId]!;
    removePlacementV2(oldSlot, movedId);
    const newPage = {
      ...structuredClone(listPage),
      pageId: id(999),
      key: "moved_view",
      name: "Moved existing content",
      composition: { shellKind: "default" as const, main: canonicalEmptySlotV2() },
    };
    addPlacementV2(newPage.composition.main, movedId, placement);
    movedExisting.candidate.content.pages.push(newPage);
    expect(compareDefinitionVersionImpact(movedExisting)).toMatchObject({ impact: "major" });

    const shellConsumer = v2RequestAfter(draft);
    const shell = shellConsumer.candidate.content.shells[0]!;
    addPlacementV2(shell.layout, id(1000), presentationPlacementV2(draft));
    expect(compareDefinitionVersionImpact(shellConsumer)).toMatchObject({ impact: "major" });
  });

  it("applies explicit shell-slot widening, narrowing and empty binding ownership policy", () => {
    const draft = compiledV2Draft();
    const shell = draft.content.shells[0]!;
    const shellRoot = Object.values(shell.layout.placements)[0]!;
    shellRoot.slots.extra = canonicalEmptySlotV2();

    const optionalSlot = v2RequestAfter(draft);
    optionalSlot.candidate.content.shells[0]!.contentSlots.push({
      slotId: id(998),
      key: "extra",
      label: "Optional content",
      required: false,
      allowedChildCategories: ["content"],
      parentPlacementId: shell.layout.order.desktop[0]!,
      parentSlotKey: "extra",
    });
    expect(compareDefinitionVersionImpact(optionalSlot)).toMatchObject({ impact: "minor" });

    const widenedBase = compiledV2Draft();
    widenedBase.content.shells[0]!.contentSlots[0]!.allowedChildCategories.push("layout");
    const narrowed = v2RequestAfter(widenedBase);
    narrowed.candidate.content.shells[0]!.contentSlots[0]!.allowedChildCategories = ["content"];
    expect(compareDefinitionVersionImpact(narrowed)).toMatchObject({ impact: "major" });

    const widened = v2RequestAfter(compiledV2Draft());
    widened.candidate.content.shells[0]!.contentSlots[0]!.allowedChildCategories.push("layout");
    expect(compareDefinitionVersionImpact(widened)).toMatchObject({ impact: "minor" });

    const reorderedBase = compiledV2Draft();
    reorderedBase.content.shells[0]!.contentSlots[0]!.allowedChildCategories.push("layout");
    const reordered = v2RequestAfter(reorderedBase);
    reordered.candidate.content.shells[0]!.contentSlots[0]!.allowedChildCategories.reverse();
    expect(compareDefinitionVersionImpact(reordered)).toMatchObject({ outcome: "no_change" });

    const emptyBinding = v2RequestAfter(compiledV2Draft());
    applicationDashboardV2(emptyBinding.candidate).composition.content[
      emptyBinding.candidate.content.shells[0]!.contentSlots[1]!.slotId
    ] = canonicalEmptySlotV2();
    expect(compareDefinitionVersionImpact(emptyBinding)).toMatchObject({ impact: "minor" });

    const removalBase = compiledV2Draft();
    applicationDashboardV2(removalBase).composition.content[
      removalBase.content.shells[0]!.contentSlots[1]!.slotId
    ] = canonicalEmptySlotV2();
    const removedBinding = v2RequestAfter(removalBase);
    delete applicationDashboardV2(removedBinding.candidate).composition.content[
      removedBinding.candidate.content.shells[0]!.contentSlots[1]!.slotId
    ];
    expect(compareDefinitionVersionImpact(removedBinding)).toMatchObject({ impact: "major" });
  });

  it("normalises semantically empty internal slot containers without changing the caller", () => {
    const draft = compiledV2Draft();
    const baselineSlot = rootSlotsForPageV2(draft, "list")[0]!;
    const baselineParent = baselineSlot.placements[baselineSlot.order.desktop[0]!]!;
    baselineParent.slots.body = canonicalEmptySlotV2();
    const request = v2RequestAfter(draft);
    const pageSlot = rootSlotsForPageV2(request.candidate, "list")[0]!;
    const parent = pageSlot.placements[pageSlot.order.desktop[0]!]!;
    expect(parent.slots.body).toBeDefined();
    delete parent.slots.body;
    const before = structuredClone(request);
    expect(compareDefinitionVersionImpact(request)).toMatchObject({ outcome: "no_change" });
    expect(request).toEqual(before);
  });
});

const canonicalEmptySlotV2 = (): PlacementSlotV2 => ({
  placements: {},
  order: { desktop: [], tablet: [], phone: [] },
});

const storedV2Row = (source: ApplicationSourceDocumentV2, revision: number): DatabaseRow => ({
  root_id: id(1200),
  organization_id: metadata.organizationId,
  kind: "application",
  definition_key: source.key,
  draft_revision: String(revision),
  published_revision: null,
  authored_source: source,
  source_contract_version: source.source_contract_version,
  source_fingerprint: fingerprintCanonicalValue(source),
  created_at: metadata.createdAt,
  created_by: metadata.createdBy,
  updated_at: metadata.updatedAt,
  updated_by: metadata.updatedBy,
});

const v2StoreRunner = (rows: readonly DatabaseRow[]) => {
  const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
  const transaction: RequestDatabaseTransaction = {
    query: async <ResultRow extends DatabaseRow>(
      strings: TemplateStringsArray,
      ...values: readonly DatabaseValue[]
    ) => {
      calls.push({ text: strings.join("$value"), values });
      return rows as readonly ResultRow[];
    },
  };
  return { calls, transaction };
};

const fixtureJson = (relativePath: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(fixtureRoot, relativePath), "utf8"));

const dependencyModuleReleases = (): ResolvableModuleRelease[] => {
  const sources = fs
    .readdirSync(path.join(fixtureRoot, "modules"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => moduleSourceDocumentSchema.parse(fixtureJson(`modules/${name}`)));
  const outputs = sources.map((source) => {
    const output = compileDefinition({
      source,
      resolution: baseResolution,
      draftMetadata: metadata,
      savedConditionRevisions: [
        { conditionId: "a4b5546d-8a54-4003-adc4-ddb8b0d7257d", revision: 1 },
      ],
    });
    if (output.kind !== "module") throw new Error("Module output required");
    return output;
  });
  const references = new Map(
    outputs.map((output) => [
      String(output.artifact.rootId),
      {
        kind: "module" as const,
        rootId: output.artifact.rootId,
        revision: 1,
        releaseVersion: "1.0.0",
        contentFingerprint: output.artifact.contentFingerprint,
        publishedAt: metadata.createdAt,
        publishedBy: metadata.createdBy,
        validationContractVersion: "1.0.0" as const,
      },
    ]),
  );
  return outputs.map((output) => {
    const dependencyManifest = output.canonical.content.dependencies.map((dependency) => {
      const reference = references.get(String(dependency.moduleRootId));
      if (!reference) throw new Error("Module dependency fixture missing");
      return reference;
    });
    return {
      organizationId: metadata.organizationId,
      key: output.canonical.envelope.key,
      rootId: output.artifact.rootId,
      releaseRevision: 1,
      releaseVersion: "1.0.0",
      contentFingerprint: output.artifact.contentFingerprint,
      resolutionFingerprint: output.resolutionFingerprint,
      published: publishedModuleDefinitionSchema.parse({
        publication: references.get(String(output.artifact.rootId)),
        content: output.canonical.content,
        dependencyManifest,
        releaseNote: "Fixture module release",
      }),
      compilationOutput: output,
      resolutionSnapshot: baseResolution,
    };
  });
};

const publicationCatalogueV2 = async () => {
  const seed = createCatalogueSnapshot();
  const catalogue = createImmutableDefinitionPublicationCatalogue({
    connectionTypeReleases: ["email.json", "calendar.json"].map((name) => {
      const source = connectionTypeSourceDocumentSchema.parse(
        fixtureJson(`connection-types/${name}`),
      );
      const resolved = baseResolution.definitions.find(
        (definition) => definition.kind === "connection_type" && definition.key === source.key,
      );
      if (resolved?.kind !== "connection_type") throw new Error("Connection fixture missing");
      return { source, rootId: resolved.rootId, releaseVersion: "1.0.0" };
    }),
    platformThemeReleases: [],
    applicationCompositionV2: {
      compositionPolicy: seed.platformBlocks.compositionPolicy,
      platformBlockReleases: seed.platformBlocks.releases.map((release) => ({
        blockId: release.blockId,
        key: release.key,
        releaseVersion: release.releaseVersion,
        name: release.name,
        icon: release.icon,
        paletteGroup: release.paletteGroup,
        rendererKey: release.rendererKey,
        properties: release.properties,
        slots: release.slots,
        capabilities: release.capabilities,
      })),
      platformThemeReleases: [
        {
          catalogueThemeId: seed.platformTheme.catalogueThemeId,
          releaseVersion: seed.platformTheme.releaseVersion,
          tokens: seed.platformTheme.tokens,
        },
      ],
    },
  });
  const source = createSource();
  for (const dependency of source.body.platform_block_dependencies) {
    const release = await catalogue.readPlatformBlockReleaseV2(
      dependency.block_id,
      dependency.release_version,
    );
    if (!release) throw new Error("Platform-block fixture missing");
    dependency.content_fingerprint = release.contentFingerprint;
    dependency.catalogue_fingerprint = release.catalogueFingerprint;
  }
  const theme = await catalogue.readPlatformThemeReleaseV2(
    source.body.theme.base.catalogue_theme_id,
    source.body.theme.base.release_version,
  );
  if (!theme) throw new Error("Platform-theme fixture missing");
  source.body.theme.base.content_fingerprint = theme.contentFingerprint;
  source.body.theme.base.catalogue_fingerprint = theme.catalogueFingerprint;
  return { source, catalogue };
};

class V2PublicationRepository
  implements
    DefinitionPublicationRepository,
    DefinitionPublicationReader,
    DefinitionPublicationTransaction
{
  appended?: DefinitionReleaseAppend;

  constructor(
    readonly candidate: DefinitionPublicationCandidate,
    readonly modules: readonly ResolvableModuleRelease[],
  ) {}

  read<Result>(
    _context: Parameters<DefinitionPublicationRepository["read"]>[0],
    operation: (reader: DefinitionPublicationReader) => Promise<Result>,
  ): Promise<Result> {
    return operation(this);
  }

  transaction<Result>(
    _context: Parameters<DefinitionPublicationRepository["transaction"]>[0],
    operation: (transaction: DefinitionPublicationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation(this);
  }

  async readCandidate() {
    return structuredClone(this.candidate);
  }

  async lockCandidate() {
    return structuredClone(this.candidate);
  }

  async listModuleReleases(_organizationId: string, key: string) {
    return this.modules.filter((release) => release.key === key);
  }

  async readModuleRelease(_organizationId: string, rootId: string, releaseRevision: number) {
    return this.modules.find(
      (release) => String(release.rootId) === rootId && release.releaseRevision === releaseRevision,
    );
  }

  async appendRelease(release: DefinitionReleaseAppend): Promise<PublishDefinitionResult> {
    this.appended = release;
    return {
      rootId: release.draft.rootId,
      releaseRevision: release.draft.draftRevision,
      releaseVersion: release.assignedVersion,
      contentFingerprint: release.compilationOutput.artifact.contentFingerprint,
      resolutionFingerprint: release.compilationOutput.resolutionFingerprint,
      comparisonFingerprint: release.comparisonFingerprint,
      dependencyManifest: [...release.dependencyManifest],
      publishedAt: metadata.updatedAt,
      publishedBy: metadata.updatedBy,
    };
  }
}

describe("native Application V2 draft storage", () => {
  it("creates and saves the complete source with exact shell and content-slot identities", async () => {
    const source = createSource();
    const requirements = extractApplicationSourceIdentityRequirementsV2(source);
    expect(requirements.map((requirement) => requirement.kind)).toEqual(
      expect.arrayContaining(["shell", "shell_content_slot"]),
    );

    const creation = v2StoreRunner([storedV2Row(source, 1)]);
    await expect(
      createDefinitionStore(creation.transaction).createRoot({ source }),
    ).resolves.toMatchObject({
      kind: "application",
      sourceContractVersion: "2.0.0",
      source,
    });
    expect(creation.calls[0]?.values).toEqual([
      "application",
      source.key,
      JSON.stringify(source),
      fingerprintCanonicalValue(source),
      JSON.stringify(requirements),
    ]);

    const savedSource = structuredClone(source);
    savedSource.body.description = "A saved complete V2 application draft.";
    const saving = v2StoreRunner([storedV2Row(savedSource, 2)]);
    await expect(
      createDefinitionStore(saving.transaction).saveDraft({
        rootId: id(1200),
        expectedDraftRevision: 1,
        source: savedSource,
      }),
    ).resolves.toMatchObject({ draftRevision: 2, source: savedSource });
    expect(saving.calls[0]?.values).toEqual([
      id(1200),
      1,
      JSON.stringify(savedSource),
      fingerprintCanonicalValue(savedSource),
      JSON.stringify(extractApplicationSourceIdentityRequirementsV2(savedSource)),
    ]);
  });

  it("refuses stored metadata that disagrees with the V2 source", async () => {
    const source = createSource();
    const mismatched = { ...storedV2Row(source, 1), source_contract_version: "1.0.0" };
    await expect(
      createDefinitionStore(v2StoreRunner([mismatched]).transaction).createRoot({ source }),
    ).rejects.toMatchObject({ code: "INVALID_DEFINITION_STORAGE_RESULT" });
  });

  it("retains common edit-save identity and local-reference semantics for V2", () => {
    const brokenHome = createSource();
    brokenHome.body.home_page = "missing_page";
    expect(validateDefinitionSource(brokenHome).failures).toContainEqual(
      expect.objectContaining({
        ruleCode: "vortex.definition.local_references",
        family: "broken_reference",
      }),
    );

    const duplicatePage = createSource();
    duplicatePage.body.pages[1]!.key = duplicatePage.body.pages[0]!.key;
    expect(validateDefinitionSource(duplicatePage).failures).toContainEqual(
      expect.objectContaining({
        ruleCode: "vortex.definition.local_identity_unique",
        family: "duplicate_key",
      }),
    );
  });

  it("publishes, consumes, and restores one exact native V2 application", async () => {
    const { source, catalogue } = await publicationCatalogueV2();
    const sourceResolution = createResolution(source);
    const own = sourceResolution.definitions.find(
      (definition) => definition.kind === "application" && definition.key === source.key,
    );
    if (own?.kind !== "application") throw new Error("Application fixture missing");
    const draft = storedDefinitionDraftSchema.parse({
      kind: "application",
      rootId: own.rootId,
      source,
      organizationId: metadata.organizationId,
      key: source.key,
      draftRevision: 1,
      sourceContractVersion: "2.0.0",
      sourceFingerprint: fingerprintCanonicalValue(source),
      createdAt: metadata.createdAt,
      createdBy: metadata.createdBy,
      updatedAt: metadata.updatedAt,
      updatedBy: metadata.updatedBy,
    });
    const candidate: DefinitionPublicationCandidate = {
      draft,
      identities: sourceResolution.identities.filter(
        (identity) => identity.definitionKey === source.key,
      ),
      history: { kind: "application", definitionKey: source.key, history: [] },
    };
    const repository = new V2PublicationRepository(candidate, dependencyModuleReleases());
    const context = sessionContextSchema.parse({
      callerKind: "system",
      tenantId: id(1201),
      organizationId: metadata.organizationId,
      systemActorId: metadata.createdBy,
      sessionId: id(1202),
      authenticationStrength: "service",
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      accessVersion: 1,
      correlationId: id(1203),
    });
    const publication = createDefinitionPublicationService(repository, catalogue);
    const prepared = await publication.prepare(context, {
      rootId: draft.rootId,
      expectedDraftRevision: 1,
    });
    expect(prepared.confirmation).toMatchObject({
      outcome: "initial_release",
      assignedVersion: "1.0.0",
    });
    expect(
      prepared.confirmation.dependencyManifest.filter((entry) => entry.kind === "platform_block"),
    ).toHaveLength(2);
    await publication.publish(context, {
      confirmation: prepared.confirmation,
      releaseNote: "Native V2 application release",
    });
    const appended = repository.appended;
    if (!appended || !("validationContractVersion" in appended.compilationOutput))
      throw new Error("V2 append required");
    expect(appended.validationContractVersion).toBe("2.0.0");

    const evidence = {
      organizationId: metadata.organizationId,
      kind: "application" as const,
      key: source.key,
      rootId: draft.rootId,
      releaseRevision: 1,
      releaseVersion: "1.0.0",
      sourceContractVersion: "2.0.0",
      validationContractVersion: "2.0.0",
      contentFingerprint: appended.compilationOutput.artifact.contentFingerprint,
      resolutionFingerprint: appended.compilationOutput.resolutionFingerprint,
      compilationOutput: appended.compilationOutput,
      resolutionSnapshot: appended.resolutionSnapshot,
      dependencyManifest: appended.dependencyManifest,
      moduleDependencyTargets: appended.dependencyManifest
        .filter((entry) => entry.kind === "module")
        .map((entry) => ({
          rootId: entry.rootId,
          releaseRevision: entry.releaseRevision,
          releaseVersion: entry.releaseVersion,
          contentFingerprint: entry.contentFingerprint,
          resolutionFingerprint: entry.resolutionFingerprint,
        })),
    };
    const read = await createDefinitionConsumerReadService(
      { read: async () => evidence },
      catalogue,
    ).read(context, {
      kind: "application",
      rootId: draft.rootId,
      selector: { selection: "revision", releaseRevision: 1 },
    });
    expect(read).toMatchObject({
      validationContractVersion: "2.0.0",
      content: appended.compilationOutput.canonical.content,
    });

    const tamperedCanonical = structuredClone(evidence);
    tamperedCanonical.compilationOutput.canonical.content.description += " Tampered.";
    const tamperedResolution = structuredClone(evidence);
    tamperedResolution.resolutionSnapshot.identities.pop();
    const missingBlock = structuredClone(evidence);
    missingBlock.dependencyManifest = missingBlock.dependencyManifest.filter(
      (entry) => entry.kind !== "platform_block",
    );
    const extraBlock = structuredClone(evidence);
    const existingBlock = extraBlock.dependencyManifest.find(
      (entry) => entry.kind === "platform_block",
    );
    if (!existingBlock || existingBlock.kind !== "platform_block")
      throw new Error("Platform-block manifest fixture missing");
    extraBlock.dependencyManifest.push({ ...existingBlock, blockId: id(1998) });
    const substitutedBlock = structuredClone(evidence);
    const substituted = substitutedBlock.dependencyManifest.find(
      (entry) => entry.kind === "platform_block",
    );
    if (!substituted || substituted.kind !== "platform_block")
      throw new Error("Platform-block manifest fixture missing");
    substituted.catalogueFingerprint = fingerprint("9");
    for (const candidateEvidence of [
      tamperedCanonical,
      tamperedResolution,
      missingBlock,
      extraBlock,
      substitutedBlock,
    ])
      await expect(
        createDefinitionConsumerReadService(
          { read: async () => candidateEvidence },
          catalogue,
        ).read(context, {
          kind: "application",
          rootId: draft.rootId,
          selector: { selection: "revision", releaseRevision: 1 },
        }),
      ).rejects.toMatchObject({ code: "DEFINITION_RELEASE_INTEGRITY_FAILED" });

    const unavailableCatalogue: DefinitionPublicationCatalogue = {
      ...catalogue,
      readPlatformBlockReleaseV2: async () => undefined,
    };
    await expect(
      createDefinitionConsumerReadService(
        { read: async () => evidence },
        unavailableCatalogue,
      ).read(context, {
        kind: "application",
        rootId: draft.rootId,
        selector: { selection: "revision", releaseRevision: 1 },
      }),
    ).rejects.toMatchObject({ code: "DEFINITION_DEPENDENCY_UNAVAILABLE" });

    const tamperedProvenance = structuredClone(appended.compilationOutput);
    tamperedProvenance.provenance.pop();
    const catalogueSnapshot = await catalogue.readApplicationCompositionCatalogueSnapshotV2({
      platformBlocks: source.body.platform_block_dependencies.map((entry) => ({
        blockId: entry.block_id,
        releaseVersion: entry.release_version,
      })),
      platformTheme: {
        catalogueThemeId: source.body.theme.base.catalogue_theme_id,
        releaseVersion: source.body.theme.base.release_version,
      },
    });
    if (!catalogueSnapshot) throw new Error("V2 catalogue snapshot fixture missing");
    expect(
      validateDefinitionSet({
        requests: [
          {
            sourceContractVersion: "2.0.0",
            validationContractVersion: "2.0.0",
            source,
            resolution: appended.resolutionSnapshot,
            catalogueSnapshot,
            draftMetadata: metadata,
          },
        ],
        outputs: [tamperedProvenance],
        publishedHistories: [{ kind: "application", definitionKey: source.key, history: [] }],
      }).failures,
    ).toContainEqual(
      expect.objectContaining({ ruleCode: "vortex.definition.provenance_complete" }),
    );

    const requirements = extractApplicationSourceIdentityRequirementsV2(source);
    const identityEvidence = requirements.flatMap((requirement) =>
      requirement.aliases.map((alias) => {
        const identity = appended.resolutionSnapshot.identities.find(
          (entry) =>
            entry.definitionKey === source.key &&
            entry.scope === requirement.scope &&
            entry.kind === requirement.kind &&
            entry.componentOwner === requirement.componentOwner &&
            entry.alias === alias,
        );
        if (!identity) throw new Error("Restore identity fixture missing");
        return { ...identity, ownerScope: requirement.ownerScope };
      }),
    );
    const restored = storedDefinitionDraftSchema.parse({
      ...draft,
      draftRevision: 2,
      publishedRevision: 1,
      restoredFromReleaseRevision: 1,
      restoredFromSourceFingerprint: draft.sourceFingerprint,
      restoredBy: context.systemActorId,
      restoredAt: metadata.updatedAt,
      restoreCorrelationId: context.correlationId,
    });
    const historyRepository: DefinitionHistoryRepository = {
      list: async () => undefined,
      readMetadata: async () => undefined,
      restore: async (_context, _command, verify) => {
        await verify({
          ...evidence,
          authoredSource: source,
          sourceFingerprint: draft.sourceFingerprint,
          identityEvidence,
        });
        return { outcome: "restored", draft: restored };
      },
    };
    await expect(
      createDefinitionHistoryService(historyRepository, catalogue).restoreDraft(context, {
        kind: "application",
        rootId: draft.rootId,
        targetReleaseRevision: 1,
        expectedDraftRevision: 1,
      }),
    ).resolves.toMatchObject({ sourceContractVersion: "2.0.0", source });

    let restoreMutated = false;
    const unavailableRestoreRepository: DefinitionHistoryRepository = {
      list: async () => undefined,
      readMetadata: async () => undefined,
      restore: async (_context, _command, verify) => {
        await verify({
          ...evidence,
          authoredSource: source,
          sourceFingerprint: draft.sourceFingerprint,
          identityEvidence,
        });
        restoreMutated = true;
        return { outcome: "restored", draft: restored };
      },
    };
    await expect(
      createDefinitionHistoryService(
        unavailableRestoreRepository,
        unavailableCatalogue,
      ).restoreDraft(context, {
        kind: "application",
        rootId: draft.rootId,
        targetReleaseRevision: 1,
        expectedDraftRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "DEFINITION_RELEASE_INTEGRITY_FAILED" });
    expect(restoreMutated).toBe(false);
  });

  it("publishes symmetric representation transitions as major and a native V2 follow-up natively", async () => {
    const { source: sourceV2, catalogue } = await publicationCatalogueV2();
    const modules = dependencyModuleReleases();
    const context = sessionContextSchema.parse({
      callerKind: "system",
      tenantId: id(1201),
      organizationId: metadata.organizationId,
      systemActorId: metadata.createdBy,
      sessionId: id(1202),
      authenticationStrength: "service",
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      accessVersion: 1,
      correlationId: id(1203),
    });
    const legacySource = definitionSourceDocumentSchema.parse(baseSource);
    if (legacySource.kind !== "application") throw new Error("Legacy Application fixture required");
    const legacyOutput = compileDefinition({
      source: legacySource,
      resolution: baseResolution,
      draftMetadata: metadata,
    });
    if (legacyOutput.kind !== "application") throw new Error("Legacy output required");
    const legacyRelease = publishedApplicationDefinitionV1Schema.parse({
      publication: {
        kind: "application",
        rootId: legacyOutput.artifact.rootId,
        revision: 1,
        releaseVersion: "1.0.0",
        contentFingerprint: legacyOutput.artifact.contentFingerprint,
        publishedAt: metadata.createdAt,
        publishedBy: metadata.createdBy,
        validationContractVersion: "1.0.0",
      },
      content: legacyOutput.canonical.content,
      dependencyManifest: [],
      releaseNote: "Legacy release",
    });
    const resolutionV2 = createResolution(sourceV2);
    const own = resolutionV2.definitions.find(
      (definition) => definition.kind === "application" && definition.key === sourceV2.key,
    );
    if (own?.kind !== "application") throw new Error("Application fixture missing");
    const v2Candidate: DefinitionPublicationCandidate = {
      draft: storedDefinitionDraftSchema.parse({
        kind: "application",
        rootId: own.rootId,
        organizationId: metadata.organizationId,
        key: sourceV2.key,
        draftRevision: 2,
        publishedRevision: 1,
        sourceContractVersion: "2.0.0",
        sourceFingerprint: fingerprintCanonicalValue(sourceV2),
        source: sourceV2,
        createdAt: metadata.createdAt,
        createdBy: metadata.createdBy,
        updatedAt: metadata.updatedAt,
        updatedBy: metadata.updatedBy,
      }),
      identities: resolutionV2.identities.filter(
        (identity) => identity.definitionKey === sourceV2.key,
      ),
      history: {
        kind: "application",
        definitionKey: sourceV2.key,
        history: [legacyRelease],
      },
    };
    const toV2Repository = new V2PublicationRepository(v2Candidate, modules);
    const toV2 = createDefinitionPublicationService(toV2Repository, catalogue);
    const toV2Prepared = await toV2.prepare(context, {
      rootId: own.rootId,
      expectedDraftRevision: 2,
    });
    expect(toV2Prepared.confirmation).toMatchObject({ impact: "major", assignedVersion: "2.0.0" });
    await toV2.publish(context, {
      confirmation: toV2Prepared.confirmation,
      releaseNote: "Move the existing application to native V2",
    });
    const v2Output = toV2Repository.appended?.compilationOutput;
    if (!v2Output || v2Output.kind !== "application" || !("validationContractVersion" in v2Output))
      throw new Error("V2 transition output required");
    const v2Release = publishedApplicationDefinitionV2Schema.parse({
      publication: {
        ...legacyRelease.publication,
        revision: 2,
        releaseVersion: "2.0.0",
        contentFingerprint: v2Output.artifact.contentFingerprint,
        validationContractVersion: "2.0.0",
      },
      content: v2Output.canonical.content,
      dependencyManifest: [],
      releaseNote: "Native V2 release",
    });
    const v2FollowUpSource = structuredClone(sourceV2);
    v2FollowUpSource.body.description = `${v2FollowUpSource.body.description} Updated.`;
    const v2FollowUpResolution = createResolution(v2FollowUpSource);
    const v2FollowUpRepository = new V2PublicationRepository(
      {
        draft: storedDefinitionDraftSchema.parse({
          ...v2Candidate.draft,
          draftRevision: 3,
          publishedRevision: 2,
          source: v2FollowUpSource,
          sourceFingerprint: fingerprintCanonicalValue(v2FollowUpSource),
        }),
        identities: v2FollowUpResolution.identities.filter(
          (identity) => identity.definitionKey === sourceV2.key,
        ),
        history: {
          kind: "application",
          definitionKey: sourceV2.key,
          history: [legacyRelease, v2Release],
        },
      },
      modules,
    );
    const v2FollowUp = await createDefinitionPublicationService(
      v2FollowUpRepository,
      catalogue,
    ).prepare(context, { rootId: own.rootId, expectedDraftRevision: 3 });
    expect(v2FollowUp.confirmation).toMatchObject({ impact: "patch", assignedVersion: "2.0.1" });

    const restoredV1Source = structuredClone(legacySource);
    restoredV1Source.body.description = `${restoredV1Source.body.description} Restored.`;
    const restoredV1Repository = new V2PublicationRepository(
      {
        draft: storedDefinitionDraftSchema.parse({
          kind: "application",
          rootId: own.rootId,
          organizationId: metadata.organizationId,
          key: restoredV1Source.key,
          draftRevision: 3,
          publishedRevision: 2,
          sourceContractVersion: "1.0.0",
          sourceFingerprint: fingerprintCanonicalValue(restoredV1Source),
          source: restoredV1Source,
          createdAt: metadata.createdAt,
          createdBy: metadata.createdBy,
          updatedAt: metadata.updatedAt,
          updatedBy: metadata.updatedBy,
        }),
        identities: baseResolution.identities.filter(
          (identity) => identity.definitionKey === restoredV1Source.key,
        ),
        history: {
          kind: "application",
          definitionKey: restoredV1Source.key,
          history: [legacyRelease, v2Release],
        },
      },
      modules,
    );
    const restoredV1 = await createDefinitionPublicationService(
      restoredV1Repository,
      catalogue,
    ).prepare(context, { rootId: own.rootId, expectedDraftRevision: 3 });
    expect(restoredV1.confirmation).toMatchObject({ impact: "major", assignedVersion: "3.0.0" });
  });
});
