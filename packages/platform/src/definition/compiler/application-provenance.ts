import type {
  ApplicationDraft,
  CompiledFlowSet,
  ApplicationSourceDocument,
  DefinitionProvenanceEntry,
  PlatformBlockRelease,
} from "../../schema";
import { sameCanonicalValue } from "../canonical-json-definition";
import { peopleDirectory } from "../module-links";
import { explicitSourceTargets } from "./explicit-source-targets";
import { compiledSourceFlowBindings } from "./application-flow-binding-sources";
import {
  applicationCompositionProvenance,
  compiledSettingStart,
  isApplicationCompositionSourcePath,
} from "./application-composition-provenance";
import {
  applicationTypedValueTarget,
  fieldPolicySourceResolvesIdentity,
  isSystemCanonicalPath,
  recordScopeSourceResolvesIdentity,
  sourceResolvesIdentity,
  sourceTransformationApproved,
} from "./provenance";
import type { Resolution } from "./resolution";
import {
  asObject,
  camelCase,
  fail,
  type JsonObject,
  leafPaths,
  type Path,
  pathKey,
  RESOLUTION_RULE,
  SYSTEM_RULE,
  TRANSFORM_RULE,
  valueAtPath,
} from "./shared";
import { sourceContractPositions, sourceToCanonicalPath } from "./source-paths";
import { isInterfaceOperationFlowTargetPath } from "./source-target-helpers";

/** A compiled layout leaf: inside a shell's layout or a page's composition. */
const isApplicationCompositionCanonicalPath = (path: Path): boolean =>
  path[0] === "content" &&
  typeof path[2] === "number" &&
  ((path[1] === "shells" && path[3] === "layout") ||
    (path[1] === "pages" && path[3] === "composition"));

const applicationSpecialRoot = (path: Path): boolean =>
  path[0] === "body" &&
  (path[1] === "platform_block_dependencies" ||
    path[1] === "shells" ||
    path[1] === "theme" ||
    (path[1] === "pages" && path.includes("composition")));

function applicationSpecialSourceTargets(
  source: ApplicationSourceDocument,
  sourcePath: Path,
): Path[] | undefined {
  if (sourcePath[1] === "platform_block_dependencies" && typeof sourcePath[2] === "number")
    return [
      [
        "content",
        "platformBlockDependencies",
        sourcePath[2],
        ...sourcePath.slice(3).map((segment) => camelCase(String(segment))),
      ],
    ];
  if (sourcePath[1] === "theme") {
    if (sourcePath[2] === "base")
      return [
        [
          "content",
          "theme",
          "base",
          ...sourcePath.slice(3).map((segment) => camelCase(String(segment))),
        ],
      ];
    if (sourcePath[2] === "selection")
      return [
        [
          "content",
          "theme",
          "selection",
          ...sourcePath.slice(3).map((segment) => camelCase(String(segment))),
        ],
      ];
    if (sourcePath[2] === "loader_mark")
      return [
        [
          "content",
          "theme",
          "loaderMark",
          ...sourcePath
            .slice(3)
            .map((segment) => (typeof segment === "number" ? segment : camelCase(segment))),
        ],
      ];
  }
  if (sourcePath[1] === "shells" && typeof sourcePath[2] === "number") {
    const shell = source.body.shells[sourcePath[2]];
    if (shell === undefined) return undefined;
    const shellRoot: Path = ["content", "shells", sourcePath[2]];
    if (sourcePath[3] === "presentation")
      return [
        [
          ...shellRoot,
          "presentation",
          ...sourcePath.slice(4).map((segment) => camelCase(String(segment))),
        ],
      ];
    if (
      sourcePath[3] === "content_slots" &&
      typeof sourcePath[4] === "number" &&
      typeof sourcePath[5] === "string"
    ) {
      const key: Readonly<Record<string, string>> = {
        id: "slotId",
        allowed_child_categories: "allowedChildCategories",
        parent_placement: "parentPlacementId",
        parent_slot: "parentSlotKey",
      };
      return [
        [
          ...shellRoot,
          "contentSlots",
          sourcePath[4],
          key[sourcePath[5]] ?? camelCase(sourcePath[5]),
          ...sourcePath.slice(6),
        ],
      ];
    }
    if (sourcePath[3] === "id") return [[...shellRoot, "shellId"]];
    if (typeof sourcePath[3] === "string") return [[...shellRoot, camelCase(sourcePath[3])]];
  }
  return undefined;
}

/**
 * The provenance of an Application's flows and flow bindings. The generic pass owns the rest of
 * the content; the flow compiler supplies each flow's exact paths, and a binding's identities
 * are resolved from its aliases while its typed input map is the same value in source and output.
 */
