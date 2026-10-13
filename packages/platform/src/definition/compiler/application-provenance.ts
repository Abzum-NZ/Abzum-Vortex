import type {
  ApplicationDraft,
  CompiledFlowSet,
  ApplicationSourceDocument,
  DefinitionProvenanceEntry,
} from "../../schema";
import { canonicalJson } from "../canonical-json-definition";
import { explicitSourceTargets } from "./explicit-source-targets";
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
import {
  conditionSourceTargets,
  isInterfaceOperationFlowTargetPath,
} from "./source-target-helpers";

const applicationSpecialRoot = (path: Path): boolean =>
  path[0] === "body" &&
  (path[1] === "platform_block_dependencies" ||
    path[1] === "shells" ||
    path[1] === "theme" ||
    (path[1] === "pages" && path.includes("composition")));

const applicationThemeValueTargets = (
  sourcePath: Path,
  sourceValueRoot: Path,
  canonicalRoot: Path,
): Path[] => {
  const suffix = sourcePath.slice(sourceValueRoot.length);
  const mapped = suffix.map((segment) =>
    typeof segment === "string"
      ? ((
          {
            size_rem: "sizeRem",
            line_height: "lineHeight",
            width_rem: "widthRem",
            color_token: "colorToken",
            asset_id: "assetId",
          } as Readonly<Record<string, string>>
        )[segment] ?? segment)
      : segment,
  );
  return [[...canonicalRoot, ...mapped]];
};

const applicationPropertyValueTargets = (
  source: ApplicationSourceDocument,
  sourcePath: Path,
  sourceValueRoot: Path,
  canonicalRoot: Path,
): Path[] => {
  const suffix = sourcePath.slice(sourceValueRoot.length);
  if (suffix[0] === "kind") return [[...canonicalRoot, "kind"]];
  const leaf = String(suffix.at(-1));
  const valueKind = String(asObject(valueAtPath(source, sourcePath.slice(0, -1))).kind);
  const valueLeaf: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    asset_reference: { asset_id: "assetId" },
    icon: { icon_key: "iconKey" },
    theme_token: { token: "tokenKey" },
    field_reference: { field: "fieldId" },
    relationship_reference: { relationship: "relationshipId" },
    action_reference: { action: "actionKey" },
    page_reference: { page: "pageId" },
    query_reference: { query: "queryId" },
    pipeline_reference: { pipeline: "pipelineId" },
    record_reference: { record_id: "recordId" },
  };
  if (
    leaf === "record_type" &&
    (valueKind === "record_type_reference" || valueKind === "record_reference")
  ) {
    const target = [...canonicalRoot, ...suffix.slice(0, -1), "recordType"] as Path;
    return [
      [...target, "state"],
      [...target, "moduleRootId"],
      [...target, "recordTypeId"],
    ];
  }
  return [
    [...canonicalRoot, ...suffix.slice(0, -1), valueLeaf[valueKind]?.[leaf] ?? suffix.at(-1)!],
  ];
};

