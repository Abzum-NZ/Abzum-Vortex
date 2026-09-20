import type { Data } from "@puckeditor/core";
import { describe, expect, it } from "vitest";
import { createVortexPuckAdapterV2, VortexPuckAdapterError } from "../src";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (letter: string) => `sha256:${letter.repeat(64)}`;
const responsive = {
  desktop: { visible: true, width: { kind: "fill" }, height: { kind: "content" } },
  tablet: { visible: false, width: { kind: "fill" }, height: { kind: "content" } },
  phone: { visible: true, width: { kind: "fill" }, height: { kind: "content" } },
};
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
      properties: [],
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
  ],
});
const semantic = {
  text: { kind: "text", value: "hello" },
  number: { kind: "number", value: 2 },
  boolean: { kind: "boolean", value: true },
  group: {
    kind: "group",
    properties: { nested: { kind: "list", items: [{ kind: "icon", iconKey: "check" }] } },
  },
  asset: { kind: "asset_reference", assetId: id(2) },
  field: { kind: "field_reference", fieldId: id(3) },
  relationship: { kind: "relationship_reference", relationshipId: id(4) },
  action: { kind: "action_reference", actionKey: "vortex.action.submit" },
  page: { kind: "page_reference", pageId: id(5) },
  query: { kind: "query_reference", queryId: id(6) },
  pipeline: { kind: "pipeline_reference", pipelineId: id(7) },
  record_type: {
    kind: "record_type_reference",
    recordType: { state: "unresolved", qualifiedKey: "crm:contact" },
  },
  record: {
    kind: "record_reference",
    recordType: { state: "unresolved", qualifiedKey: "crm:contact" },
    recordId: id(8),
  },
};
const placement = (n: number, slots = {}) => ({
  block: { blockId: id(1), releaseVersion: "1.0.0" },
  settings: semantic,
  viewPermissionKey: "vortex.permission.view",
  usePermissionKey: "vortex.permission.use",
  visibilityCondition: {
    kind: "comparison",
    operator: "equals",
    left: { source: "parameter", key: "status" },
    right: { source: "value", value: "active" },
  },
  queryId: id(6),
  themeOverrides: { density: { kind: "density", value: "compact" } },
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
  it("uses actual Puck root/content/zones, props.id, metadata, nested configured slots, and semantic leaves", () => {
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
});
