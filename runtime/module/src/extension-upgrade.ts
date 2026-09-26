import "server-only";

import { createHash } from "node:crypto";

/**
 * Explicit adoption planning for installed module extensions.
 *
 * An installed contribution is a live fact, not a publication detail: a
 * contributor Module's own field or action is attached to an exact extension
 * point on an exact installed target release, and its stored values survive
 * uninstall and reinstall through ordinary retention. Upgrading a Module can
 * therefore never be decided by the version-impact comparison alone, because
 * that comparison only classifies a candidate release against its own
 * definition history and knows nothing about any installed contribution.
 *
 * This planner is the adoption decision that runs before installation
 * activation. It is pure: it reads no storage, no permission and no database,
 * it provisions nothing, it changes no live contribution and it does not touch
 * the Definition comparison. Given the current installed exact releases, the
 * exact releases the adoption would leave installed, and the #717 resolved
 * bindings, it returns one deterministic compatible upgrade plan or one
 * refusal naming the safe dependency locations a builder needs.
 *
 * Every verdict comes from the supplied releases and bindings. The planner
 * never invents an identity, never treats two differently identified releases
 * as the same thing, and reports a version requirement it cannot prove as
 * unassessable rather than guessing an answer.
 */

export const moduleExtensionUpgradeErrorCodes = ["MODULE_EXTENSION_UPGRADE_INPUT_INVALID"] as const;

export type ModuleExtensionUpgradeErrorCode =
  (typeof moduleExtensionUpgradeErrorCodes)[number];

/** Unusable caller evidence, which is never a compatibility verdict. */
export class ModuleExtensionUpgradeError extends Error {
  readonly code: ModuleExtensionUpgradeErrorCode;

  constructor(code: ModuleExtensionUpgradeErrorCode) {
    super(code);
    this.name = "ModuleExtensionUpgradeError";
    this.code = code;
  }
}

/**
 * The one declared version requirement shape a Module dependency carries. It
 * mirrors the publication contract exactly: either one exact version or one
 * authored npm range expression.
 */
export type ModuleUpgradeVersionRequirement =
  | Readonly<{ selection: "exact"; version: string }>
  | Readonly<{ selection: "allowed_range"; expression: string }>;

/**
 * One declared Module dependency as the exact release itself records it. The
 * local `dependencyKey` is the declaring release's own identity for the entry,
 * and `resolvedVersion` is the resolution the publication of that release
 * stored, so adoption never re-resolves a dependency graph.
 */
export type ModuleUpgradeDependency = Readonly<{
  dependencyKey: string;
  moduleRootId: string;
  moduleKey: string;
  version: ModuleUpgradeVersionRequirement;
  resolvedVersion: string;
}>;

/**
 * Only the exact parts of compiled Module content this planner reads. A caller
 * supplies a release's own compiled content; the shape is declared here so the
 * planner never widens into content it does not evaluate.
 */
export type ModuleUpgradeReleaseContent = Readonly<{
  dependencies: readonly ModuleUpgradeDependency[];
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
}>;

/**
 * One exact Module release, identified by its permanent root and its exact
 * published version, carrying the compiled content the planner evaluates. The
 * current set is the installed set being left; the adopted set is the complete
 * set that would remain installed after the upgrade, so a Module missing from
 * it is uninstalled rather than merely unchanged.
 */
export type ModuleUpgradeRelease = Readonly<{
  moduleRootId: string;
  definitionKey: string;
  releaseVersion: string;
  content: ModuleUpgradeReleaseContent;
}>;

type InstalledExtensionBindingBase = Readonly<{
  contributionId: string;
  contributorModuleRootId: string;
  contributorReleaseVersion: string;
  targetModuleRootId: string;
  targetModuleReleaseVersion: string;
  targetExtensionPointId: string;
  targetRecordTypeId: string;
}>;

/**
 * One installed contribution exactly as the #717 resolver emitted it. The
 * shape is structural, so the definition tier's resolved contribution and the
 * storage tier's resolved binding are both accepted without either tier
 * changing; `targetModuleKey`, definition keys and point keys are optional
 * because only the identities below decide adoption.
 */
