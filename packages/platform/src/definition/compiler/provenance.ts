import type { DefinitionProvenanceEntry } from "../definition-provenance";
import { sameCanonicalValue } from "../canonical-json-definition";
import { explicitSourceTargets } from "./explicit-source-targets";
import { moduleReferencePaths } from "../module-dependencies";
import type { Resolution } from "./resolution";
import {
  asObject,
  DEFAULT_RULE,
  fail,
  ID_FIELDS,
  type JsonObject,
  leafPaths,
  type Path,
  pathExists,
  pathKey,
  pathStartsWith,
  RESOLUTION_RULE,
  SYSTEM_RULE,
  TRANSFORM_RULE,
  valueAtPath,
} from "./shared";
import {
  isOpaqueDataPath,
  sourceContractPositions,
  type SourceContractPositions,
  sourceToCanonicalPath,
} from "./source-paths";

/** Match a canonical path suffix template; `#` matches an array index and `**` matches descendants. */
function canonicalTargetMatches(targetPath: Path, target: string): boolean {
  const segments = target.split("/").filter(Boolean);
  if (segments.length === 1 && !["*", "#", "**"].includes(segments[0]!))
    return targetPath.at(-1) === segments[0];
  const matchesFrom = (pathOffset: number, patternOffset: number): boolean => {
    if (patternOffset === segments.length) return pathOffset === targetPath.length;
    const patternSegment = segments[patternOffset]!;
    if (patternSegment === "**") {
      if (patternOffset === segments.length - 1) return true;
      for (let offset = pathOffset; offset <= targetPath.length; offset++)
        if (matchesFrom(offset, patternOffset + 1)) return true;
      return false;
    }
    if (pathOffset >= targetPath.length) return false;
    const value = targetPath[pathOffset];
    if (patternSegment !== "*" && patternSegment !== "#" && patternSegment !== String(value))
      return false;
    if (patternSegment === "#" && typeof value !== "number") return false;
    return matchesFrom(pathOffset + 1, patternOffset + 1);
  };
  for (let offset = 0; offset <= targetPath.length; offset++)
    if (matchesFrom(offset, 0)) return true;
  return false;
}

type ProvenanceTarget = SourceContractPositions["provenanceTargets"][number];
type ProvenanceTargetIndex = Readonly<{
  /** The annotations declared exactly at a source path, by path key. */
  exact: ReadonlyMap<string, readonly ProvenanceTarget[]>;
  /** The annotations that also cover every path below their own. */
  descendants: readonly ProvenanceTarget[];
}>;

/**
 * The provenance annotations of one source, indexed once: the compiler asks about every source
 * leaf, so a scan of every annotation per leaf (each comparing serialised paths) would dominate
 * the compile.
 */
const provenanceTargetIndexes = new WeakMap<SourceContractPositions, ProvenanceTargetIndex>();
const provenanceTargetIndex = (positions: SourceContractPositions): ProvenanceTargetIndex => {
  let index = provenanceTargetIndexes.get(positions);
  if (index === undefined) {
    const exact = new Map<string, ProvenanceTarget[]>();
    for (const target of positions.provenanceTargets) {
      const key = pathKey(target.sourcePath);
      const list = exact.get(key) ?? [];
      list.push(target);
      exact.set(key, list);
    }
    index = {
      exact,
      descendants: positions.provenanceTargets.filter(
        (target) => target.annotation.includeDescendants === true,
      ),
    };
    provenanceTargetIndexes.set(positions, index);
  }
  return index;
};

export function sourceTransformationApproved(
  sourcePath: Path,
  canonicalPath: Path,
  positions: SourceContractPositions,
): boolean {
  const index = provenanceTargetIndex(positions);
  const approves = ({ annotation }: ProvenanceTarget): boolean =>
    annotation.canonicalTargets.some((target) => canonicalTargetMatches(canonicalPath, target));
  return (
    (index.exact.get(pathKey(sourcePath)) ?? []).some(approves) ||
    index.descendants.some(
      (target) => pathStartsWith(sourcePath, target.sourcePath) && approves(target),
    )
  );
}

export function applicationTypedValueTarget(
  source: JsonObject,
  sourcePath: Path,
  targetPath: Path,
  canonicalLeafSet: ReadonlySet<string>,
  positions: SourceContractPositions,
): Path {
  // Only normalized typed-value leaves need remapping; preserve resolved targets
  // and unchanged opaque data, even when their property names look like references.
  if (
    source.kind !== "application" ||
    canonicalLeafSet.has(pathKey(targetPath)) ||
    targetPath.at(-1) !== sourcePath.at(-1) ||
    !["record_type", "record_id", "organization_account_id"].includes(String(sourcePath.at(-1)))
  )
    return targetPath;
  const leaf = String(sourcePath.at(-1));
  const canonicalLeaf =
    leaf === "record_type"
      ? "recordTypeId"
      : leaf === "record_id"
        ? "recordId"
        : "organizationAccountId";
  const candidate = [...targetPath.slice(0, -1), canonicalLeaf];
  return canonicalLeafSet.has(pathKey(candidate)) &&
    sourceTransformationApproved(sourcePath, candidate, positions)
    ? candidate
    : targetPath;
}

