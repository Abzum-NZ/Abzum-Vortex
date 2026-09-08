import fs from "node:fs";
import path from "node:path";
import {
  applicationCompositionCatalogueSnapshotV2Schema,
  applicationSourceDocumentV2Schema,
  definitionResolutionSnapshotSchema,
  type ApplicationSourceDocumentV2,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { compileDefinition } from "../src/compiler";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import { extractApplicationSourceIdentityRequirementsV2 } from "../src/source-identities";
import { createApplicationResolutionSnapshotV2 } from "../src/application-v2-resolution";

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
