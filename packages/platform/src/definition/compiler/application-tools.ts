import { descriptionSchema } from "../../catalogue/common";
import { ruleIdSchema } from "../../catalogue/identifiers";
import type { BlockPropertyValueContract } from "../application-composition/block-property-values";
import {
  compiledItemSettings,
  compiledPageItems,
} from "../application-composition/page-composition";
import type { PlatformBlockRelease } from "../application-composition/platform-block-release";
import type { ApplicationDraft, NavigationItem } from "../application-contracts";
import {
  applicationToolBundleSchema,
  type ApplicationToolBundleInput,
  type ApplicationToolOperationReference,
  type ApplicationToolBundle,
  type ModuleCompilationOutput,
  type DefinitionCompilationOutput,
} from "../definition-compilation-contracts";
import { compareCanonicalStrings } from "../canonical-json-definition";
import { deriveFormCommitActionKeys } from "../form-commit";
import { standardRecordActions } from "./module";
import type { Resolution } from "./resolution";
import { applicationModuleKeysOf, asObject, fail, type JsonObject } from "./shared";
import { moduleQueryBorrowable } from "../module-query-exposure";

type ApplicationToolDraft = ApplicationToolBundleInput["tools"][number];
type ApplicationToolStandardRecordAction = Extract<
  ApplicationToolOperationReference,
  { kind: "standard_record_action" }
>["standardAction"];

const isApplicationToolStandardRecordAction = (
  value: string | undefined,
): value is ApplicationToolStandardRecordAction =>
  value !== undefined && standardRecordActions.has(value);

const applicationToolName = (applicationKey: string, operationKind: string, key: string): string =>
  `${applicationKey}.${operationKind}.${key}`;

/** The first label or help text that is a valid tool description, or no description. */
const applicationToolDescription = (
  ...candidates: readonly (string | undefined)[]
): { description?: string } => {
  for (const candidate of candidates) {
    const parsed = descriptionSchema.safeParse(candidate);
    if (parsed.success) return { description: parsed.data };
  }
  return {};
};

/**
 * Derives the one deterministic agent tool bundle an Application release carries. Every tool maps
 * to exactly one real operation, so repeated buttons, repeated form commits and a declared action
 * reused by a form share a single tool; names are namespaced by the application key and
 * canonically ordered, and each input contract and permission meaning is copied from the owning
 * operation. A bound Module's action or query is described only from that Module's exact bound
 * release output; publication always supplies it, and without it the operation is left out rather
 * than described with an invented contract.
 */
