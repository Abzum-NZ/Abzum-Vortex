import type {
  ModuleContent,
  ModuleContentV2,
  ModuleContentV3,
  ModuleContributionV3,
} from "@vortex/contracts";
import {
  canonicalJson,
  compareCanonicalStrings,
  fingerprintCanonicalValue,
} from "./canonical-json";

/**
 * One exact installed module release, as the definition tier already reads it. The release is
 * identified by its permanent root and the exact published version, never a version requirement,
 * and it carries its compiled content. A caller assembles the list from the installed release
 * evidence it already holds; the resolver never reads storage, permissions or a database.
 */
export type InstalledModuleContributionRelease = Readonly<{
  moduleRootId: string;
  definitionKey: string;
  releaseVersion: string;
  content: ModuleContent | ModuleContentV2 | ModuleContentV3;
}>;

/**
 * One additive contribution binding: a contributor's already-owned field or action is attached to
 * the exact extension point an installed dependency declares. The contribution identity is the
 * contributed component's own permanent identity, so a binding never invents a new identity. The
 * target record type and key come from the target release's own extension-point declaration.
 */
export type ResolvedAdditiveContribution = Readonly<{
  contributionId: string;
  kind: "field" | "action";
  contributorModuleRootId: string;
  contributorDefinitionKey: string;
  contributorReleaseVersion: string;
  targetModuleRootId: string;
  targetModuleKey: string;
  targetModuleReleaseVersion: string;
  targetExtensionPointId: string;
  targetExtensionPointKey: string;
  targetRecordTypeId: string;
  recordTypeId?: string;
  fieldId?: string;
  actionId?: string;
}>;

export const moduleContributionConflictCodes = [
  "namespace_collision",
  "target_removed",
  "target_retyped",
  "contributed_component_removed",
  "contributed_component_retyped",
  "unaccepted_contribution_kind",
] as const;

export type ModuleContributionConflictCode = (typeof moduleContributionConflictCodes)[number];

/**
 * A deterministic refusal for one contribution. `namespace_collision` means the contributed
 * identity is claimed more than once across the installed set or already belongs to the target;
 * `target_removed` means the target is no longer an installed declared dependency or no longer
 * declares the extension point; `target_retyped` means the installed target module's key changed
 * or the extension point's record no longer exists; `contributed_component_removed` and
 * `contributed_component_retyped` mean the contributor no longer owns the declared component as
 * declared; `unaccepted_contribution_kind` means the extension point does not accept the kind.
 */
export type ModuleContributionConflict = Readonly<{
  code: ModuleContributionConflictCode;
  contributionId: string;
  contributorModuleRootId: string;
  targetModuleRootId: string;
  targetExtensionPointId: string;
}>;

/**
 * The one deterministic resolution of an installed module set: every conflict-free contribution
 * as an exact additive binding, plus every typed conflict. `outcome` is `resolved` only when there
 * are no conflicts. Ordering never depends on input order.
 */
export type ModuleContributionResolution = Readonly<{
  outcome: "resolved" | "conflicted";
  bindings: readonly ResolvedAdditiveContribution[];
  conflicts: readonly ModuleContributionConflict[];
  fingerprint: `sha256:${string}`;
}>;

type AnyModuleContent = ModuleContent | ModuleContentV2 | ModuleContentV3;

/** Only the exact fields the resolver reads; the contract schema already guarantees their shapes. */
type ModuleContentView = Readonly<{
  dependencies: readonly unknown[];
  recordTypes: readonly Readonly<{
    recordTypeId: string;
    fields: readonly Readonly<{ fieldId: string }>[];
  }>[];
  actions: readonly Readonly<{ actionId: string }>[];
  extensionPoints: readonly Readonly<{
    extensionPointId: string;
    key: string;
    recordTypeId: string;
    accepts: readonly string[];
  }>[];
  contributions?: readonly ModuleContributionV3[];
}>;

type ContributionSource = Readonly<{
  release: InstalledModuleContributionRelease;
  contribution: ModuleContributionV3;
}>;