function applicationFlowProvenance(
  source: ApplicationSourceDocument,
  canonical: ApplicationDraft,
  flowSet: CompiledFlowSet,
): DefinitionProvenanceEntry[] {
  const entries: DefinitionProvenanceEntry[] = flowSet.provenance.map((entry) => ({
    ...entry,
    canonicalPath: ["content", "flows", ...entry.canonicalPath],
    ...(entry.sourcePath ? { sourcePath: ["body", "flows", ...entry.sourcePath] } : {}),
  }));
  // The canonical bindings are the authored ones that compile, in authored order.
  const compiled = compiledSourceFlowBindings(source.body as unknown as JsonObject);
  canonical.content.flowBindings.forEach((binding, index) => {
    const authored = compiled[index]! as unknown as (typeof source.body.flow_bindings)[number];
    const authoredIndex = source.body.flow_bindings.indexOf(authored);
    const canonicalBase: Path = ["content", "flowBindings", index];
    const sourceBase: Path = ["body", "flow_bindings", authoredIndex];
    const resolved = (canonicalPath: Path, sourcePath: Path) =>
      entries.push({
        canonicalPath: [...canonicalBase, ...canonicalPath],
        origin: "resolved",
        sourcePath: [...sourceBase, ...sourcePath],
        ruleCode: RESOLUTION_RULE,
      });
    resolved(["bindingId"], ["id"]);
    resolved(["controlId"], ["control"]);
    resolved(["eventId"], ["event_id"]);
    resolved(["flow", "flowId"], ["flow"]);
    entries.push({
      canonicalPath: [...canonicalBase, "event"],
      origin: "source",
      sourcePath: [...sourceBase, "event"],
    });
    for (const leaf of leafPaths(binding.flow.inputs)) {
      const sourceValue = valueAtPath(authored.inputs, leaf);
      const canonicalValue = valueAtPath(binding.flow.inputs, leaf);
      entries.push({
        canonicalPath: [...canonicalBase, "flow", "inputs", ...leaf],
        origin: "source",
        sourcePath: [...sourceBase, "inputs", ...leaf],
        ...(sameCanonicalValue(sourceValue, canonicalValue) ? {} : { ruleCode: TRANSFORM_RULE }),
      });
    }
  });
  return entries;
}