function applicationSlotSourceTargets(
  source: ApplicationSourceDocument,
  sourcePath: Path,
  sourceSlotRoot: Path,
  canonicalSlotRoot: Path,
  resolution: Resolution,
): Path[] | undefined {
  let sourceRoot = sourceSlotRoot;
  let canonicalRoot = canonicalSlotRoot;
  while (true) {
    const suffix = sourcePath.slice(sourceRoot.length);
    if (suffix[0] === "order" && typeof suffix[1] === "string") {
      const authoredOrder = asObject(valueAtPath(source, sourceRoot)).order as JsonObject;
      const breakpoint = suffix[1];
      const inherited = [
        breakpoint,
        ...(breakpoint === "desktop" && authoredOrder.tablet === undefined ? ["tablet"] : []),
        ...((
          breakpoint === "desktop"
            ? authoredOrder.tablet === undefined && authoredOrder.phone === undefined
            : breakpoint === "tablet" && authoredOrder.phone === undefined
        )
          ? ["phone"]
          : []),
      ];
      return inherited.map((target) => [...canonicalRoot, "order", target, ...suffix.slice(2)]);
    }
    if (suffix[0] !== "placements" || typeof suffix[1] !== "string") return undefined;
    const alias = suffix[1];
    sourceRoot = [...sourceRoot, "placements", alias];
    canonicalRoot = [
      ...canonicalRoot,
      "placements",
      resolution.id(source.key, "block_placement", alias, "content"),
    ];
    const placementSuffix = sourcePath.slice(sourceRoot.length);
    const property = placementSuffix[0];
    if (property === "slots" && typeof placementSuffix[1] === "string") {
      sourceRoot = [...sourceRoot, "slots", placementSuffix[1]];
      canonicalRoot = [...canonicalRoot, "slots", placementSuffix[1]];
      continue;
    }
    if (property === "block")
      return [
        [
          ...canonicalRoot,
          "block",
          placementSuffix[1] === "block_id" ? "blockId" : "releaseVersion",
        ],
      ];
    if (property === "view_permission") return [[...canonicalRoot, "viewPermissionKey"]];
    if (property === "use_permission") return [[...canonicalRoot, "usePermissionKey"]];
    if (property === "query") return [[...canonicalRoot, "queryId"]];
    if (property === "read_model") return [[...canonicalRoot, "readModel", "key"]];
    if (property === "visibility_condition")
      return conditionSourceTargets(source as unknown as JsonObject, sourcePath, {
        sourceRoot: [...sourceRoot, "visibility_condition"],
        canonicalRoot: [...canonicalRoot, "visibilityCondition"],
      });
    if (
      property === "responsive" &&
      typeof placementSuffix[1] === "string" &&
      typeof placementSuffix[2] === "string"
    ) {
      const responsive = asObject(asObject(valueAtPath(source, sourceRoot)).responsive);
      const breakpoint = placementSuffix[1];
      const inherited = [
        breakpoint,
        ...(breakpoint === "desktop" && responsive.tablet === undefined ? ["tablet"] : []),
        ...((
          breakpoint === "desktop"
            ? responsive.tablet === undefined && responsive.phone === undefined
            : breakpoint === "tablet" && responsive.phone === undefined
        )
          ? ["phone"]
          : []),
      ];
      return inherited.map((target) => [
        ...canonicalRoot,
        "responsive",
        target,
        ...placementSuffix
          .slice(2)
          .map((segment) => (segment === "start_column" ? "startColumn" : segment)),
      ]);
    }
    if (property === "theme_overrides" && typeof placementSuffix[1] === "string")
      return applicationThemeValueTargets(
        sourcePath,
        [...sourceRoot, "theme_overrides", placementSuffix[1]],
        [...canonicalRoot, "themeOverrides", placementSuffix[1]],
      );
    if (property === "settings" && typeof placementSuffix[1] === "string")
      return applicationPropertyValueTargets(
        source,
        sourcePath,
        [...sourceRoot, "settings", placementSuffix[1]],
        [...canonicalRoot, "settings", placementSuffix[1]],
      );
    return undefined;
  }
}

function applicationSpecialSourceTargets(
  source: ApplicationSourceDocument,
  sourcePath: Path,
  resolution: Resolution,
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
    if (sourcePath[2] === "token_overrides" && typeof sourcePath[3] === "string")
      return applicationThemeValueTargets(
        sourcePath,
        ["body", "theme", "token_overrides", sourcePath[3]],
        ["content", "theme", "tokens", sourcePath[3]],
      );
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
    if (sourcePath[3] === "layout")
      return applicationSlotSourceTargets(
        source,
        sourcePath,
        ["body", "shells", sourcePath[2], "layout"],
        [...shellRoot, "layout"],
        resolution,
      );
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
  if (
    sourcePath[1] === "pages" &&
    typeof sourcePath[2] === "number" &&
    sourcePath[3] === "composition"
  ) {
    const page = source.body.pages[sourcePath[2]];
    if (page === undefined) return undefined;
    const composition = page.composition;
    const root: Path = ["content", "pages", sourcePath[2], "composition"];
    if (sourcePath[4] === "shell_kind") return [[...root, "shellKind"]];
    if (sourcePath[4] === "shell") return [[...root, "shellId"]];
    if (sourcePath[4] === "main")
      return applicationSlotSourceTargets(
        source,
        sourcePath,
        ["body", "pages", sourcePath[2], "composition", "main"],
        [...root, "main"],
        resolution,
      );
    if (sourcePath[4] === "content" && typeof sourcePath[5] === "string") {
      const slotAlias = sourcePath[5];
      return applicationSlotSourceTargets(
        source,
        sourcePath,
        ["body", "pages", sourcePath[2], "composition", "content", slotAlias],
        [...root, "content", resolution.id(source.key, "shell_content_slot", slotAlias, "content")],
        resolution,
      );
    }
    if (sourcePath[4] === "step_content" && typeof sourcePath[5] === "string") {
      const stepAlias = sourcePath[5];
      const stepId = resolution.id(source.key, "guided_step", stepAlias, "page:" + page.key);
      if (composition.shell_kind === "default")
        return applicationSlotSourceTargets(
          source,
          sourcePath,
          ["body", "pages", sourcePath[2], "composition", "step_content", stepAlias],
          [...root, "stepContent", stepId],
          resolution,
        );
      if (typeof sourcePath[6] !== "string") return undefined;
      const slotAlias = sourcePath[6];
      return applicationSlotSourceTargets(
        source,
        sourcePath,
        ["body", "pages", sourcePath[2], "composition", "step_content", stepAlias, slotAlias],
        [
          ...root,
          "stepContent",
          stepId,
          resolution.id(source.key, "shell_content_slot", slotAlias, "content"),
        ],
        resolution,
      );
    }
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
  canonical.content.flowBindings.forEach((binding, index) => {
    const authored = source.body.flow_bindings[index]!;
    const canonicalBase: Path = ["content", "flowBindings", index];
    const sourceBase: Path = ["body", "flow_bindings", index];
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
        ...(canonicalJson(sourceValue) === canonicalJson(canonicalValue)
          ? {}
          : { ruleCode: TRANSFORM_RULE }),
      });
    }
  });
  return entries;
}

