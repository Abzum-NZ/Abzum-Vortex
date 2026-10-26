import {
  savedConditionRevisionAssignmentSchema,
  type SavedConditionRevisionAssignment,
} from "./definition-compilation-contracts";
import { canonicalJson, compareCanonicalStrings } from "./canonical-json-definition";
import { refuseVersionImpact } from "./version-impact-error";

export type SavedConditionLike = Readonly<{
  conditionId: string;
  publishedRevision: number;
  contractFingerprint: string;
  declaredFieldIds: readonly string[];
}> &
  Readonly<Record<string, unknown>>;

/** Each saved condition's most recent published form, and the ids the latest release carried. */
export type SavedConditionRevisionHistory = Readonly<{
  lastSeen: readonly SavedConditionLike[];
  latestReleaseIds: ReadonlySet<string>;
}>;

export type SavedConditionRevisionInput = Readonly<{
  conditions: readonly SavedConditionLike[];
  history: SavedConditionRevisionHistory;
}>;

const revisionShape = (condition: SavedConditionLike) => {
  const contract: Record<string, unknown> = { ...condition };
  delete contract.publishedRevision;
  delete contract.contractFingerprint;
  return {
    ...contract,
    declaredFieldIds: [...condition.declaredFieldIds].sort(compareCanonicalStrings),
  };
};

const sameContract = (left: SavedConditionLike, right: SavedConditionLike): boolean =>
  canonicalJson(revisionShape(left)) === canonicalJson(revisionShape(right));

const nextRevision = (previous: number): number => {
  if (!Number.isSafeInteger(previous) || previous < 1 || previous === Number.MAX_SAFE_INTEGER)
    refuseVersionImpact("invalid_history");
  return previous + 1;
};

/**
 * Derives condition revisions solely from canonical conditions and the published history of
 * each condition. Removal emits no mutable state; reintroduction receives a new revision so an
 * old grant cannot silently begin matching again.
 */
export const deriveSavedConditionRevisions = ({
  conditions,
  history,
}: SavedConditionRevisionInput): SavedConditionRevisionAssignment[] => {
  const lastSeenById = new Map(
    history.lastSeen.map((condition) => [condition.conditionId, condition]),
  );
  const candidateIds = new Set<string>();
  return [...conditions]
    .sort((left, right) => compareCanonicalStrings(left.conditionId, right.conditionId))
    .map((condition) => {
      if (candidateIds.has(condition.conditionId))
        refuseVersionImpact("ambiguous_component_identity");
      candidateIds.add(condition.conditionId);
      const lastSeen = lastSeenById.get(condition.conditionId);
      const revision =
        lastSeen === undefined
          ? 1
          : history.latestReleaseIds.has(condition.conditionId) && sameContract(lastSeen, condition)
            ? lastSeen.publishedRevision
            : nextRevision(lastSeen.publishedRevision);
      return savedConditionRevisionAssignmentSchema.parse({
        conditionId: condition.conditionId,
        revision,
      });
    });
};