export function applicationProvenance(
  releases: readonly PlatformBlockRelease[],
  fullSource: ApplicationSourceDocument,
  fullCanonical: ApplicationDraft,
  resolution: Resolution,
  flowSet: CompiledFlowSet,
): DefinitionProvenanceEntry[] {
  // The generic pass below sees the content without its flows and bindings, which are traced above.
  const source: ApplicationSourceDocument = {
    ...fullSource,
    body: { ...fullSource.body, flows: [], flow_bindings: [] },
  };
  const canonical = {
    ...fullCanonical,
    content: { ...fullCanonical.content, flows: [], flowBindings: [] },
  };
  const sourceObject = source as unknown as JsonObject;
  const positions = sourceContractPositions(sourceObject);
  const sourceLeaves = leafPaths(source).filter(
    (path) => !(path.length === 1 && (path[0] === "source_contract_version" || path[0] === "kind")),
  );
  const canonicalLeaves = leafPaths(canonical);
  const canonicalLeafSet = new Set(canonicalLeaves.map(pathKey));
  const entries: DefinitionProvenanceEntry[] = [];
  for (const sourcePath of sourceLeaves) {
    if (isApplicationCompositionSourcePath(sourcePath)) {
      entries.push(
        ...applicationCompositionProvenance(
          releases,
          source,
          canonical,
          sourcePath,
          resolution,
          positions,
          canonicalLeafSet,
        ),
      );
      continue;
    }
    const targets = applicationSpecialRoot(sourcePath)
      ? applicationSpecialSourceTargets(source, sourcePath)
      : (explicitSourceTargets(sourceObject, canonical, sourcePath, positions, resolution) ?? [
          sourceToCanonicalPath(sourceObject, canonical, sourcePath, positions),
        ]);
    if (targets === undefined || targets.length === 0) {
      fail("vortex.definition.invalid_compilation_output", "invalid_value");
    }
    for (const targetPath of targets) {
      const canonicalPath = applicationTypedValueTarget(
        sourceObject,
        sourcePath,
        targetPath,
        canonicalLeafSet,
        positions,
      );
      if (!canonicalLeafSet.has(pathKey(canonicalPath))) {
        fail("vortex.definition.invalid_compilation_output", "invalid_value");
      }
      const transformed = !sameCanonicalValue(
        valueAtPath(source, sourcePath),
        valueAtPath(canonical, canonicalPath),
      );
      if (transformed && !sourceTransformationApproved(sourcePath, canonicalPath, positions)) {
        fail("vortex.definition.invalid_compilation_output", "invalid_value");
      }
      const pageReference =
        sourcePath[0] === "body" &&
        sourcePath[1] === "pages" &&
        typeof sourcePath[2] === "number" &&
        ["permission", "public_action"].includes(String(sourcePath.at(-1)));
      const compositionReference =
        applicationSpecialRoot(sourcePath) && sourcePath.at(-1) === "parent_placement";
      const resolved =
        sourceResolvesIdentity(sourcePath, positions) ||
        recordScopeSourceResolvesIdentity(sourcePath) ||
        fieldPolicySourceResolvesIdentity(sourcePath) ||
        isInterfaceOperationFlowTargetPath(sourceObject, sourcePath) ||
        pageReference ||
        compositionReference;
      entries.push({
        canonicalPath,
        origin: resolved ? "resolved" : "source",
        sourcePath,
        ...(resolved
          ? { ruleCode: RESOLUTION_RULE }
          : transformed
            ? { ruleCode: TRANSFORM_RULE }
            : {}),
      });
    }
  }
  const represented = new Set(entries.map((entry) => pathKey(entry.canonicalPath)));
  for (const canonicalPath of canonicalLeaves) {
    if (represented.has(pathKey(canonicalPath))) continue;
    if (isSystemCanonicalPath(canonicalPath)) {
      entries.push({ canonicalPath, origin: "system_metadata", ruleCode: SYSTEM_RULE });
      continue;
    }
    if (canonicalPath[0] === "content" && canonicalPath[1] === "theme") {
      entries.push({
        canonicalPath,
        origin: "resolved",
        sourcePath: ["body", "theme", "base", "release_version"],
        ruleCode: RESOLUTION_RULE,
      });
      continue;
    }
    if (
      canonicalPath[0] === "content" &&
      canonicalPath[1] === "platformBlockDependencies" &&
      typeof canonicalPath[2] === "number"
    ) {
      const dependencyIndex = canonicalPath[2];
      if (source.body.platform_block_dependencies[dependencyIndex] === undefined)
        fail("vortex.definition.application_dependency_manifest", "broken_reference");
      entries.push({
        canonicalPath,
        origin: "resolved",
        sourcePath: ["body", "platform_block_dependencies", dependencyIndex, "release_version"],
        ruleCode: RESOLUTION_RULE,
      });
      continue;
    }
    // A role's people-name grant is derived from its reads of Person links, never authored: it
    // follows from the Application's use of the people directory.
    if (
      canonicalPath[0] === "content" &&
      canonicalPath[1] === "roles" &&
      typeof canonicalPath[2] === "number" &&
      canonicalPath[3] === "permissionKeys" &&
      typeof canonicalPath[4] === "number" &&
      canonicalPath.length === 5 &&
      valueAtPath(canonical, canonicalPath) === peopleDirectory.readPermission
    ) {
      const directoryUse = source.body.uses.findIndex(
        (use) => use.module === peopleDirectory.module,
      );
      const directoryModule = source.body.modules.findIndex(
        (module) => module.key === peopleDirectory.module,
      );
      if (directoryUse < 0 && directoryModule < 0)
        fail("vortex.definition.invalid_compilation_output", "invalid_value");
      entries.push({
        canonicalPath,
        origin: "resolved",
        sourcePath:
          directoryUse >= 0
            ? ["body", "uses", directoryUse, "module"]
            : ["body", "modules", directoryModule, "key"],
        ruleCode: RESOLUTION_RULE,
      });
      continue;
    }
    // A setting the author left out is the release's declared default or a derived value.
    const settingIndex = isApplicationCompositionCanonicalPath(canonicalPath)
      ? compiledSettingStart(canonical, canonicalPath)
      : undefined;
    if (settingIndex !== undefined) {
      const item = asObject(valueAtPath(canonical, canonicalPath.slice(0, settingIndex - 1)));
      const block = asObject(asObject(asObject(item.props).vortex).block);
      const blockId = String(block.blockId);
      const releaseVersion = String(block.releaseVersion);
      const dependencyIndex = source.body.platform_block_dependencies.findIndex(
        (dependency) =>
          String(dependency.block_id) === blockId &&
          String(dependency.release_version) === releaseVersion,
      );
      if (dependencyIndex < 0)
        fail("vortex.definition.application_dependency_manifest", "broken_reference");
      entries.push({
        canonicalPath,
        origin: "resolved",
        sourcePath: ["body", "platform_block_dependencies", dependencyIndex, "release_version"],
        ruleCode: RESOLUTION_RULE,
      });
      continue;
    }
    fail("vortex.definition.invalid_compilation_output", "invalid_value");
  }
  return [...entries, ...applicationFlowProvenance(fullSource, fullCanonical, flowSet)];
}
