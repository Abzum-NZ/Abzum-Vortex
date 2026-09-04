import type { PublishedModuleDefinition, SavedSharingCondition } from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { deriveSavedConditionRevisions } from "../src/saved-condition-revisions";
import { DefinitionVersionImpactError } from "../src/version-impact-error";

const rootId = "10000000-0000-4000-a000-000000000001";
const condition = (
  conditionId: string,
  publishedRevision: number,
  key = "eligible",
  declaredFieldIds: string[] = [],
): SavedSharingCondition =>
  ({
    conditionId,
    sourceRecordTypeId: "10000000-0000-4000-a000-000000000010",
    key,
    publishedRevision,
    contractFingerprint: `sha256:${"a".repeat(64)}`,
    parameters: [],
    condition: { operator: "and", operands: [] },
    declaredFieldIds,
    publicationTests: [{ name: "accepts", parameters: {}, fieldValues: {}, expected: true }],
  }) as SavedSharingCondition;

const release = (
  revision: number,
  conditions: SavedSharingCondition[],
  releaseRootId = rootId,
): PublishedModuleDefinition =>
  ({
    publication: { rootId: releaseRootId, revision },
    content: { sharingConditions: conditions },
    dependencyManifest: [],
    releaseNote: "test",
  }) as unknown as PublishedModuleDefinition;

const derive = (conditions: SavedSharingCondition[], history: PublishedModuleDefinition[] = []) =>
  deriveSavedConditionRevisions({ rootId, conditions, history });

const expectCode = (operation: () => unknown, code: DefinitionVersionImpactError["code"]) => {
  try {
    operation();
    throw new Error("Expected operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(DefinitionVersionImpactError);
    expect((error as DefinitionVersionImpactError).code).toBe(code);
  }
};

describe("saved sharing-condition revision derivation", () => {
  const id = "10000000-0000-4000-a000-000000000020";

  it("starts at one and performs no history writes", () => {
    const history: PublishedModuleDefinition[] = [];
    expect(derive([condition(id, 99)], history)).toEqual([{ conditionId: id, revision: 1 }]);
    expect(history).toEqual([]);
  });

  it("reuses the revision when only derived metadata or declared-field order differs", () => {
    const prior = condition(id, 1, "eligible", ["b", "a"]);
    const current = {
      ...prior,
      publishedRevision: 1,
      contractFingerprint: `sha256:${"b".repeat(64)}` as const,
      declaredFieldIds: ["a", "b"],
    };
    expect(derive([current], [release(7, [prior])])[0]?.revision).toBe(1);
  });

  it("increments once when the resolved contract changes", () => {
    const prior = condition(id, 1);
    expect(derive([condition(id, 1, "eligible_now")], [release(7, [prior])])[0]?.revision).toBe(2);
  });

  it("emits nothing for removal and increments on reintroduction", () => {
    const prior = condition(id, 1);
    const history = [release(2, [prior]), release(3, []), release(4, [])];
    expect(derive([], history)).toEqual([]);
    expect(derive([{ ...prior, publishedRevision: 99 }], history)[0]?.revision).toBe(2);
  });

  it("rejects a wrong root, duplicate IDs and broken history", () => {
    expectCode(
      () => derive([], [release(1, [], "20000000-0000-4000-a000-000000000001")]),
      "root_mismatch",
    );
    expectCode(() => derive([condition(id, 1), condition(id, 1)]), "ambiguous_component_identity");
    expectCode(() => derive([], [release(1, [condition(id, 2)])]), "invalid_history");
  });

  it("refuses non-increasing release history", () => {
    expectCode(() => derive([], [release(2, []), release(2, [])]), "invalid_history");
  });
});
