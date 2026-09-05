import { describe, expect, it } from "vitest";
import { createApplicationResolutionSnapshotV2 } from "../src/application-v2-resolution";

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

describe("Application V2 resolution evidence", () => {
  it("sorts exact definition and identity assignments before fingerprinting", () => {
    const application = {
      kind: "application" as const,
      key: "example.application",
      rootId: id(1),
      exactVersion: "2.0.0",
    };
    const module = {
      kind: "module" as const,
      key: "example.module",
      rootId: id(2),
      exactVersion: "1.0.0",
    };
    const page = {
      definitionKey: "example.application",
      scope: "content",
      kind: "page" as const,
      componentOwner: "page_owner",
      alias: "home",
      identifier: id(3),
    };
    const placement = {
      definitionKey: "example.application",
      scope: "content",
      kind: "block_placement" as const,
      componentOwner: "placement_owner",
      alias: "main",
      identifier: id(4),
    };
    const definitions = [module, application];
    const identities = [page, placement];

    const forward = createApplicationResolutionSnapshotV2({ definitions, identities });
    const reverse = createApplicationResolutionSnapshotV2({
      definitions: [...definitions].reverse(),
      identities: [...identities].reverse(),
    });

    expect(reverse).toEqual(forward);
    expect(forward.definitions.map((entry) => entry.key)).toEqual([
      "example.application",
      "example.module",
    ]);
    expect(forward.identities.map((entry) => entry.kind)).toEqual(["block_placement", "page"]);
    expect(definitions).toEqual([module, application]);
    expect(identities).toEqual([page, placement]);
  });
});
