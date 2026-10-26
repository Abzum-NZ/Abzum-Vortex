import type { DefinitionRuleFailure } from "../../catalogue/validation-errors";
import type { VersionRequirement } from "../definitions";
import { fingerprintCanonicalValue } from "../canonical-json-definition";
import { type DefinitionSetValidationContext, allValidationOutputs, type Output } from "./context";
import { outputKey, pathKey, failure, object, array } from "./helpers";
import { leafPaths } from "./source-paths";
import { versionRequirementAccepts } from "./publication-rules";

export function provenanceRule(context: DefinitionSetValidationContext): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  for (const [index, output] of context.outputs.entries()) {
    const request =
      context.requests.find((candidate) => candidate.source.key === outputKey(output)) ??
      context.requests[index];
    const representedSourcePaths = new Set(
      output.provenance.flatMap((entry) =>
        entry.sourcePath === undefined ? [] : [pathKey(entry.sourcePath)],
      ),
    );
    const representedCanonicalPaths = new Set(
      output.provenance.map((entry) => pathKey(entry.canonicalPath)),
    );
    const sourceLeafPaths = leafPaths(request?.source);
    const expectedSourcePaths = request
      ? sourceLeafPaths.filter(
          (path) =>
            !(path.length === 1 && (path[0] === "source_contract_version" || path[0] === "kind")),
        )
      : [];
    const expectedCanonicalPaths = leafPaths(output.canonical);
    const sourceLeafKeys = new Set(sourceLeafPaths.map(pathKey));
    const canonicalLeafKeys = new Set(expectedCanonicalPaths.map(pathKey));
    const entriesAreTraceable = output.provenance.every((entry) => {
      const sourcePathIsLeaf =
        entry.sourcePath === undefined || sourceLeafKeys.has(pathKey(entry.sourcePath));
      const canonicalPathExists =
        canonicalLeafKeys.has(pathKey(entry.canonicalPath)) ||
        entry.ruleCode === "vortex.definition.semantic_transform" ||
        entry.ruleCode === "vortex.definition.immutable_resolution";
      const transformedContainerIsDeclared =
        canonicalLeafKeys.has(pathKey(entry.canonicalPath)) ||
        entry.ruleCode === "vortex.definition.semantic_transform" ||
        entry.ruleCode === "vortex.definition.immutable_resolution";
      return sourcePathIsLeaf && canonicalPathExists && transformedContainerIsDeclared;
    });
    const sourceComplete = expectedSourcePaths.every((path) =>
      representedSourcePaths.has(pathKey(path)),
    );
    const canonicalComplete = expectedCanonicalPaths.every((path) =>
      representedCanonicalPaths.has(pathKey(path)),
    );
    if (!request || !sourceComplete || !canonicalComplete || !entriesAreTraceable)
      failures.push(failure(output, "vortex.definition.provenance_complete", "invalid_value"));
  }
  return failures;
}

export function dependencyRule(context: DefinitionSetValidationContext): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  const modules = new Map(
    allValidationOutputs(context)
      .filter((output) => output.kind === "module")
      .map((output) => {
        const canonical = object(output.canonical);
        return [String(object(canonical.envelope).rootId), output] as const;
      }),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (rootId: string, output: Output) => {
    if (visiting.has(rootId)) {
      failures.push(
        failure(output, "vortex.definition.module_dependency_acyclic", "dependency_cycle"),
      );
      return;
    }
    if (visited.has(rootId)) return;
    visiting.add(rootId);
    const request = context.requests.find(
      (candidate) => candidate.source.key === output.artifact.definitionKey,
    );
    const canonicalDependencies = array(object(object(output.canonical).content).dependencies);
    const recordedDependencies = output.resolvedDependencies.filter(
      (dependency) => dependency.kind === "module",
    );
    if (
      recordedDependencies.length !== canonicalDependencies.length ||
      output.resolvedDependencies.length !== canonicalDependencies.length
    )
      failures.push(
        failure(output, "vortex.definition.module_dependency_resolved", "unresolved_reference"),
      );
    for (const dependency of canonicalDependencies) {
      const target = modules.get(String(dependency.moduleRootId));
      const snapshotDefinition = request?.resolution.definitions.find(
        (candidate) =>
          candidate.kind === "module" && candidate.key === String(dependency.moduleKey),
      );
      const recorded = recordedDependencies.filter(
        (candidate) =>
          candidate.key === dependency.moduleKey &&
          candidate.rootId === dependency.moduleRootId &&
          candidate.exactVersion === dependency.resolvedVersion,
      );
      const targetContent =
        target?.kind === "module" ? object(object(target.canonical).content) : undefined;
      const exactBinding =
        target?.kind === "module" &&
        (request === undefined ||
          (snapshotDefinition !== undefined &&
            snapshotDefinition.rootId === dependency.moduleRootId &&
            snapshotDefinition.exactVersion === dependency.resolvedVersion)) &&
        versionRequirementAccepts(
          dependency.version as VersionRequirement,
          String(dependency.resolvedVersion),
        ) &&
        recorded.length === 1 &&
        target.artifact.definitionKey === dependency.moduleKey &&
        target.artifact.rootId === dependency.moduleRootId &&
        target.artifact.exactVersion === dependency.resolvedVersion &&
        target.artifact.contentFingerprint === fingerprintCanonicalValue(targetContent) &&
        target.artifact.resolutionFingerprint === target.resolutionFingerprint;
      if (!exactBinding)
        failures.push(
          failure(output, "vortex.definition.module_dependency_resolved", "unresolved_reference"),
        );
      else if (
        context.requests.some((candidate) => candidate.source.key === target.artifact.definitionKey)
      )
        visit(String(dependency.moduleRootId), target);
    }
    visiting.delete(rootId);
    visited.add(rootId);
  };
  for (const output of context.outputs.filter((entry) => entry.kind === "module")) {
    const rootId = String(object(object(output.canonical).envelope).rootId);
    visit(rootId, output);
  }
  return failures;
}