export function sourceResolvesIdentity(
  sourcePath: Path,
  positions: SourceContractPositions,
): boolean {
  const normalized = sourcePath.map((segment) => (typeof segment === "number" ? "#" : segment));
  const path = normalized.join("/");
  const last = sourcePath.at(-1);
  const resolvesDynamicMapKey =
    /\/(?:tasks\/#\/properties\/values|sharing_conditions\/#\/publication_tests\/#\/field_values)\/[^/]+\//.test(
      path,
    );
  if (isOpaqueDataPath(positions, sourcePath)) return resolvesDynamicMapKey;
  return (
    path === "root_alias" ||
    path === "body/pages/#/replaces_page" ||
    /^body\/search\/record_types\/#\/(?:title_field|subtitle_field|target_page)$/.test(path) ||
    (typeof last === "string" && ID_FIELDS.has(last)) ||
    /\/(?:custom_actions|before_save_rules|carries|declared_fields|filterable_fields|sortable_fields|public_fields|select|group_by|component_order|relationships|record_types|allowed_child_blocks)\/#$/.test(
      path,
    ) ||
    /\/(?:record_type|source_record_type|to_record_type|target|field|page|query|block|home_page|module|connection_type|workflow|node|relationship|required_permission|sets_choice_field|dependency|extension_point|contributed_action)$/.test(
      path,
    ) ||
    resolvesDynamicMapKey
  );
}

export function recordScopeSourceResolvesIdentity(sourcePath: Path): boolean {
  const normalized = sourcePath.map((segment) => (typeof segment === "number" ? "#" : segment));
  const path = normalized.join("/");
  return (
    /^body\/permissions\/#\/record_scope\/routes\/#\/(?:relationship|source_permission)$/.test(
      path,
    ) || /^body\/permissions\/#\/record_scope\/saved_condition\/condition$/.test(path)
  );
}

export function fieldPolicySourceResolvesIdentity(sourcePath: Path): boolean {
  const path = sourcePath.map((segment) => (typeof segment === "number" ? "#" : segment)).join("/");
  return /^body\/permissions\/#\/field_policy\/(?:readable_fields|changeable_fields)\/#$/.test(
    path,
  );
}

function sourceCombinesResolvedKeyAndValue(sourcePath: Path): boolean {
  const path = sourcePath.map((segment) => (typeof segment === "number" ? "#" : segment)).join("/");
  return /\/(?:tasks\/#\/properties\/values|sharing_conditions\/#\/publication_tests\/#\/field_values)\/[^/]+\//.test(
    path,
  );
}

export function isSystemCanonicalPath(path: Path): boolean {
  if (path[0] !== "envelope") return false;
  const leaf = path.at(-1);
  return leaf !== "rootId" && leaf !== "key";
}

/**
 * A calculation field that does not author its evaluation compiles to a fixed default:
 * stored, or read-time for a deadline or a calculation over a read-time field.
 */
function isCalculationEvaluationDefaultPath(source: JsonObject, path: Path): boolean {
  if (
    source.kind !== "module" ||
    path.length !== 7 ||
    path[0] !== "content" ||
    path[1] !== "recordTypes" ||
    typeof path[2] !== "number" ||
    path[3] !== "fields" ||
    typeof path[4] !== "number" ||
    path[5] !== "settings" ||
    path[6] !== "evaluation"
  )
    return false;
  const field = valueAtPath(source, ["body", "record_types", path[2], "fields", path[4]]);
  if (field === null || typeof field !== "object" || Array.isArray(field)) return false;
  const { type, settings } = field as JsonObject;
  return (
    type === "calculation" &&
    settings !== null &&
    typeof settings === "object" &&
    (settings as JsonObject).evaluation === undefined
  );
}

type SourceProvenanceMapping = {
  canonicalPath: Path;
  origin: "source" | "resolved";
  sourcePath: Path;
  ruleCode?: typeof RESOLUTION_RULE | typeof TRANSFORM_RULE;
};