const viewOf = (content: AnyModuleContent): ModuleContentView =>
  content as unknown as ModuleContentView;

const contributionOrder = (source: ContributionSource): string =>
  JSON.stringify([
    source.release.moduleRootId,
    String(source.contribution.contributionId),
    source.contribution.targetModule.moduleRootId,
    String(source.contribution.targetExtensionPointId),
  ]);

const conflictOrder = (conflict: ModuleContributionConflict): string =>
  JSON.stringify([
    conflict.code,
    conflict.contributorModuleRootId,
    conflict.contributionId,
    conflict.targetModuleRootId,
    conflict.targetExtensionPointId,
  ]);

const bindingOrder = (binding: ResolvedAdditiveContribution): string =>
  JSON.stringify([
    binding.contributorModuleRootId,
    binding.contributionId,
    binding.targetModuleRootId,
    binding.targetExtensionPointId,
  ]);

/** True only when the contributor's exact release still owns the declared field under its record. */
const contributedFieldExists = (
  content: ModuleContentView,
  recordTypeId: unknown,
  fieldId: unknown,
): boolean =>
  content.recordTypes.some(
    (recordType) =>
      String(recordType.recordTypeId) === String(recordTypeId) &&
      recordType.fields.some((field) => String(field.fieldId) === String(fieldId)),
  );

const contributionIdentityIsField = (content: ModuleContentView, identity: unknown): boolean =>
  content.recordTypes.some((recordType) =>
    recordType.fields.some((field) => String(field.fieldId) === String(identity)),
  );

const contributionIdentityIsAction = (content: ModuleContentView, identity: unknown): boolean =>
  content.actions.some((action) => String(action.actionId) === String(identity));

const conflicted = (
  source: ContributionSource,
  code: ModuleContributionConflictCode,
): ModuleContributionConflict => ({
  code,
  contributionId: String(source.contribution.contributionId),
  contributorModuleRootId: source.release.moduleRootId,
  targetModuleRootId: source.contribution.targetModule.moduleRootId,
  targetExtensionPointId: String(source.contribution.targetExtensionPointId),
});

/**
 * Compiles contributor identities and target extension-point declarations from exact installed
 * module releases into one deterministic binding/conflict set. A contribution binds only when its
 * target is the contributor's exact declared dependency and is installed, its extension point still
 * targets an existing record, the point accepts the kind, the contributor still owns the component
 * and its identity is claimed once and is not already the target's own component.
 */