export type InstalledExtensionBinding =
  | (InstalledExtensionBindingBase &
      Readonly<{
        kind: "field";
        recordTypeId: string;
        fieldId: string;
      }>)
  | (InstalledExtensionBindingBase &
      Readonly<{
        kind: "action";
        actionId: string;
      }>);

/** The complete adoption input: both exact release sets and the live bindings. */
export type ModuleExtensionUpgradeInput = Readonly<{
  currentReleases: readonly ModuleUpgradeRelease[];
  adoptedReleases: readonly ModuleUpgradeRelease[];
  installedBindings: readonly InstalledExtensionBinding[];
}>;

export const moduleExtensionUpgradeRefusalCodes = [
  "dependency_target_missing",
  "dependency_target_retyped",
  "dependency_resolution_inconsistent",
  "dependency_requirement_unsatisfied",
  "dependency_requirement_unassessable",
  "installed_binding_evidence_mismatch",
  "contribution_target_missing",
  "contribution_dependency_undeclared",
  "extension_point_removed",
  "extension_point_retargeted",
  "extension_point_record_removed",
  "extension_point_kind_withdrawn",
  "contributed_component_removed",
  "contributed_component_retyped",
  "contributed_identity_claimed",
] as const;

export type ModuleExtensionUpgradeRefusalCode =
  (typeof moduleExtensionUpgradeRefusalCodes)[number];

/**
 * One refusal, addressed only by permanent builder-visible identities. It
 * names where the declaration that has to change lives — the declaring release
 * and its own dependency key, the dependency or contribution target, the
 * extension point and the contributed component — and the exact release
 * versions the decision was made against. It never carries a submitted value,
 * a stored record value or a raw path.
 */
export type ModuleExtensionUpgradeRefusalEntry = Readonly<{
  code: ModuleExtensionUpgradeRefusalCode;
  declaringModuleRootId: string;
  dependencyKey: string | null;
  targetModuleRootId: string;
  targetExtensionPointId: string | null;
  contributionId: string | null;
  requiredVersion: string | null;
  selectedVersion: string | null;
}>;

/** One Module root's exact release movement, from the installed release or from nothing. */
export type ModuleExtensionUpgradeReleaseTransition = Readonly<{
  moduleRootId: string;
  definitionKey: string;
  fromReleaseVersion: string | null;
  toReleaseVersion: string;
}>;

/**
 * One installed contribution the adoption keeps, restated against the exact
 * releases the adopted set selects. It is the input #718 needs to re-attach the
 * contribution after the upgrade; it is not itself a provision command.
 */
export type PreservedExtensionBinding =
  | (InstalledExtensionBindingBase &
      Readonly<{
        kind: "field";
        recordTypeId: string;
        fieldId: string;
      }>)
  | (InstalledExtensionBindingBase &
      Readonly<{
        kind: "action";
        actionId: string;
      }>);

/** The one compatible adoption: every check passed and nothing is left to decide. */
export type ModuleExtensionUpgradePlan = Readonly<{
  outcome: "compatible";
  releases: readonly ModuleExtensionUpgradeReleaseTransition[];
  preservedBindings: readonly PreservedExtensionBinding[];
  retiredBindingIds: readonly string[];
  fingerprint: `sha256:${string}`;
}>;

/** The one refused adoption: no activation may follow until it is resolved. */
export type ModuleExtensionUpgradeRefusal = Readonly<{
  outcome: "refused";
  releases: readonly ModuleExtensionUpgradeReleaseTransition[];
  refusals: readonly ModuleExtensionUpgradeRefusalEntry[];
  fingerprint: `sha256:${string}`;
}>;

export type ModuleExtensionUpgradeOutcome =
  | ModuleExtensionUpgradePlan
  | ModuleExtensionUpgradeRefusal;

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isFilled = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const invalidInput = (): never => {
  throw new ModuleExtensionUpgradeError("MODULE_EXTENSION_UPGRADE_INPUT_INVALID");
};

/** Deterministic JSON with sorted object keys, matching the platform's canonical form. */
const canonicalJson = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => compareStrings(left, right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
};

const fingerprint = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

const sortedBy = <Item>(items: readonly Item[], order: (item: Item) => string): Item[] =>
  [...items].sort((left, right) => compareStrings(order(left), order(right)));

/**
 * Published definition versions are stable `major.minor.patch` values, so the
 * planner only evaluates stable releases. A candidate or comparator that is not
 * one is reported rather than interpreted.
 */
const stableVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

type StableVersion = readonly [major: number, minor: number, patch: number];

const stableVersion = (candidate: unknown): StableVersion | undefined => {
  if (typeof candidate !== "string") return undefined;
  const match = stableVersionPattern.exec(candidate);
  if (match === null) return undefined;
  return Object.freeze([Number(match[1]), Number(match[2]), Number(match[3])]) as StableVersion;
};

const compareStableVersions = (left: StableVersion, right: StableVersion): number =>
  left[0] - right[0] || left[1] - right[1] || left[2] - right[2];

type RequirementVerdict = "satisfied" | "unsatisfied" | "unassessable";

/**
 * One range comparator restricted to the closed grammar this planner proves:
 * an optional `>=`, `<=`, `>`, `<`, `=`, `^` or `~` operator followed by a
 * partial stable version whose trailing segments may be wildcards. Hyphen
 * ranges, prerelease comparators, build metadata and any other authored syntax
 * are outside the closed grammar and are reported as unassessable.
 */
type RangeComparator = Readonly<{
  operator: ">=" | "<=" | ">" | "<" | "=" | "^" | "~";
  /** The concrete leading segments, most significant first. */
  segments: readonly number[];
  /** True when the comparator's last segment was a wildcard or omitted. */
  open: boolean;
}>;

const comparatorOperators = [">=", "<=", ">", "<", "=", "^", "~"] as const;

const parsePartialVersion = (
  text: string,
): Pick<RangeComparator, "segments" | "open"> | undefined => {
  const parts = text.split(".");
  if (parts.length > 3) return undefined;
  const segments: number[] = [];
  for (const [index, part] of parts.entries()) {
    if (part === "x" || part === "X" || part === "*") {
      // A wildcard only closes the version; `1.x.3` is not authored syntax.
      if (index !== parts.length - 1) return undefined;
      return Object.freeze({ segments: Object.freeze([...segments]), open: true });
    }
    if (!/^(0|[1-9][0-9]*)$/.test(part)) return undefined;
    segments.push(Number(part));
  }
  return Object.freeze({ segments: Object.freeze([...segments]), open: segments.length < 3 });
};

const parseComparator = (token: string): RangeComparator | undefined => {
  const operator = comparatorOperators.find((candidate) => token.startsWith(candidate));
  const version = parsePartialVersion(
    operator === undefined ? token : token.slice(operator.length),
  );
  if (version === undefined) return undefined;
  return Object.freeze({ operator: operator ?? "=", ...version });
};

const lowerBoundOf = (segments: readonly number[]): StableVersion =>
  Object.freeze([segments[0] ?? 0, segments[1] ?? 0, segments[2] ?? 0]) as StableVersion;

/** The first version above a partial version, or undefined when it is unconstrained. */
const upperBoundOf = (segments: readonly number[]): StableVersion | undefined => {
  if (segments.length === 0) return undefined;
  if (segments.length === 1)
    return Object.freeze([(segments[0] ?? 0) + 1, 0, 0]) as StableVersion;
  return Object.freeze([segments[0] ?? 0, (segments[1] ?? 0) + 1, 0]) as StableVersion;
};

/** The first version a `^` comparator excludes, matching the authored caret meaning. */
const caretUpperBound = (lower: StableVersion, declaredSegments: number): StableVersion => {
  if (lower[0] > 0) return Object.freeze([lower[0] + 1, 0, 0]) as StableVersion;
  if (lower[1] > 0) return Object.freeze([0, lower[1] + 1, 0]) as StableVersion;
  // `^0.0.3` excludes `0.0.4`, while the shorter `^0.0` and `^0` exclude the
  // next minor and the next major respectively.
  if (declaredSegments >= 3) return Object.freeze([0, 0, lower[2] + 1]) as StableVersion;
  if (declaredSegments === 2) return Object.freeze([0, 1, 0]) as StableVersion;
  return Object.freeze([1, 0, 0]) as StableVersion;
};

/**
 * The first version a `~` comparator excludes: a tilde pins the minor segment,
 * so `~1.2` and `~1.2.3` both stop before `1.3.0`, while `~1` allows the whole
 * major.
 */
