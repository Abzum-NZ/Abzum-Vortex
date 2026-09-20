import type { Data } from "@puckeditor/core";
import type { ApplicationShellV2, BlockPropertySchemaV2Contract } from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { createVortexPuckAdapterV2, VortexPuckAdapterError } from "../src";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (letter: string) => `sha256:${letter.repeat(64)}`;
const responsive = {
  desktop: {
    visible: true,
    width: { kind: "fill" as const },
    height: { kind: "content" as const },
  },
  tablet: {
    visible: false,
    width: { kind: "fill" as const },
    height: { kind: "content" as const },
  },
  phone: { visible: true, width: { kind: "fill" as const }, height: { kind: "content" as const } },
};

const cardProperties: BlockPropertySchemaV2Contract[] = [
  { key: "text", label: "Text", required: false, kind: "text", minLength: 0, maxLength: 100 },
  {
    key: "number",
    label: "Number",
    required: false,
    kind: "number",
    integer: false,
    minimum: 0,
    maximum: 100,
  },
  { key: "boolean", label: "Boolean", required: false, kind: "boolean" },
  {
    key: "choice",
    label: "Choice",
    required: false,
    kind: "choice",
    options: [{ key: "option_a", label: "Option A" }],
  },
  {
    key: "rich_text",
    label: "Rich Text",
    required: false,
    kind: "rich_text",
    allowedElements: ["paragraph", "heading", "bulleted_list", "numbered_list", "emphasis", "link"],
  },
  { key: "url", label: "URL", required: false, kind: "url" },
  { key: "asset", label: "Asset", required: false, kind: "asset_reference" },
  { key: "icon", label: "Icon", required: false, kind: "icon" },
  {
    key: "theme_token",
    label: "Theme Token",
    required: false,
    kind: "theme_token",
    tokenKind: "color_pair",
  },
  { key: "field", label: "Field", required: false, kind: "field_reference" },
  { key: "relationship", label: "Relationship", required: false, kind: "relationship_reference" },
  { key: "action", label: "Action", required: false, kind: "action_reference" },
  { key: "page", label: "Page", required: false, kind: "page_reference" },
  { key: "query", label: "Query", required: false, kind: "query_reference" },
  { key: "pipeline", label: "Pipeline", required: false, kind: "pipeline_reference" },
  { key: "record_type", label: "Record Type", required: false, kind: "record_type_reference" },
  { key: "record", label: "Record", required: false, kind: "record_reference" },
  {
    key: "group",
    label: "Group",
    required: false,
    kind: "group",
    properties: [
      {
        key: "nested",
        label: "Nested",
        required: false,
        kind: "list",
        minimumItems: 0,
        maximumItems: 10,
        item: { key: "item", label: "Item", required: false, kind: "icon" },
      },
    ],
  },
  {
    key: "list",
    label: "List",
    required: false,
    kind: "list",
    minimumItems: 0,
    maximumItems: 10,
    item: {
      key: "item",
      label: "Item",
      required: false,
      kind: "text",
      minLength: 0,
      maxLength: 50,
    },
  },
];

