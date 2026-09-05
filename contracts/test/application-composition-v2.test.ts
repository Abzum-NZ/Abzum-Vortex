import fs from "node:fs";
import path from "node:path";
import {
  applicationContentV2Schema,
  applicationSourceDocumentV2Schema,
  blockPropertySchemaV2Schema,
  blockPropertyValueV2Schema,
  immutablePlatformBlockCatalogueV2Schema,
  platformBlockReleaseV2Schema,
  platformBlockDependenciesV2SchemaForCatalogue,
  selectApplicationContractPair,
  sourceBlockPropertyValueV2Schema,
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
const guidedPageId = id(627);
const guidedStepOneId = id(628);
const guidedStepTwoId = id(629);
const guidedStepOnePlacementId = id(631);
const guidedStepTwoPlacementId = id(632);

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

const canonicalGuidedPage = {
  pageId: guidedPageId,
  key: "guided_entry",
  name: "Guided entry",
  type: "guided_form",
  accessPermissionKey: "example.application.open",
  states: ["normal"],
  recordType: { state: "unresolved", qualifiedKey: "example_module:entry" },
  commitActionKey: "example.action.submit",
  steps: [
    { id: guidedStepOneId, name: "Details", summary: false },
    { id: guidedStepTwoId, name: "Summary", summary: true },
  ],
  composition: {
    shellKind: "application",
    shellId: canonicalShell.shellId,
    stepContent: {
      [guidedStepOneId]: {
        [shellPrimarySlotId]: {
          placements: {
            [guidedStepOnePlacementId]: canonicalPlacement(blockOne),
          },
          order: {
            desktop: [guidedStepOnePlacementId],
            tablet: [guidedStepOnePlacementId],
            phone: [guidedStepOnePlacementId],
          },
        },
      },
      [guidedStepTwoId]: {
        [shellPrimarySlotId]: {
          placements: {
            [guidedStepTwoPlacementId]: canonicalPlacement(blockTwo),
          },
          order: {
            desktop: [guidedStepTwoPlacementId],
            tablet: [guidedStepTwoPlacementId],
            phone: [guidedStepTwoPlacementId],
          },
        },
      },
    },
  },
} as const;

const sourceGuidedPage = {
  id: "guided_page",
  key: "guided_entry",
  name: "Guided entry",
  type: "guided_form",
  permission: "example.application.open",
  states: ["normal"],
  record_type: "example_module:entry",
  commit_action: "example.action.submit",
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
          placements: { details_placement: sourcePlacement(sourceBlockOne) },
          order: { desktop: ["details_placement"] },
        },
      },
      summary_step: {
        shell_primary: {
          placements: { summary_placement: sourcePlacement(sourceBlockTwo) },
          order: { desktop: ["summary_placement"] },
        },
      },
    },
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
    if (page.composition.shellKind !== "application" || !("content" in page.composition))
      throw new Error("Shell fixture required");
    return {
      value,
      content: page.composition.content as unknown as Record<string, MutableTestSlot>,
    };
  };
  const sourceWithPage = (page: unknown) => ({
    ...sourceApplication,
    body: { ...sourceApplication.body, pages: [...sourceApplication.body.pages, page] },
  });
  const canonicalWithPage = (page: unknown) => ({
    ...canonicalApplication,
    pages: [...canonicalApplication.pages, page],
  });

  it("parses strict authored and canonical V2 application documents", () => {
    expect(applicationSourceDocumentV2Schema.safeParse(sourceApplication).success).toBe(true);
    expect(applicationContentV2Schema.safeParse(canonicalApplication).success).toBe(true);
  });

  it("represents every guided step through one page shell and its own ordered content tree", () => {
    expect(
      applicationSourceDocumentV2Schema.safeParse(sourceWithPage(sourceGuidedPage)).success,
    ).toBe(true);
    expect(
      applicationContentV2Schema.safeParse(canonicalWithPage(canonicalGuidedPage)).success,
    ).toBe(true);
    expect(Object.keys(sourceGuidedPage.composition.step_content)).toEqual(
      sourceGuidedPage.steps.map((step) => step.id),
    );
    expect(Object.keys(canonicalGuidedPage.composition.stepContent)).toEqual(
      canonicalGuidedPage.steps.map((step) => step.id),
    );
  });

  it("preserves every legacy guided-step and placement owner in the V2 step-content shape", () => {
    const legacy = (sourceV1.body.pages as Record<string, unknown>[]).find(
      (page) => page.type === "guided_form",
    );
    if (legacy === undefined) throw new Error("Legacy guided-form fixture missing");
    const legacySteps = legacy.steps as {
      id: string;
      blocks: { id: string }[];
    }[];
    const represented = {
      ...sourceGuidedPage,
      id: legacy.id,
      key: legacy.key,
      name: legacy.name,
      permission: legacy.permission,
      record_type: legacy.record_type,
      commit_action: legacy.commit_action,
      states: legacy.states,
      steps: legacySteps.map((step, index) => ({
        id: step.id,
        name: `Step ${index + 1}`,
        summary: index === legacySteps.length - 1,
      })),
      composition: {
        shell_kind: "default" as const,
        step_content: Object.fromEntries(
          legacySteps.map((step) => [
            step.id,
            {
              placements: Object.fromEntries(
                step.blocks.map((block) => [block.id, sourcePlacement(sourceBlockOne)]),
              ),
              order: { desktop: step.blocks.map((block) => block.id) },
            },
          ]),
        ),
      },
    };
    const parsed = applicationSourceDocumentV2Schema.safeParse(sourceWithPage(represented));

    expect(parsed.success).toBe(true);
    expect(Object.keys(represented.composition.step_content)).toEqual(
      legacySteps.map((step) => step.id),
    );
    expect(
      Object.values(represented.composition.step_content).flatMap((slot) =>
        Object.keys(slot.placements),
      ),
    ).toEqual(legacySteps.flatMap((step) => step.blocks.map((block) => block.id)));
  });

  it("rejects duplicate, missing or extra guided-step ownership", () => {
    const duplicatePage = {
      ...sourceGuidedPage,
      steps: [sourceGuidedPage.steps[0], { ...sourceGuidedPage.steps[1], id: "details_step" }],
    };
    expect(applicationSourceDocumentV2Schema.safeParse(sourceWithPage(duplicatePage)).success).toBe(
      false,
    );

    const remainingStepContent = Object.fromEntries(
      Object.entries(canonicalGuidedPage.composition.stepContent).filter(
        ([stepId]) => stepId !== guidedStepTwoId,
      ),
    );
    const missingPage = {
      ...canonicalGuidedPage,
      composition: { ...canonicalGuidedPage.composition, stepContent: remainingStepContent },
    };
    expect(applicationContentV2Schema.safeParse(canonicalWithPage(missingPage)).success).toBe(
      false,
    );

    const extraPage = {
      ...sourceGuidedPage,
      composition: {
        ...sourceGuidedPage.composition,
        step_content: {
          ...sourceGuidedPage.composition.step_content,
          undeclared_step: sourceEmptySlot,
        },
      },
    };
    expect(applicationSourceDocumentV2Schema.safeParse(sourceWithPage(extraPage)).success).toBe(
      false,
    );
  });

  it("validates application-shell slots independently for every guided step", () => {
    const missingRequiredPage = {
      ...canonicalGuidedPage,
      composition: {
        ...canonicalGuidedPage.composition,
        stepContent: {
          ...canonicalGuidedPage.composition.stepContent,
          [guidedStepTwoId]: { [shellPrimarySlotId]: canonicalEmptySlot },
        },
      },
    };
    expect(
      applicationContentV2Schema.safeParse(canonicalWithPage(missingRequiredPage)).success,
    ).toBe(false);

    const extraSlotPage = {
      ...sourceGuidedPage,
      composition: {
        ...sourceGuidedPage.composition,
        step_content: {
          ...sourceGuidedPage.composition.step_content,
          details_step: {
            ...sourceGuidedPage.composition.step_content.details_step,
            unknown_slot: sourceEmptySlot,
          },
        },
      },
    };
    expect(applicationSourceDocumentV2Schema.safeParse(sourceWithPage(extraSlotPage)).success).toBe(
      false,
    );
  });

  it("includes every guided-step tree in global identity and dependency validation", () => {
    const duplicatePlacementPage = {
      ...canonicalGuidedPage,
      composition: {
        ...canonicalGuidedPage.composition,
        stepContent: {
          ...canonicalGuidedPage.composition.stepContent,
          [guidedStepTwoId]: {
            [shellPrimarySlotId]: {
              placements: {
                [guidedStepOnePlacementId]: canonicalPlacement(blockTwo),
              },
              order: {
                desktop: [guidedStepOnePlacementId],
                tablet: [guidedStepOnePlacementId],
                phone: [guidedStepOnePlacementId],
              },
            },
          },
        },
      },
    };
    expect(
      applicationContentV2Schema.safeParse(canonicalWithPage(duplicatePlacementPage)).success,
    ).toBe(false);

    const wrongDependencyPage = {
      ...sourceGuidedPage,
      composition: {
        ...sourceGuidedPage.composition,
        step_content: {
          ...sourceGuidedPage.composition.step_content,
          summary_step: {
            shell_primary: {
              placements: {
                summary_placement: {
                  ...sourcePlacement(sourceBlockTwo),
                  block: { block_id: sourceBlockTwo.block_id, release_version: "9.0.0" },
                },
              },
              order: { desktop: ["summary_placement"] },
            },
          },
        },
      },
    };
    expect(
      applicationSourceDocumentV2Schema.safeParse(sourceWithPage(wrongDependencyPage)).success,
    ).toBe(false);
  });

  it("does not permit a second root-level content authority on guided pages", () => {
    const page = {
      ...sourceGuidedPage,
      composition: { ...sourceGuidedPage.composition, content: {} },
    };
    expect(applicationSourceDocumentV2Schema.safeParse(sourceWithPage(page)).success).toBe(false);

    const canonicalPage = {
      ...canonicalGuidedPage,
      composition: { ...canonicalGuidedPage.composition, main: canonicalEmptySlot },
    };
    expect(applicationContentV2Schema.safeParse(canonicalWithPage(canonicalPage)).success).toBe(
      false,
    );
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