const tildeUpperBound = (lower: StableVersion, declaredSegments: number): StableVersion =>
  declaredSegments >= 2
    ? (Object.freeze([lower[0], lower[1] + 1, 0]) as StableVersion)
    : (Object.freeze([lower[0] + 1, 0, 0]) as StableVersion);

const comparatorAccepts = (candidate: StableVersion, comparator: RangeComparator): boolean => {
  if (comparator.segments.length === 0) return true;
  const lower = lowerBoundOf(comparator.segments);
  const upper = comparator.open ? upperBoundOf(comparator.segments) : undefined;
  const atLeast = compareStableVersions(candidate, lower) >= 0;
  switch (comparator.operator) {
    case "=":
      return upper === undefined
        ? compareStableVersions(candidate, lower) === 0
        : atLeast && compareStableVersions(candidate, upper) < 0;
    case ">":
      return upper === undefined
        ? compareStableVersions(candidate, lower) > 0
        : compareStableVersions(candidate, upper) >= 0;
    case ">=":
      return atLeast;
    case "<":
      return compareStableVersions(candidate, lower) < 0;
    case "<=":
      return upper === undefined
        ? compareStableVersions(candidate, lower) <= 0
        : compareStableVersions(candidate, upper) < 0;
    case "^": {
      const excluded = caretUpperBound(lower, comparator.segments.length);
      return atLeast && compareStableVersions(candidate, excluded) < 0;
    }
    case "~": {
      const excluded = tildeUpperBound(lower, comparator.segments.length);
      return atLeast && compareStableVersions(candidate, excluded) < 0;
    }
  }
};

/**
 * A range is satisfied when any `||`-separated comparator set holds, and a set
 * holds when every one of its comparators holds. A set the closed grammar
 * cannot parse refuses the adoption instead of admitting a version it did not
 * prove.
 */
const rangeAccepts = (expression: string, candidate: string): RequirementVerdict => {
  const version = stableVersion(candidate);
  if (version === undefined) return "unassessable";
  const alternatives = expression.split("||");
  let assessable = true;
  for (const alternative of alternatives) {
    const tokens = alternative.trim().split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length === 0) continue;
    const comparators: RangeComparator[] = [];
    for (const token of tokens) {
      const comparator = parseComparator(token);
      if (comparator === undefined) {
        assessable = false;
        break;
      }
      comparators.push(comparator);
    }
    if (!assessable) break;
    if (comparators.every((comparator) => comparatorAccepts(version, comparator)))
      return "satisfied";
  }
  return assessable ? "unsatisfied" : "unassessable";
};

const requirementVerdict = (
  requirement: ModuleUpgradeVersionRequirement,
  candidate: string,
): RequirementVerdict => {
  if (requirement.selection === "exact")
    return requirement.version === candidate ? "satisfied" : "unsatisfied";
  return rangeAccepts(requirement.expression, candidate);
};

const declaredRequirement = (requirement: ModuleUpgradeVersionRequirement): string =>
  requirement.selection === "exact" ? requirement.version : requirement.expression;

const readDependency = (candidate: unknown): ModuleUpgradeDependency | undefined => {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const dependency = candidate as Record<string, unknown>;
  if (
    !isFilled(dependency.dependencyKey) ||
    !isFilled(dependency.moduleRootId) ||
    !isFilled(dependency.moduleKey) ||
    stableVersion(dependency.resolvedVersion) === undefined
  )
    return undefined;
  const version = dependency.version;
  if (typeof version !== "object" || version === null) return undefined;
  const requirement = version as Record<string, unknown>;
  if (requirement.selection === "exact") {
    if (stableVersion(requirement.version) === undefined) return undefined;
    return Object.freeze({
      dependencyKey: dependency.dependencyKey,
      moduleRootId: dependency.moduleRootId,
      moduleKey: dependency.moduleKey,
      resolvedVersion: dependency.resolvedVersion,
      version: Object.freeze({ selection: "exact" as const, version: requirement.version }),
    }) as ModuleUpgradeDependency;
  }
  if (requirement.selection !== "allowed_range" || !isFilled(requirement.expression))
    return undefined;
  return Object.freeze({
    dependencyKey: dependency.dependencyKey,
    moduleRootId: dependency.moduleRootId,
    moduleKey: dependency.moduleKey,
    resolvedVersion: dependency.resolvedVersion,
    version: Object.freeze({
      selection: "allowed_range" as const,
      expression: requirement.expression,
    }),
  }) as ModuleUpgradeDependency;
};