const adapter = createVortexPuckAdapterV2({
  compositionPolicy: { maximumDepth: 8, maximumPlacements: 100 },
  releases: [
    {
      blockId: id(1),
      key: "vortex.content.card",
      releaseVersion: "1.0.0",
      contentFingerprint: hash("a"),
      catalogueFingerprint: hash("b"),
      name: "Card",
      icon: "panel-top",
      paletteGroup: "content",
      rendererKey: "vortex.renderer.card",
      properties: cardProperties,
      slots: [{ key: "body", label: "Body", required: false, allowedChildCategories: ["content"] }],
      capabilities: {
        responsiveVisibility: true,
        responsiveOrder: true,
        gridWidth: true,
        height: "content_or_bounded",
        accessibleName: "not_applicable",
        publicSurface: "allowed",
      },
    },
    {
      blockId: id(90),
      key: "vortex.layout.section",
      releaseVersion: "1.0.0",
      contentFingerprint: hash("c"),
      catalogueFingerprint: hash("d"),
      name: "Section",
      icon: "layout",
      paletteGroup: "layout",
      rendererKey: "vortex.renderer.section",
      properties: [
        {
          key: "title",
          label: "Title",
          required: true,
          kind: "text",
          minLength: 1,
          maxLength: 50,
        },
      ],
      slots: [
        { key: "content", label: "Content", required: true, allowedChildCategories: ["content"] },
      ],
      capabilities: {
        responsiveVisibility: true,
        responsiveOrder: true,
        gridWidth: true,
        height: "content",
        accessibleName: "not_applicable",
        publicSurface: "allowed",
      },
    },
    {
      blockId: id(91),
      key: "vortex.actions.badge",
      releaseVersion: "1.0.0",
      contentFingerprint: hash("e"),
      catalogueFingerprint: hash("f"),
      name: "Badge",
      icon: "tag",
      paletteGroup: "actions",
      rendererKey: "vortex.renderer.badge",
      properties: [
        {
          key: "label",
          label: "Label",
          required: false,
          kind: "text",
          minLength: 0,
          maxLength: 20,
        },
      ],
      slots: [],
      capabilities: {
        responsiveVisibility: true,
        responsiveOrder: true,
        gridWidth: true,
        height: "content",
        accessibleName: "not_applicable",
        publicSurface: "allowed",
      },
    },
  ],
});

const semantic = {
  text: { kind: "text" as const, value: "hello" },
  number: { kind: "number" as const, value: 2 },
  boolean: { kind: "boolean" as const, value: true },
  choice: { kind: "choice" as const, value: "option_a" },
  rich_text: {
    kind: "rich_text" as const,
    value: {
      blocks: [
        {
          kind: "paragraph" as const,
          children: [{ kind: "text" as const, text: "hello rich text" }],
        },
      ],
    },
  },
  url: { kind: "url" as const, value: "https://example.com" },
  asset: { kind: "asset_reference" as const, assetId: id(2) },
  icon: { kind: "icon" as const, iconKey: "check" },
  theme_token: { kind: "theme_token" as const, tokenKey: "token_color" },
  field: { kind: "field_reference" as const, fieldId: id(3) },
  relationship: { kind: "relationship_reference" as const, relationshipId: id(4) },
  action: { kind: "action_reference" as const, actionKey: "vortex.action.submit" },
  page: { kind: "page_reference" as const, pageId: id(5) },
  query: { kind: "query_reference" as const, queryId: id(6) },
  pipeline: { kind: "pipeline_reference" as const, pipelineId: id(7) },
  record_type: {
    kind: "record_type_reference" as const,
    recordType: { state: "unresolved" as const, qualifiedKey: "crm:contact" },
  },
  record: {
    kind: "record_reference" as const,
    recordType: { state: "unresolved" as const, qualifiedKey: "crm:contact" },
    recordId: id(8),
  },
  group: {
    kind: "group" as const,
    properties: {
      nested: { kind: "list" as const, items: [{ kind: "icon" as const, iconKey: "check" }] },
    },
  },
  list: {
    kind: "list" as const,
    items: [{ kind: "text" as const, value: "first item" }],
  },
};

const placement = (n: number, slots = {}) => ({
  block: { blockId: id(1), releaseVersion: "1.0.0" },
  settings: semantic,
  viewPermissionKey: "vortex.permission.view",
  usePermissionKey: "vortex.permission.use",
  visibilityCondition: {
    kind: "comparison" as const,
    operator: "equals" as const,
    left: { source: "parameter" as const, key: "status" },
    right: { source: "value" as const, value: "active" },
  },
  queryId: id(6),
  themeOverrides: { density: { kind: "density" as const, value: "compact" as const } },
  responsive,
  slots,
});

const slot = (ids: number[], child = {}) => ({
  placements: Object.fromEntries(ids.map((n) => [id(n), placement(n, n === ids[0] ? child : {})])),
  order: { desktop: ids.map(id), tablet: [...ids].reverse().map(id), phone: ids.map(id) },
});

