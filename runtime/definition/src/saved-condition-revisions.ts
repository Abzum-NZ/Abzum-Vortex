import {
  savedConditionRevisionAssignmentSchema,
  type PublishedModuleDefinition,
  type SavedConditionRevisionAssignment,
  type SavedSharingCondition,
} from "@vortex/contracts";
import { canonicalJson } from "./canonical-json";
import { refuseVersionImpact } from "./version-impact-error";

export type SavedConditionRevisionInput = Readonly<{
  rootId: string;
  conditions: readonly SavedSharingCondition[];
  history: readonly PublishedModuleDefinition[];
}>;

const revisionShape = (condition: SavedSharingCondition) => {
  const contract: Partial<SavedSharingCondition> = { ...condition };
  delete contract.publishedRevision;
  delete contract.contractFingerprint;
  return { ...contract, declaredFieldIds: [...condition.declaredFieldIds].sort() };
};

const sameContract = (left: SavedSharingCondition, right: SavedSharingCondition): boolean =>
  canonicalJson(revisionShape(left)) === canonicalJson(revisionShape(right));

const nextRevision = (previous: number): number => {
  if (!Number.isSafeInteger(previous) || previous < 1 || previous === Number.MAX_SAFE_INTEGER)
    refuseVersionImpact("invalid_history");
  return previous + 1;
};

/**
 * Derives condition revisions solely from canonical conditions and immutable
 * release history. Removal emits no mutable state; reintroduction receives a
 * new revision so an old grant cannot silently begin matching again.
 */
export const deriveSavedConditionRevisions = ({
  rootId,
  conditions,
  history,
}: SavedConditionRevisionInput): SavedConditionRevisionAssignment[] => {
  const latestById = new Map<string, SavedSharingCondition>();
  let previousReleaseIds = new Set<string>();
  let previousReleaseRevision = 0;

  for (const release of history) {
    if (release.publication.rootId !== rootId) refuseVersionImpact("root_mismatch");
    if (release.publication.revision <= previousReleaseRevision)
      refuseVersionImpact("invalid_history");
    previousReleaseRevision = release.publication.revision;

    const currentIds = new Set<string>();
    for (const condition of release.content.sharingConditions) {
      if (currentIds.has(condition.conditionId))
        refuseVersionImpact("ambiguous_component_identity");
      currentIds.add(condition.conditionId);
      const lastSeen = latestById.get(condition.conditionId);
      const expectedRevision =
        lastSeen === undefined
          ? 1
          : previousReleaseIds.has(condition.conditionId) && sameContract(lastSeen, condition)
            ? lastSeen.publishedRevision
            : nextRevision(lastSeen.publishedRevision);
      if (condition.publishedRevision !== expectedRevision) refuseVersionImpact("invalid_history");
      latestById.set(condition.conditionId, condition);
    }
    previousReleaseIds = currentIds;
  }

  const candidateIds = new Set<string>();
  return [...conditions]
    .sort((left, right) => left.conditionId.localeCompare(right.conditionId))
    .map((condition) => {
      if (candidateIds.has(condition.conditionId))
        refuseVersionImpact("ambiguous_component_identity");
      candidateIds.add(condition.conditionId);
      const lastSeen = latestById.get(condition.conditionId);
      const revision =
        lastSeen === undefined
          ? 1
          : previousReleaseIds.has(condition.conditionId) && sameContract(lastSeen, condition)
            ? lastSeen.publishedRevision
            : nextRevision(lastSeen.publishedRevision);
      return savedConditionRevisionAssignmentSchema.parse({
        conditionId: condition.conditionId,
        revision,
      });
    });
};