export function compileApplicationToolBundle(
  releases: readonly PlatformBlockRelease[],
  canonical: ApplicationDraft,
  source: JsonObject,
  resolution: Resolution,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): ApplicationToolBundle {
  const applicationKey = String(canonical.envelope.key);
  const content = canonical.content;
  const applicationOwner = {
    kind: "application" as const,
    applicationRootId: String(canonical.envelope.rootId),
  };
  const boundVersions = new Map(
    content.moduleBindings.map((binding) => [
      String(binding.moduleRootId),
      String(binding.resolvedVersion),
    ]),
  );
  const boundModuleOutputs = dependencyOutputs.filter(
    (output): output is ModuleCompilationOutput =>
      output.kind === "module" &&
      boundVersions.get(String(output.artifact.rootId)) === String(output.artifact.exactVersion),
  );
  const moduleActionsByKey = new Map(
    boundModuleOutputs.flatMap((output) =>
      output.canonical.content.actions.map(
        (action) =>
          [String(action.key), { moduleRootId: String(output.artifact.rootId), action }] as const,
      ),
    ),
  );
  const boundModuleKeys = new Set(applicationModuleKeysOf(asObject(source.body)));
  const applicationActionKeys = new Set(content.actions.map((action) => String(action.key)));
  // A named action that an Application one-task entry-point flow calls with the flow's own inputs
  // is reachable through that flow's tool, the same start path a button or an interface uses, so
  // it gets no second, action-targeted tool that would bypass the flow. An action a flow calls
  // among other work, or with fewer inputs than the action declares, keeps its own tool, so no
  // permitted action or input is dropped.
  const flowEntryInputNames = new Map<string, Set<string>[]>();
  for (const flow of content.flows) {
    const [task] = flow.tasks;
    if (
      flow.execution !== "interactive" ||
      flow.tasks.length !== 1 ||
      flow.errors.length > 0 ||
      flow.finally.length > 0 ||
      task?.type !== "operation.call"
    )
      continue;
    const properties = (task as { properties?: Record<string, JsonObject> }).properties;
    const value = properties?.operation;
    if (
      properties?.inputs !== undefined ||
      value?.kind !== "literal" ||
      typeof asObject(value.literal).value !== "string"
    )
      continue;
    const key = String(asObject(value.literal).value);
    flowEntryInputNames.set(key, [
      ...(flowEntryInputNames.get(key) ?? []),
      new Set(Object.keys(flow.inputs)),
    ]);
  }
  const reachedThroughFlow = (actionKey: string, inputs: readonly unknown[]): boolean =>
    (flowEntryInputNames.get(actionKey) ?? []).some((names) =>
      inputs.every((input) => names.has(String(asObject(input).key))),
    );
  const pagesById = new Map(content.pages.map((page) => [String(page.pageId), page]));
  const tools = new Map<string, ApplicationToolDraft>();
  const add = (tool: ApplicationToolDraft): void => {
    if (!tools.has(tool.name)) tools.set(tool.name, tool);
  };
  const actionPermission = { discover: "page_access", use: "operation_permission" } as const;

  for (const action of content.actions)
    if (!reachedThroughFlow(String(action.key), action.inputs))
      add({
        name: applicationToolName(applicationKey, "action", String(action.key)),
        ...applicationToolDescription(action.label),
        inputSchema: { kind: "action_inputs", inputs: action.inputs },
        operation: {
          kind: "action",
          owner: applicationOwner,
          key: action.key,
          actionId: action.actionId,
        },
        permission: actionPermission,
      });

  // Resolved in the same order as the form commit itself: a bound Module's standard record action,
  // then an Application action (already a tool), then a bound Module's named action.
  const addCommittedAction = (
    pageName: string,
    actionKey: string,
    allowStandardRecordAction: boolean,
  ): void => {
    const name = applicationToolName(applicationKey, "action", actionKey);
    const standard = /^(.+)\.([^.]+)\.([^.]+)$/.exec(actionKey);
    const standardAction = standard?.[3];
    if (
      allowStandardRecordAction &&
      standard &&
      isApplicationToolStandardRecordAction(standardAction) &&
      boundModuleKeys.has(standard[1]!)
    ) {
      const recordType = resolution.recordType(`${standard[1]}:${standard[2]}`);
      add({
        name,
        ...applicationToolDescription(pageName),
        inputSchema: { kind: "record_type", recordTypeId: recordType.recordTypeId },
        operation: {
          kind: "standard_record_action",
          key: actionKey,
          moduleRootId: String(recordType.moduleRootId),
          recordTypeId: recordType.recordTypeId,
          standardAction,
        },
        permission: actionPermission,
      });
      return;
    }
    if (applicationActionKeys.has(actionKey)) return;
    const moduleAction = moduleActionsByKey.get(actionKey);
    if (moduleAction === undefined || reachedThroughFlow(actionKey, moduleAction.action.inputs))
      return;
    add({
      name,
      ...applicationToolDescription(moduleAction.action.label, pageName),
      inputSchema: { kind: "module_inputs", inputs: moduleAction.action.inputs },
      operation: {
        kind: "action",
        owner: { kind: "module", moduleRootId: moduleAction.moduleRootId },
        key: actionKey,
        actionId: moduleAction.action.actionId,
      },
      permission: actionPermission,
    });
  };

  // A form commits what its bound `form_submit` flows commit, derived exactly as Definition
  // validation derives it, so the tool bundle and the published contract never drift.
  const standardActionKeysByRecordAction = new Map<string, string>();
  for (const output of boundModuleOutputs) {
    const moduleKey = String(output.canonical.envelope.key);
    for (const record of output.canonical.content.recordTypes)
      for (const action of record.standardActions)
        standardActionKeysByRecordAction.set(
          `${String(record.recordTypeId)}:${action}`,
          `${moduleKey}.${String(record.key)}.${action}`,
        );
  }
  const formCommits = deriveFormCommitActionKeys(content, {
    standardActionKeysByRecordAction,
    executableActionKeys: new Set([
      ...applicationActionKeys,
      ...moduleActionsByKey.keys(),
      ...standardActionKeysByRecordAction.values(),
    ]),
  });

  for (const page of content.pages) {
    if (page.type === "form" || page.type === "guided_form") {
      for (const key of formCommits.get(String(page.pageId)) ?? [])
        if (key !== "") addCommittedAction(page.name, key, true);
    } else if (page.type === "public" && page.publicActionKey !== undefined) {
      addCommittedAction(page.name, String(page.publicActionKey), false);
    }
  }

  // A flow's record reads name only this Application's own queries, which have their own tools
  // below, so a flow contributes exactly its own entry point.
  for (const flow of content.flows)
    add({
      name: applicationToolName(applicationKey, "flow", String(flow.key)),
      ...applicationToolDescription(flow.description, flow.labels.name),
      inputSchema: {
        kind: "flow_inputs",
        inputs: Object.fromEntries(
          Object.entries(flow.inputs).map(([name, declaration]) => [
            name,
            {
              type: declaration.type,
              required: declaration.required,
              ...(declaration.recordTypeIds === undefined
                ? {}
                : { recordTypeIds: declaration.recordTypeIds }),
            },
          ]),
        ),
      },
      operation: { kind: "flow", key: flow.key, flowId: ruleIdSchema.parse(String(flow.id)) },
      permission: { discover: "page_access", use: "delegated_operations" },
    });

  // The queries this Application reads are the ones bound Modules expose: each page, placement and
  // interface read that names one gets a read tool owned by that Module, described from its exact
  // bound release.
  const moduleQueriesById = new Map(
    boundModuleOutputs.flatMap((output) =>
      output.canonical.content.queries
        .filter(
          (query) =>
            output.canonical.content.ownerApplication === applicationKey ||
            moduleQueryBorrowable(query),
        )
        .map(
          (query) =>
            [
              String(query.queryId),
              { moduleRootId: String(output.artifact.rootId), query },
            ] as const,
        ),
    ),
  );
  const boundModuleQueriesByKey = new Map<string, string[]>();
  for (const [queryId, { query }] of moduleQueriesById)
    boundModuleQueriesByKey.set(String(query.key), [
      ...(boundModuleQueriesByKey.get(String(query.key)) ?? []),
      queryId,
    ]);
  const referencedQueryIds = new Set<string>();
  const collectQueryIds = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collectQueryIds);
    else if (value !== null && typeof value === "object") {
      const item = value as JsonObject;
      if (typeof item.queryId === "string") referencedQueryIds.add(item.queryId);
      Object.values(item).forEach(collectQueryIds);
    }
  };
  collectQueryIds(content.pages);
  // A placement setting names a query by its plain identity; its release declares it a query
  // reference, at the top level or inside a group or list.
  const collectSettingQueryIds = (value: BlockPropertyValueContract): void => {
    if (value.kind === "query_reference") referencedQueryIds.add(String(value.queryId));
    else if (value.kind === "group")
      Object.values(value.properties).forEach(collectSettingQueryIds);
    else if (value.kind === "list") value.items.forEach(collectSettingQueryIds);
  };
  for (const page of content.pages)
    for (const item of compiledPageItems(page.composition)) {
      const release = releases.find(
        (candidate) =>
          String(candidate.blockId) === String(item.props.vortex.block.blockId) &&
          candidate.releaseVersion === item.props.vortex.block.releaseVersion,
      );
      if (release === undefined)
        fail("vortex.definition.invalid_compilation_output", "invalid_value");
      Object.values(compiledItemSettings(item.props, release)).forEach(collectSettingQueryIds);
    }
  for (const definition of content.interfaces)
    for (const operation of definition.operations)
      if (operation.target.kind === "query") {
        const matches = boundModuleQueriesByKey.get(String(operation.target.key)) ?? [];
        if (matches.length === 1) referencedQueryIds.add(matches[0]!);
      }
  for (const queryId of [...referencedQueryIds].sort(compareCanonicalStrings)) {
    const bound = moduleQueriesById.get(queryId);
    if (bound === undefined) continue;
    add({
      name: applicationToolName(applicationKey, "query", String(bound.query.key)),
      inputSchema:
        bound.query.inputs.length === 0
          ? { kind: "none" }
          : { kind: "module_inputs", inputs: bound.query.inputs },
      operation: {
        kind: "query",
        owner: { kind: "module", moduleRootId: bound.moduleRootId },
        key: bound.query.key,
        queryId: bound.query.queryId,
      },
      permission: { discover: "page_access", use: "none" },
    });
  }

  const addNavigation = (items: readonly NavigationItem[]): void => {
    for (const item of items) {
      if (item.type === "heading") {
        addNavigation(item.children);
        continue;
      }
      if (item.type !== "page") continue;
      const page = pagesById.get(String(item.pageId));
      if (page === undefined) continue;
      add({
        name: applicationToolName(applicationKey, "navigation", String(page.key)),
        ...applicationToolDescription(item.label, page.name),
        inputSchema: { kind: "none" },
        operation: { kind: "navigation", key: page.key, pageId: page.pageId },
        permission: { discover: "application_navigation", use: "none" },
      });
    }
  };
  addNavigation(content.navigation);

  return applicationToolBundleSchema.parse({
    contractVersion: "1.0.0",
    applicationKey,
    tools: [...tools.values()].sort((left, right) =>
      compareCanonicalStrings(left.name, right.name),
    ),
  });
}
