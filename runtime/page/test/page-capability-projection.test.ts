import { describe, expect, it, vi } from "vitest";
import { projectPageCapability } from "../src/page-capability-projection";

vi.mock("server-only", () => ({}));

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const block = { blockId: id(1), releaseVersion: "1.0.0" };
const layout = { visible: true, width: { kind: "fill" }, height: { kind: "content" } };
const responsive = { desktop: layout, tablet: layout, phone: layout };
const placement = (slots: Record<string, unknown> = {}) => ({
  block,
  settings: { heading: { kind: "text", value: "Permitted heading" } },
  themeOverrides: {},
  responsive,
  slots,
});
const childA = id(11);
const childB = id(12);
const parent = id(10);
const page = {
  pageId: id(2),
  key: "overview",
  name: "Overview",
  accessPermissionKey: "example.pages.overview",
  states: ["normal"],
  type: "dashboard",
  composition: {
    shellKind: "default",
    main: {
      placements: {
        [parent]: {
          ...placement({
            content: {
              placements: {
                [childA]: { ...placement(), viewPermissionKey: "example.blocks.a.view" },
                [childB]: { ...placement(), usePermissionKey: "example.blocks.b.use" },
              },
              order: {
                desktop: [childA, childB],
                tablet: [childB, childA],
                phone: [childA, childB],
              },
            },
          }),
          viewPermissionKey: "example.sections.view",
        },
      },
      order: { desktop: [parent], tablet: [parent], phone: [parent] },
    },
  },
};

describe("page capability projection", () => {
  it("returns no page or metadata when page discovery is refused", () => {
    expect(projectPageCapability(page, { pageAllowed: false, placements: {} })).toBeUndefined();
  });

  it("inherits the admitted page gate for historical V2 placements without explicit keys", () => {
    const historical = structuredClone(page);
    const historicalParent = historical.composition.main.placements[parent];
    delete historicalParent.viewPermissionKey;
    expect(projectPageCapability(historical, { pageAllowed: true, placements: {} })).toMatchObject({
      composition: {
        main: {
          placements: {
            [parent]: { settings: { heading: { value: "Permitted heading" } } },
          },
        },
      },
    });
  });

  it("removes a refused parent and its independently allowed subtree", () => {
    const projected = projectPageCapability(page, {
      pageAllowed: true,
      placements: {
        [parent]: { viewAllowed: false, useAllowed: false, operationBound: false },
        [childA]: { viewAllowed: true, useAllowed: true, operationBound: true },
      },
    });
    expect(projected).toMatchObject({
      name: "Overview",
      composition: { main: { placements: {}, order: { desktop: [], tablet: [], phone: [] } } },
    });
    expect(JSON.stringify(projected)).not.toContain("example.sections.view");
    expect(JSON.stringify(projected)).not.toContain(childA);
  });

  it("retains an allowed sibling, prunes orders and exposes safe unavailability", () => {
    const projected = projectPageCapability(page, {
      pageAllowed: true,
      placements: {
        [parent]: { viewAllowed: true, useAllowed: true, operationBound: false },
        [childA]: { viewAllowed: false, useAllowed: false, operationBound: false },
        [childB]: { viewAllowed: true, useAllowed: false, operationBound: true },
      },
    });
    const content = (
      projected as {
        composition: { main: { placements: Record<string, { slots: Record<string, unknown> }> } };
      }
    ).composition.main.placements[parent]!.slots.content as {
      placements: Record<string, unknown>;
      order: Record<string, string[]>;
    };
    expect(
      (projected as { composition: { main: { placements: Record<string, unknown> } } }).composition
        .main.placements[parent],
    ).not.toHaveProperty("availability");
    expect(Object.keys(content.placements)).toEqual([childB]);
    expect(content.order).toEqual({ desktop: [childB], tablet: [childB], phone: [childB] });
    expect(content.placements[childB]).toMatchObject({
      settings: { heading: { kind: "text", value: "Permitted heading" } },
      availability: "unavailable",
      unavailableReason: "operation_unavailable",
    });
    expect(JSON.stringify(projected)).not.toContain("accessPermissionKey");
    expect(JSON.stringify(projected)).not.toContain("viewPermissionKey");
  });
});