const readRelease = (candidate: unknown): ModuleUpgradeRelease => {
  if (typeof candidate !== "object" || candidate === null) invalidInput();
  const release = candidate as Record<string, unknown>;
  if (
    !isFilled(release.moduleRootId) ||
    !isFilled(release.definitionKey) ||
    stableVersion(release.releaseVersion) === undefined
  )
    invalidInput();
  const content = release.content;
  if (typeof content !== "object" || content === null) invalidInput();
  const view = content as Record<string, unknown>;
  if (
    !Array.isArray(view.dependencies) ||
    !Array.isArray(view.recordTypes) ||
    !Array.isArray(view.actions) ||
    !Array.isArray(view.extensionPoints)
  )
    invalidInput();
  const dependencyKeys = new Set<string>();
  const dependencies: ModuleUpgradeDependency[] = [];
  for (const entry of view.dependencies as readonly unknown[]) {
    const dependency = readDependency(entry);
    if (dependency === undefined) invalidInput();
    if (dependencyKeys.has(dependency.dependencyKey)) invalidInput();
    dependencyKeys.add(dependency.dependencyKey);
    dependencies.push(dependency);
  }
  return Object.freeze({
    moduleRootId: release.moduleRootId,
    definitionKey: release.definitionKey,
    releaseVersion: release.releaseVersion,
    content: Object.freeze({
      dependencies: Object.freeze(dependencies),
      recordTypes: view.recordTypes as ModuleUpgradeReleaseContent["recordTypes"],
      actions: view.actions as ModuleUpgradeReleaseContent["actions"],
      extensionPoints: view.extensionPoints as ModuleUpgradeReleaseContent["extensionPoints"],
    }),
  });
};

const readBinding = (candidate: unknown): InstalledExtensionBinding => {
  if (typeof candidate !== "object" || candidate === null) invalidInput();
  const binding = candidate as Record<string, unknown>;
  if (
    !isFilled(binding.contributionId) ||
    !isFilled(binding.contributorModuleRootId) ||
    !isFilled(binding.contributorReleaseVersion) ||
    !isFilled(binding.targetModuleRootId) ||
    !isFilled(binding.targetModuleReleaseVersion) ||
    !isFilled(binding.targetExtensionPointId) ||
    !isFilled(binding.targetRecordTypeId)
  )
    invalidInput();
  if (binding.kind === "field") {
    if (!isFilled(binding.recordTypeId) || !isFilled(binding.fieldId)) invalidInput();
    return Object.freeze({
      kind: "field" as const,
      contributionId: binding.contributionId,
      contributorModuleRootId: binding.contributorModuleRootId,
      contributorReleaseVersion: binding.contributorReleaseVersion,
      targetModuleRootId: binding.targetModuleRootId,
      targetModuleReleaseVersion: binding.targetModuleReleaseVersion,
      targetExtensionPointId: binding.targetExtensionPointId,
      targetRecordTypeId: binding.targetRecordTypeId,
      recordTypeId: binding.recordTypeId,
      fieldId: binding.fieldId,
    });
  }
  if (binding.kind === "action") {
    if (!isFilled(binding.actionId)) invalidInput();
    return Object.freeze({
      kind: "action" as const,
      contributionId: binding.contributionId,
      contributorModuleRootId: binding.contributorModuleRootId,
      contributorReleaseVersion: binding.contributorReleaseVersion,
      targetModuleRootId: binding.targetModuleRootId,
      targetModuleReleaseVersion: binding.targetModuleReleaseVersion,
      targetExtensionPointId: binding.targetExtensionPointId,
      targetRecordTypeId: binding.targetRecordTypeId,
      actionId: binding.actionId,
    });
  }
  return invalidInput();
};

const readReleaseSet = (candidates: readonly unknown[]): Map<string, ModuleUpgradeRelease> => {
  const byRootId = new Map<string, ModuleUpgradeRelease>();
  for (const candidate of candidates) {
    const release = readRelease(candidate);
    if (byRootId.has(release.moduleRootId)) invalidInput();
    byRootId.set(release.moduleRootId, release);
  }
  return byRootId;
};