export function applicationProvenance(
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
    const targets = applicationSpecialRoot(sourcePath)
      ? applicationSpecialSourceTargets(source, sourcePath, resolution)
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
      const transformed =
        canonicalJson(valueAtPath(source, sourcePath)) !==
        canonicalJson(valueAtPath(canonical, canonicalPath));
      // A table behaviour's authored event alias resolves to the exact identity used by its
      // compiled flow binding. No other text setting is allowed to change during compilation.
      const eventSettingReference =
        sourcePath.includes("settings") &&
        sourcePath.at(-2) === "event_id" &&
        sourcePath.at(-1) === "value" &&
        valueAtPath(canonical, canonicalPath) ===
          resolution.id(source.key, "event", String(valueAtPath(source, sourcePath)), "content");
      if (
        transformed &&
        !eventSettingReference &&
        !sourceTransformationApproved(sourcePath, canonicalPath, positions)
      ) {
        fail("vortex.definition.invalid_compilation_output", "invalid_value");
      }
      const pageReference =
        sourcePath[0] === "body" &&
        sourcePath[1] === "pages" &&
        typeof sourcePath[2] === "number" &&
        ["permission", "public_action"].includes(String(sourcePath.at(-1)));
      const sourceParentValue = valueAtPath(source, sourcePath.slice(0, -1));
      const sourceParent =
        sourceParentValue !== null &&
        typeof sourceParentValue === "object" &&
        !Array.isArray(sourceParentValue)
          ? (sourceParentValue as JsonObject)
          : undefined;
      const propertyReferenceLeaf: Readonly<Record<string, string>> = {
        action_reference: "action",
        field_reference: "field",
        page_reference: "page",
        pipeline_reference: "pipeline",
        query_reference: "query",
        record_reference: "record_type",
        record_type_reference: "record_type",
        relationship_reference: "relationship",
        theme_token: "token",
      };
      const propertyReference =
        sourceParent !== undefined &&
        propertyReferenceLeaf[String(sourceParent.kind)] === String(sourcePath.at(-1));
      const compositionReference =
        applicationSpecialRoot(sourcePath) &&
        (["shell", "parent_placement", "view_permission", "use_permission"].includes(
          String(sourcePath.at(-1)),
        ) ||
          propertyReference);
      const resolved =
        sourceResolvesIdentity(sourcePath, positions) ||
        recordScopeSourceResolvesIdentity(sourcePath) ||
        fieldPolicySourceResolvesIdentity(sourcePath) ||
        isInterfaceOperationFlowTargetPath(sourceObject, sourcePath) ||
        pageReference ||
        compositionReference ||
        eventSettingReference ||
        (applicationSpecialRoot(sourcePath) &&
          sourcePath.includes("order") &&
          typeof sourcePath.at(-1) === "number");
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
    const placementsIndex = canonicalPath.lastIndexOf("placements");
    if (placementsIndex >= 0 && canonicalPath.includes("settings")) {
      const placement = asObject(
        valueAtPath(canonical, canonicalPath.slice(0, placementsIndex + 2)),
      );
      const block = asObject(placement.block);
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
