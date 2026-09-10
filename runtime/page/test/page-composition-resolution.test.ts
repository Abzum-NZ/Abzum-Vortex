import { describe, expect, it, vi } from "vitest";
import { resolvePageComposition } from "../src/page-composition-resolution";
import { projectPageCapability } from "../src/page-capability-projection";

vi.mock("server-only", () => ({}));

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const shellId = id(1);
const shellParentId = id(2);
const shellChildId = id(3);
const contentId = id(4);
const requiredSlotId = id(5);
const optionalSlotId = id(6);
const stepA = id(7);
const stepB = id(8);
const layout = { visible: true, width: { kind: "fill" }, height: { kind: "content" } };
const placement = (slots: Record<string, unknown> = {}, viewPermissionKey?: string) => ({
  block: { blockId: id(50), releaseVersion: "1.0.0" },
  ...(viewPermissionKey === undefined ? {} : { viewPermissionKey }),
  settings: {},
  themeOverrides: {},
  responsive: { desktop: layout, tablet: layout, phone: layout },
  slots,
});
const slot = (placements: Record<string, unknown>, order = Object.keys(placements)) => ({
  placements,
  order: { desktop: order, tablet: [...order].reverse(), phone: order },
});
const shell = {
  shellId,
  key: "workspace",
  name: "Workspace",
  layout: slot({
    [shellParentId]: placement(
      {
        nested: slot({
          [shellChildId]: placement(
            { required: slot({}), optional: slot({}) },
            "example.shell.child.view",
          ),
        }),
      },
      "example.shell.parent.view",
    ),
  }),
  contentSlots: [
    {
      slotId: requiredSlotId,
      key: "main",
      label: "Main",
      required: true,
      allowedChildCategories: ["content"],
      parentPlacementId: shellChildId,
      parentSlotKey: "required",
    },
    {
      slotId: optionalSlotId,
      key: "aside",
      label: "Aside",
      required: false,
      allowedChildCategories: ["content"],
      parentPlacementId: shellChildId,
      parentSlotKey: "optional",
    },
  ],
};
const page = (content: Record<string, unknown>) => ({
  pageId: id(20),
  key: "overview",
  name: "Overview",
  type: "dashboard",
  accessPermissionKey: "example.page.view",
  states: ["normal"],
  composition: { shellKind: "application", shellId, content },
});

describe("resolved V2 page composition", () => {
  it("injects content into a nested shell target and leaves an omitted optional slot empty", () => {
    const resolved = resolvePageComposition(
      page({ [requiredSlotId]: slot({ [contentId]: placement() }) }) as never,
      [shell] as never,
    );
    expect(resolved).toMatchObject({
      version: "2",
      roots: {
        kind: "page",
        main: {
          placements: {
            [shellParentId]: {
              slots: {
                nested: {
                  placements: {
                    [shellChildId]: {
                      slots: {
                        required: { placements: { [contentId]: {} } },
                        optional: { placements: {}, order: { desktop: [], tablet: [], phone: [] } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  it("removes injected content when its shell parent is denied and prunes all responsive orders", () => {
    const resolved = resolvePageComposition(
      page({ [requiredSlotId]: slot({ [contentId]: placement() }) }) as never,
      [shell] as never,
    );
    const projected = projectPageCapability(resolved, {
      pageAllowed: true,
      placements: {
        [shellParentId]: { viewAllowed: false, useAllowed: true, operationBound: false },
        [shellChildId]: { viewAllowed: true, useAllowed: true, operationBound: false },
        [contentId]: { viewAllowed: true, useAllowed: true, operationBound: false },
      },
    });
    expect(projected).toMatchObject({
      composition: { main: { placements: {}, order: { desktop: [], tablet: [], phone: [] } } },
    });
    expect(JSON.stringify(projected)).not.toContain(contentId);
  });

  it("refuses a page placement that collides with its selected shell placement identity", () => {
    expect(() =>
      resolvePageComposition(
        page({ [requiredSlotId]: slot({ [shellParentId]: placement() }) }) as never,
        [shell] as never,
      ),
    ).toThrow("PAGE_COMPOSITION_BINDING_INVALID");
  });

  it("resolves an independent shell tree and responsive content order for every guided step", () => {
    const first = id(30);
    const second = id(31);
    const guided = {
      ...page({}),
      type: "guided_form",
      recordType: { moduleRootId: id(40), recordTypeId: id(41) },
      commitActionKey: "example.commit",
      steps: [
        { id: stepA, name: "First", summary: false },
        { id: stepB, name: "Summary", summary: true },
      ],
      composition: {
        shellKind: "application",
        shellId,
        stepContent: {
          [stepA]: { [requiredSlotId]: slot({ [first]: placement() }) },
          [stepB]: { [requiredSlotId]: slot({ [second]: placement() }) },
        },
      },
    };
    const resolved = resolvePageComposition(guided as never, [shell] as never);
    expect(JSON.stringify(resolved.roots)).toContain(first);
    expect(JSON.stringify(resolved.roots)).toContain(second);
    if (resolved.version !== "2" || resolved.roots.kind !== "guided") throw new Error("fixture");
    const firstRoot = resolved.roots.stepContent[stepA]!;
    const secondRoot = resolved.roots.stepContent[stepB]!;
    expect(firstRoot).not.toBe(secondRoot);
    const firstTarget =
      firstRoot.placements[shellParentId]!.slots.nested.placements[shellChildId]!.slots.required;
    expect(firstTarget.order).toEqual({ desktop: [first], tablet: [first], phone: [first] });
  });
});