const contributionFieldExists = (
  content: ModuleUpgradeReleaseContent,
  recordTypeId: string,
  fieldId: string,
): boolean =>
  content.recordTypes.some(
    (recordType) =>
      String(recordType.recordTypeId) === recordTypeId &&
      recordType.fields.some((field) => String(field.fieldId) === fieldId),
  );

const contributionIdentityIsField = (
  content: ModuleUpgradeReleaseContent,
  identity: string,
): boolean =>
  content.recordTypes.some((recordType) =>
    recordType.fields.some((field) => String(field.fieldId) === identity),
  );

const contributionIdentityIsAction = (
  content: ModuleUpgradeReleaseContent,
  identity: string,
): boolean => content.actions.some((action) => String(action.actionId) === identity);

/**
 * Plans the adoption of one exact installed Module release set into another.
 *
 * `adoptedReleases` is the complete set that would remain installed, so a
 * Module absent from it is uninstalled by the adoption and a Module present in
 * both sets is carried at its exact release. The plan is compatible only when
 * every declared dependency of every adopted release names an adopted release
 * whose exact version satisfies that declaration, and every installed
 * contribution still resolves inside the adopted set.
 *
 * A contributor that pins an exact target version therefore has to be
 * republished with a widened requirement before that target can be adopted,
 * which is the ordinary version-impact major change. A carried release is never
 * asked to re-resolve: its own recorded resolution stays historical evidence and
 * only the declaration decides. A declaration the closed range grammar cannot
 * prove refuses rather than admitting a version it did not check.
 *
 * A refusal reports every violated location, ordered independently of input
 * order, and never mutates anything.
 */