export const resolveModuleContributions = (
  releases: readonly InstalledModuleContributionRelease[],
): ModuleContributionResolution => {
  const releaseByRootId = new Map<string, InstalledModuleContributionRelease>();
  for (const release of releases) {
    if (releaseByRootId.has(release.moduleRootId))
      throw new Error("Installed module contribution evidence names one release twice");
    releaseByRootId.set(release.moduleRootId, release);
  }

  const sources: ContributionSource[] = [];
  for (const release of releases) {
    const contributions = viewOf(release.content).contributions ?? [];
    for (const contribution of contributions) sources.push({ release, contribution });
  }
  sources.sort((left, right) =>
    compareCanonicalStrings(contributionOrder(left), contributionOrder(right)),
  );

  // A contribution identity is the contributed component's own permanent identity, so it can be
  // attached once across the whole installed set; every repeated claim is a namespace collision.
  const identityCounts = new Map<string, number>();
  for (const source of sources) {
    const identity = String(source.contribution.contributionId);
    identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
  }

  const bindings: ResolvedAdditiveContribution[] = [];
  const conflicts: ModuleContributionConflict[] = [];

  for (const source of sources) {
    const { contribution, release } = source;
    const contributionId = String(contribution.contributionId);
    const contributor = viewOf(release.content);
    const targetModuleRootId = contribution.targetModule.moduleRootId;
    const targetExtensionPointId = String(contribution.targetExtensionPointId);

    if ((identityCounts.get(contributionId) ?? 0) > 1) {
      conflicts.push(conflicted(source, "namespace_collision"));
      continue;
    }

    // The target is the contributor's exact declared dependency entry, never the contributor
    // itself, and that module must still be installed.
    const targetEntry = canonicalJson(contribution.targetModule);
    const targetRelease = releaseByRootId.get(targetModuleRootId);
    if (
      targetRelease === undefined ||
      targetModuleRootId === release.moduleRootId ||
      !contributor.dependencies.some((dependency) => canonicalJson(dependency) === targetEntry)
    ) {
      conflicts.push(conflicted(source, "target_removed"));
      continue;
    }
    if (targetRelease.definitionKey !== contribution.targetModule.moduleKey) {
      conflicts.push(conflicted(source, "target_retyped"));
      continue;
    }
    const target = viewOf(targetRelease.content);
    const point = target.extensionPoints.find(
      (candidate) => String(candidate.extensionPointId) === targetExtensionPointId,
    );
    if (point === undefined) {
      conflicts.push(conflicted(source, "target_removed"));
      continue;
    }
    const targetRecord = target.recordTypes.find(
      (recordType) => String(recordType.recordTypeId) === String(point.recordTypeId),
    );
    if (targetRecord === undefined) {
      conflicts.push(conflicted(source, "target_retyped"));
      continue;
    }
    if (!point.accepts.includes(contribution.kind)) {
      conflicts.push(conflicted(source, "unaccepted_contribution_kind"));
      continue;
    }

    if (contribution.kind === "field") {
      if (!contributedFieldExists(contributor, contribution.recordTypeId, contribution.fieldId)) {
        conflicts.push(
          conflicted(
            source,
            contributionIdentityIsAction(contributor, contributionId)
              ? "contributed_component_retyped"
              : "contributed_component_removed",
          ),
        );
        continue;
      }
      if (targetRecord.fields.some((field) => String(field.fieldId) === contributionId)) {
        conflicts.push(conflicted(source, "namespace_collision"));
        continue;
      }
      bindings.push({
        contributionId,
        kind: "field",
        contributorModuleRootId: release.moduleRootId,
        contributorDefinitionKey: release.definitionKey,
        contributorReleaseVersion: release.releaseVersion,
        targetModuleRootId,
        targetModuleKey: targetRelease.definitionKey,
        targetModuleReleaseVersion: targetRelease.releaseVersion,
        targetExtensionPointId,
        targetExtensionPointKey: String(point.key),
        targetRecordTypeId: String(point.recordTypeId),
        recordTypeId: String(contribution.recordTypeId),
        fieldId: String(contribution.fieldId),
      });
      continue;
    }

    if (!contributionIdentityIsAction(contributor, contributionId)) {
      conflicts.push(
        conflicted(
          source,
          contributionIdentityIsField(contributor, contributionId)
            ? "contributed_component_retyped"
            : "contributed_component_removed",
        ),
      );
      continue;
    }
    if (target.actions.some((action) => String(action.actionId) === contributionId)) {
      conflicts.push(conflicted(source, "namespace_collision"));
      continue;
    }
    bindings.push({
      contributionId,
      kind: "action",
      contributorModuleRootId: release.moduleRootId,
      contributorDefinitionKey: release.definitionKey,
      contributorReleaseVersion: release.releaseVersion,
      targetModuleRootId,
      targetModuleKey: targetRelease.definitionKey,
      targetModuleReleaseVersion: targetRelease.releaseVersion,
      targetExtensionPointId,
      targetExtensionPointKey: String(point.key),
      targetRecordTypeId: String(point.recordTypeId),
      actionId: String(contribution.actionId),
    });
  }

  bindings.sort((left, right) =>
    compareCanonicalStrings(bindingOrder(left), bindingOrder(right)),
  );
  conflicts.sort((left, right) =>
    compareCanonicalStrings(conflictOrder(left), conflictOrder(right)),
  );
  const outcome: ModuleContributionResolution["outcome"] =
    conflicts.length === 0 ? "resolved" : "conflicted";
  const resultWithoutFingerprint = { outcome, bindings, conflicts };
  return {
    ...resultWithoutFingerprint,
    fingerprint: fingerprintCanonicalValue(resultWithoutFingerprint),
  };
};