// Compile-time fixture: the adapter returns the installed Puck Data contract.
const puckAssignable: Data = adapter.toPuckData(slot([10]));
void puckAssignable;

describe("headless Vortex-to-Puck adapter", () => {
  it("uses actual Puck root/content/zones, props.id, metadata, nested configured slots, and complete semantic leaves", () => {
    const original = slot([10, 11], { body: slot([12]) });
    const data = adapter.toPuckData(original);
    expect(data).toMatchObject({ root: {}, zones: {} });
    expect(data.content[0]!.props).toMatchObject({
      id: id(10),
      settings: semantic,
      vortex: { queryId: id(6), responsive },
    });
    expect(data.content[0]!.props.body).toHaveLength(1);
    expect(adapter.fromPuckData(data)).toEqual(original);
  });

  it("uses actual Puck array reordering for desktop and preserves distinct tablet/phone order", () => {
    const data = adapter.toPuckData(slot([20, 21], { body: slot([22, 23]) }));
    data.content.reverse();
    const body = data.content.find((node) => node.props.id === id(20))!.props
      .body as Data["content"];
    body.reverse();
    const returned = adapter.fromPuckData(data);
    expect(returned.order).toEqual({
      desktop: [id(21), id(20)],
      tablet: [id(21), id(20)],
      phone: [id(20), id(21)],
    });
    expect(returned.placements[id(20)]!.slots.body.order.desktop).toEqual([id(23), id(22)]);
  });

  it("performs complete and stable round-trip conversion for application shells", () => {
    const shell: ApplicationShellV2 = {
      shellId: id(50),
      key: "standard_shell",
      name: "Standard Shell",
      layout: slot([10], { body: slot([]) }),
      contentSlots: [
        {
          slotId: id(60),
          key: "page_content",
          label: "Page Content",
          required: true,
          allowedChildCategories: ["content"],
          parentPlacementId: id(10),
          parentSlotKey: "body",
        },
      ],
    };
    const puckData = adapter.toPuckShell(shell);
    expect(adapter.fromPuckShell(shell, puckData)).toEqual(shell);
  });

  it("strictly refuses malformed, private, and contradictory editor input with adapter errors", () => {
    expect(() => adapter.fromPuckData({ root: {}, content: [], zones: {}, ui: {} })).toThrow(
      VortexPuckAdapterError,
    );
    expect(() =>
      adapter.fromPuckData({
        root: {},
        content: [{ type: "vortex.renderer.card", props: { id: id(30) } }],
        zones: {},
      }),
    ).toThrow(VortexPuckAdapterError);
    const data = adapter.toPuckData(slot([31]));
    (data.content[0]!.props as Record<string, unknown>)._transient = true;
    expect(() => adapter.fromPuckData(data)).toThrow(VortexPuckAdapterError);
  });

  it("enforces declared property keys on inbound Puck settings", () => {
    const data = adapter.toPuckData(slot([40]));
    const cardProps = data.content[0]!.props as Record<string, unknown>;
    const settings = cardProps.settings as Record<string, unknown>;
    settings.undeclared_key = { kind: "text", value: "invalid" };
    expect(() => adapter.fromPuckData(data)).toThrow(VortexPuckAdapterError);

    // Undeclared nested group property
    const dataGroup = adapter.toPuckData(slot([41]));
    const groupSettings = dataGroup.content[0]!.props.settings as Record<string, unknown>;
    (groupSettings.group as { properties: Record<string, unknown> }).properties.extra = {
      kind: "text",
      value: "extra",
    };
    expect(() => adapter.fromPuckData(dataGroup)).toThrow(VortexPuckAdapterError);
  });

  it("enforces declared value kinds and constraints on inbound Puck settings", () => {
    // Kind mismatch: number passed for text property
    const dataMismatch = adapter.toPuckData(slot([42]));
    const settingsMismatch = dataMismatch.content[0]!.props.settings as Record<string, unknown>;
    settingsMismatch.text = { kind: "number", value: 123 };
    expect(() => adapter.fromPuckData(dataMismatch)).toThrow(VortexPuckAdapterError);

    // Scalar constraint violation: number above maximum
    const dataNum = adapter.toPuckData(slot([43]));
    const settingsNum = dataNum.content[0]!.props.settings as Record<string, unknown>;
    settingsNum.number = { kind: "number", value: 999 };
    expect(() => adapter.fromPuckData(dataNum)).toThrow(VortexPuckAdapterError);

    // Choice constraint violation: option not in declared options
    const dataChoice = adapter.toPuckData(slot([44]));
    const settingsChoice = dataChoice.content[0]!.props.settings as Record<string, unknown>;
    settingsChoice.choice = { kind: "choice", value: "unknown_option" };
    expect(() => adapter.fromPuckData(dataChoice)).toThrow(VortexPuckAdapterError);
  });

  it("enforces required block properties", () => {
    const badSectionNode = {
      type: "vortex.renderer.section",
      props: {
        id: id(45),
        settings: {}, // missing required 'title'
        vortex: {
          block: { blockId: id(90), releaseVersion: "1.0.0" },
          themeOverrides: {},
          responsive,
          order: { desktop: [id(45)], tablet: [id(45)], phone: [id(45)] },
        },
        content: [
          {
            type: "vortex.renderer.card",
            props: {
              id: id(46),
              settings: semantic,
              vortex: {
                block: { blockId: id(1), releaseVersion: "1.0.0" },
                themeOverrides: {},
                responsive,
                order: { desktop: [id(46)], tablet: [id(46)], phone: [id(46)] },
              },
            },
          },
        ],
      },
    };
    expect(() => adapter.fromPuckData({ root: {}, content: [badSectionNode], zones: {} })).toThrow(
      VortexPuckAdapterError,
    );
  });

  it("enforces declared required and allowed slots", () => {
    // Missing required slot on Section
    const missingSlotNode = {
      type: "vortex.renderer.section",
      props: {
        id: id(47),
        settings: { title: { kind: "text", value: "Section Title" } },
        vortex: {
          block: { blockId: id(90), releaseVersion: "1.0.0" },
          themeOverrides: {},
          responsive,
          order: { desktop: [id(47)], tablet: [id(47)], phone: [id(47)] },
        },
      },
    };
    expect(() => adapter.fromPuckData({ root: {}, content: [missingSlotNode], zones: {} })).toThrow(
      VortexPuckAdapterError,
    );

    // Empty required slot on Section
    const emptySlotNode = {
      ...missingSlotNode,
      props: {
        ...missingSlotNode.props,
        content: [],
      },
    };
    expect(() => adapter.fromPuckData({ root: {}, content: [emptySlotNode], zones: {} })).toThrow(
      VortexPuckAdapterError,
    );

    // Disallowed child category: Badge (feedback) in Card body (only content allowed)
    const disallowedChildData = adapter.toPuckData(slot([48]));
    (disallowedChildData.content[0]!.props as Record<string, unknown>).body = [
      {
        type: "vortex.renderer.badge",
        props: {
          id: id(49),
          settings: { label: { kind: "text", value: "Beta" } },
          vortex: {
            block: { blockId: id(91), releaseVersion: "1.0.0" },
            themeOverrides: {},
            responsive,
            order: { desktop: [id(49)], tablet: [id(49)], phone: [id(49)] },
          },
        },
      },
    ];
    expect(() => adapter.fromPuckData(disallowedChildData)).toThrow(VortexPuckAdapterError);
  });

  it("enforces globally unique nested placement IDs across the slot hierarchy", () => {
    // Duplicate ID between root and nested child placement
    const data = adapter.toPuckData(slot([50], { body: slot([50]) }));
    expect(() => adapter.fromPuckData(data)).toThrow(VortexPuckAdapterError);
  });

  it("enforces catalogue maximumDepth and maximumPlacements policy", () => {
    const tightCatalogueAdapter = createVortexPuckAdapterV2({
      compositionPolicy: { maximumDepth: 2, maximumPlacements: 2 },
      releases: [
        {
          blockId: id(1),
          key: "vortex.content.card",
          releaseVersion: "1.0.0",
          contentFingerprint: hash("a"),
          catalogueFingerprint: hash("b"),
          name: "Card",
          icon: "panel-top",
          paletteGroup: "content",
          rendererKey: "vortex.renderer.card",
          properties: cardProperties,
          slots: [
            { key: "body", label: "Body", required: false, allowedChildCategories: ["content"] },
          ],
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
    });

    // Exceeds maximumPlacements (3 placements > 2)
    const exceedPlacementsData = adapter.toPuckData(slot([61, 62, 63]));
    expect(() => tightCatalogueAdapter.fromPuckData(exceedPlacementsData)).toThrow(
      VortexPuckAdapterError,
    );

    // Exceeds maximumDepth (depth 3 > 2)
    const exceedDepthData = adapter.toPuckData(
      slot([64], { body: slot([65], { body: slot([66]) }) }),
    );
    expect(() => tightCatalogueAdapter.fromPuckData(exceedDepthData)).toThrow(
      VortexPuckAdapterError,
    );
  });

  it("reparses the fully assembled shell with applicationShellV2Schema and converts failures with cause", () => {
    const shell: ApplicationShellV2 = {
      shellId: id(70),
      key: "application_shell",
      name: "Application Shell",
      layout: slot([71], { body: slot([]) }),
      contentSlots: [
        {
          slotId: id(72),
          key: "main_content",
          label: "Main Content",
          required: true,
          allowedChildCategories: ["content"],
          parentPlacementId: id(71),
          parentSlotKey: "body",
        },
      ],
    };

    // Puck data populates the reserved content slot target, violating applicationShellV2Schema
    const invalidPuckData = adapter.toPuckData(slot([71], { body: slot([73]) }));
    let caught: VortexPuckAdapterError | undefined;
    try {
      adapter.fromPuckShell(shell, invalidPuckData);
    } catch (error) {
      if (error instanceof VortexPuckAdapterError) caught = error;
    }
    expect(caught).toBeInstanceOf(VortexPuckAdapterError);
    expect(caught?.cause).toBeDefined();

    // Puck data deletes the parent placement targeted by the content slot
    const missingParentData = adapter.toPuckData(slot([74]));
    let caughtMissing: VortexPuckAdapterError | undefined;
    try {
      adapter.fromPuckShell(shell, missingParentData);
    } catch (error) {
      if (error instanceof VortexPuckAdapterError) caughtMissing = error;
    }
    expect(caughtMissing).toBeInstanceOf(VortexPuckAdapterError);
    expect(caughtMissing?.cause).toBeDefined();
  });

  it("converts structuredClone and schema validation failures to VortexPuckAdapterError with cause", () => {
    // structuredClone failure (function in themeOverrides)
    const cloneFailData = adapter.toPuckData(slot([80]));
    (
      (cloneFailData.content[0]!.props.vortex as Record<string, unknown>).themeOverrides as Record<
        string,
        unknown
      >
    ).density = () => {};
    let caughtClone: VortexPuckAdapterError | undefined;
    try {
      adapter.fromPuckData(cloneFailData);
    } catch (error) {
      if (error instanceof VortexPuckAdapterError) caughtClone = error;
    }
    expect(caughtClone).toBeInstanceOf(VortexPuckAdapterError);
    expect(caughtClone?.cause).toBeDefined();

    // Inbound schema validation failure (invalid UUID in props.id)
    const schemaFailData = adapter.toPuckData(slot([81]));
    schemaFailData.content[0]!.props.id = "not-a-valid-uuid";
    let caughtSchema: VortexPuckAdapterError | undefined;
    try {
      adapter.fromPuckData(schemaFailData);
    } catch (error) {
      if (error instanceof VortexPuckAdapterError) caughtSchema = error;
    }
    expect(caughtSchema).toBeInstanceOf(VortexPuckAdapterError);
    expect(caughtSchema?.cause).toBeDefined();
  });
});