export const planModuleExtensionUpgrade = (
  input: ModuleExtensionUpgradeInput,
): ModuleExtensionUpgradeOutcome => {
  if (typeof input !== "object" || input === null) invalidInput();
  if (!Array.isArray(input.currentReleases)) invalidInput();
  if (!Array.isArray(input.adoptedReleases)) invalidInput();
  if (!Array.isArray(input.installedBindings)) invalidInput();

  const currentByRootId = readReleaseSet(input.currentReleases);
  const adoptedByRootId = readReleaseSet(input.adoptedReleases);

  const bindings: InstalledExtensionBinding[] = [];
  const contributionIds = new Set<string>();
  for (const candidate of input.installedBindings) {
    const binding = readBinding(candidate);
    if (contributionIds.has(binding.contributionId)) invalidInput();
    contributionIds.add(binding.contributionId);
    bindings.push(binding);
  }

  const refusals: ModuleExtensionUpgradeRefusalEntry[] = [];
  const refuse = (entry: ModuleExtensionUpgradeRefusalEntry): void => {
    refusals.push(Object.freeze(entry));
  };

  // Every declared dependency of the adopted set must resolve inside that same
  // set: an explicit upgrade refuses adoption where a required target would be
  // missing, and it never silently retargets a consumer.
  const adoptedReleases = sortedBy(
    [...adoptedByRootId.values()],
    (release) => release.moduleRootId,
  );
  for (const release of adoptedReleases) {
    // A release that is entering the installation published its own resolution
    // against the release this adoption selects, so that resolution must name
    // it. A carried release legitimately names the version it was published
    // against, so there the declared requirement alone decides compatibility.
    const entering =
      currentByRootId.get(release.moduleRootId)?.releaseVersion !== release.releaseVersion;
    const dependencies = sortedBy(release.content.dependencies, (entry) => entry.dependencyKey);
    for (const dependency of dependencies) {
      const selected = adoptedByRootId.get(dependency.moduleRootId);
      if (selected === undefined) {
        refuse({
          code: "dependency_target_missing",
          declaringModuleRootId: release.moduleRootId,
          dependencyKey: dependency.dependencyKey,
          targetModuleRootId: dependency.moduleRootId,
          targetExtensionPointId: null,
          contributionId: null,
          requiredVersion: declaredRequirement(dependency.version),
          selectedVersion: null,
        });
        continue;
      }
      if (selected.definitionKey !== dependency.moduleKey) {
        refuse({
          code: "dependency_target_retyped",
          declaringModuleRootId: release.moduleRootId,
          dependencyKey: dependency.dependencyKey,
          targetModuleRootId: dependency.moduleRootId,
          targetExtensionPointId: null,
          contributionId: null,
          requiredVersion: dependency.moduleKey,
          selectedVersion: selected.definitionKey,
        });
        continue;
      }
      if (entering && dependency.resolvedVersion !== selected.releaseVersion) {
        refuse({
          code: "dependency_resolution_inconsistent",
          declaringModuleRootId: release.moduleRootId,
          dependencyKey: dependency.dependencyKey,
          targetModuleRootId: dependency.moduleRootId,
          targetExtensionPointId: null,
          contributionId: null,
          requiredVersion: dependency.resolvedVersion,
          selectedVersion: selected.releaseVersion,
        });
        continue;
      }
      const verdict = requirementVerdict(dependency.version, selected.releaseVersion);
      if (verdict === "satisfied") continue;
      refuse({
        code:
          verdict === "unassessable"
            ? "dependency_requirement_unassessable"
            : "dependency_requirement_unsatisfied",
        declaringModuleRootId: release.moduleRootId,
        dependencyKey: dependency.dependencyKey,
        targetModuleRootId: dependency.moduleRootId,
        targetExtensionPointId: null,
        contributionId: null,
        requiredVersion: declaredRequirement(dependency.version),
        selectedVersion: selected.releaseVersion,
      });
    }
  }

  const preservedBindings: PreservedExtensionBinding[] = [];
  const retiredBindingIds: string[] = [];
  const orderedBindings = sortedBy(bindings, (binding) => binding.contributionId);
  for (const binding of orderedBindings) {
    const installedContributor = currentByRootId.get(binding.contributorModuleRootId);
    const installedTarget = currentByRootId.get(binding.targetModuleRootId);
    if (installedContributor === undefined || installedTarget === undefined) invalidInput();
    if (
      binding.contributorReleaseVersion !== installedContributor.releaseVersion ||
      binding.targetModuleReleaseVersion !== installedTarget.releaseVersion
    ) {
      refuse({
        code: "installed_binding_evidence_mismatch",
        declaringModuleRootId: binding.contributorModuleRootId,
        dependencyKey: null,
        targetModuleRootId: binding.targetModuleRootId,
        targetExtensionPointId: binding.targetExtensionPointId,
        contributionId: binding.contributionId,
        requiredVersion: binding.targetModuleReleaseVersion,
        selectedVersion: installedTarget.releaseVersion,
      });
      continue;
    }

    const nextContributor = adoptedByRootId.get(binding.contributorModuleRootId);
    // An uninstalled contributor is not a broken upgrade: retention keeps its
    // values, so its binding leaves the installation and #718 detaches it.
    if (nextContributor === undefined) {
      retiredBindingIds.push(binding.contributionId);
      continue;
    }

    const nextTarget = adoptedByRootId.get(binding.targetModuleRootId);
    // A contribution refusal is about an identity, not a version, so it carries
    // no required version and names only the releases it was decided against.
    const refuseBinding = (code: ModuleExtensionUpgradeRefusalCode): void => {
      refuse({
        code,
        declaringModuleRootId: binding.contributorModuleRootId,
        dependencyKey: null,
        targetModuleRootId: binding.targetModuleRootId,
        targetExtensionPointId: binding.targetExtensionPointId,
        contributionId: binding.contributionId,
        requiredVersion: null,
        selectedVersion: nextTarget?.releaseVersion ?? null,
      });
    };
    if (nextTarget === undefined) {
      refuseBinding("contribution_target_missing");
      continue;
    }

    // A contribution attaches to a dependency its own release declares, so an
    // installed binding whose contributor no longer declares that dependency is
    // no longer backed by a declared extension requirement. The dependency loop
    // above has already proved that any declaration it does carry resolves.
    if (
      !nextContributor.content.dependencies.some(
        (dependency) => dependency.moduleRootId === binding.targetModuleRootId,
      )
    ) {
      refuseBinding("contribution_dependency_undeclared");
      continue;
    }

    const point = nextTarget.content.extensionPoints.find(
      (candidate) => String(candidate.extensionPointId) === binding.targetExtensionPointId,
    );
    if (point === undefined) {
      refuseBinding("extension_point_removed");
      continue;
    }
    if (String(point.recordTypeId) !== binding.targetRecordTypeId) {
      refuseBinding("extension_point_retargeted");
      continue;
    }
    const targetRecord = nextTarget.content.recordTypes.find(
      (recordType) => String(recordType.recordTypeId) === String(point.recordTypeId),
    );
    if (targetRecord === undefined) {
      refuseBinding("extension_point_record_removed");
      continue;
    }
    if (!point.accepts.includes(binding.kind)) {
      refuseBinding("extension_point_kind_withdrawn");
      continue;
    }

    if (binding.kind === "field") {
      if (
        !contributionFieldExists(
          nextContributor.content,
          binding.recordTypeId,
          binding.fieldId,
        )
      ) {
        refuseBinding(
          contributionIdentityIsAction(nextContributor.content, binding.contributionId)
            ? "contributed_component_retyped"
            : "contributed_component_removed",
        );
        continue;
      }
      if (targetRecord.fields.some((field) => String(field.fieldId) === binding.contributionId)) {
        refuseBinding("contributed_identity_claimed");
        continue;
      }
      preservedBindings.push(
        Object.freeze({
          kind: "field" as const,
          contributionId: binding.contributionId,
          contributorModuleRootId: binding.contributorModuleRootId,
          contributorReleaseVersion: nextContributor.releaseVersion,
          targetModuleRootId: binding.targetModuleRootId,
          targetModuleReleaseVersion: nextTarget.releaseVersion,
          targetExtensionPointId: binding.targetExtensionPointId,
          targetRecordTypeId: binding.targetRecordTypeId,
          recordTypeId: binding.recordTypeId,
          fieldId: binding.fieldId,
        }),
      );
      continue;
    }

    if (!contributionIdentityIsAction(nextContributor.content, binding.contributionId)) {
      refuseBinding(
        contributionIdentityIsField(nextContributor.content, binding.contributionId)
          ? "contributed_component_retyped"
          : "contributed_component_removed",
      );
      continue;
    }
    if (
      nextTarget.content.actions.some(
        (action) => String(action.actionId) === binding.contributionId,
      )
    ) {
      refuseBinding("contributed_identity_claimed");
      continue;
    }
    preservedBindings.push(
      Object.freeze({
        kind: "action" as const,
        contributionId: binding.contributionId,
        contributorModuleRootId: binding.contributorModuleRootId,
        contributorReleaseVersion: nextContributor.releaseVersion,
        targetModuleRootId: binding.targetModuleRootId,
        targetModuleReleaseVersion: nextTarget.releaseVersion,
        targetExtensionPointId: binding.targetExtensionPointId,
        targetRecordTypeId: binding.targetRecordTypeId,
        actionId: binding.actionId,
      }),
    );
  }

  const transitions = sortedBy(
    adoptedReleases
      .filter(
        (release) =>
          currentByRootId.get(release.moduleRootId)?.releaseVersion !== release.releaseVersion,
      )
      .map((release) => {
        const installed = currentByRootId.get(release.moduleRootId);
        return Object.freeze({
          moduleRootId: release.moduleRootId,
          definitionKey: release.definitionKey,
          fromReleaseVersion: installed?.releaseVersion ?? null,
          toReleaseVersion: release.releaseVersion,
        });
      }),
    (transition) => transition.moduleRootId,
  );

  if (refusals.length === 0) {
    const plan = {
      outcome: "compatible" as const,
      releases: Object.freeze(transitions),
      preservedBindings: Object.freeze(
        sortedBy(preservedBindings, (binding) => binding.contributionId),
      ),
      retiredBindingIds: Object.freeze([...retiredBindingIds].sort(compareStrings)),
    };
    return Object.freeze({ ...plan, fingerprint: fingerprint(plan) });
  }

  const refusal = {
    outcome: "refused" as const,
    releases: Object.freeze(transitions),
    refusals: Object.freeze(
      sortedBy(refusals, (entry) =>
        canonicalJson([
          entry.code,
          entry.declaringModuleRootId,
          entry.dependencyKey,
          entry.targetModuleRootId,
          entry.targetExtensionPointId,
          entry.contributionId,
        ]),
      ),
    ),
  };
  return Object.freeze({ ...refusal, fingerprint: fingerprint(refusal) });
};