export function provenanceFor(
  source: unknown,
  canonical: unknown,
  resolution: Resolution,
): DefinitionProvenanceEntry[] {
  const sourceObject = asObject(source);
  const positions = sourceContractPositions(sourceObject);
  const sourceLeafPaths = leafPaths(source).filter(
    (path) => !(path.length === 1 && (path[0] === "source_contract_version" || path[0] === "kind")),
  );
  const canonicalLeafPaths = leafPaths(canonical);
  const canonicalLeafSet = new Set(canonicalLeafPaths.map(pathKey));
  const entries: DefinitionProvenanceEntry[] = [];

  for (const sourcePath of sourceLeafPaths) {
    const explicitTargets = explicitSourceTargets(
      sourceObject,
      canonical,
      sourcePath,
      positions,
      resolution,
    );
    const initialCanonicalPath =
      explicitTargets?.[0] ?? sourceToCanonicalPath(sourceObject, canonical, sourcePath, positions);
    const canonicalPath = applicationTypedValueTarget(
      sourceObject,
      sourcePath,
      initialCanonicalPath,
      canonicalLeafSet,
      positions,
    );
    const mapsToCanonicalLeaf = canonicalLeafSet.has(pathKey(canonicalPath));
    const resolved =
      sourceResolvesIdentity(sourcePath, positions) ||
      recordScopeSourceResolvesIdentity(sourcePath) ||
      fieldPolicySourceResolvesIdentity(sourcePath);
    const transformTargets = explicitTargets
      ? explicitTargets.map((target) =>
          applicationTypedValueTarget(
            sourceObject,
            sourcePath,
            target,
            canonicalLeafSet,
            positions,
          ),
        )
      : mapsToCanonicalLeaf
        ? [canonicalPath]
        : [];
    if (transformTargets.length === 0)
      fail("vortex.definition.invalid_compilation_output", "invalid_value");
    for (const targetPath of transformTargets) {
      const transformed = !sameCanonicalValue(
        valueAtPath(source, sourcePath),
        valueAtPath(canonical, targetPath),
      );
      if (transformed && !sourceTransformationApproved(sourcePath, targetPath, positions)) {
        fail("vortex.definition.invalid_compilation_output", "invalid_value");
      }
      const mapping: SourceProvenanceMapping = {
        canonicalPath: targetPath,
        origin: resolved ? "resolved" : "source",
        sourcePath,
        ...(resolved
          ? { ruleCode: RESOLUTION_RULE }
          : transformed
            ? { ruleCode: TRANSFORM_RULE }
            : {}),
      };
      entries.push(mapping);
      if (resolved && sourceCombinesResolvedKeyAndValue(sourcePath))
        entries.push({
          canonicalPath: targetPath,
          origin: "source",
          sourcePath,
          ruleCode: TRANSFORM_RULE,
        });
    }
    if (sourcePath.at(-1) === "operator" && canonicalPath.at(-1) === "operator") {
      const conditionKindPath = [...canonicalPath.slice(0, -1), "kind"];
      if (pathExists(canonical, conditionKindPath))
        entries.push({
          canonicalPath: conditionKindPath,
          origin: "source",
          sourcePath,
          ruleCode: TRANSFORM_RULE,
        });
    }
    if (sourceObject.kind === "connection_type" && pathKey(sourcePath) === pathKey(["root_alias"]))
      entries.push({
        canonicalPath: ["version"],
        origin: "resolved",
        sourcePath,
        ruleCode: RESOLUTION_RULE,
      });
  }

  // A Module's dependencies are derived from its references, so each traces to the first source
  // leaf that references that Module, resolved to the exact release the compiler bound.
  if (sourceObject.kind === "module") {
    const references = moduleReferencePaths(sourceObject);
    const dependencies = valueAtPath(canonical, ["content", "dependencies"]);
    if (Array.isArray(dependencies))
      dependencies.forEach((dependency, index) => {
        const moduleKey = asObject(dependency).moduleKey;
        const sourcePath = references.get(String(moduleKey))?.[0];
        if (sourcePath === undefined)
          fail("vortex.definition.invalid_compilation_output", "invalid_value");
        for (const canonicalPath of leafPaths(dependency))
          entries.push({
            canonicalPath: ["content", "dependencies", index, ...canonicalPath],
            origin: "resolved",
            sourcePath,
            ruleCode: RESOLUTION_RULE,
          });
      });
  }

  const representedCanonicalPaths = new Set(entries.map((entry) => pathKey(entry.canonicalPath)));
  for (const canonicalPath of canonicalLeafPaths) {
    const canonicalKey = pathKey(canonicalPath);
    if (representedCanonicalPaths.has(canonicalKey)) continue;

    const isSystem = isSystemCanonicalPath(canonicalPath);
    const isPublicationMetadata =
      canonicalPath.at(-1) === "publishedRevision" ||
      canonicalPath.at(-1) === "contractFingerprint";
    const isFixedDefault = isCalculationEvaluationDefaultPath(sourceObject, canonicalPath);
    if (isSystem || isPublicationMetadata || isFixedDefault) {
      entries.push({
        canonicalPath,
        origin: isSystem || isPublicationMetadata ? "system_metadata" : "fixed_default",
        ruleCode: isSystem || isPublicationMetadata ? SYSTEM_RULE : DEFAULT_RULE,
      });
      representedCanonicalPaths.add(canonicalKey);
      continue;
    }
    fail("vortex.definition.invalid_compilation_output", "invalid_value");
  }
  return entries;
}
