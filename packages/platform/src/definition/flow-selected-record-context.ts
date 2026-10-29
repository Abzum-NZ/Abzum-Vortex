import "server-only";

import { fieldIdSchema, recordTypeIdSchema } from "../catalogue/identifiers";
import { isRecord, sameId } from "../catalogue/runtime-primitives";
import {
  flowTaskChildLists,
  flowReadFieldsProjectionSchema,
  flowReadFieldsTypeMapSchema,
  type FlowDefinition,
  type FlowReadFieldsScalarType,
  type FlowTask,
} from "../workflows/flow-contracts";
import type { ApplicationContent } from "./application-contracts";
import type { ModuleDefinitionConsumerReadResult } from "./definition-consumer-read";
import type { ExactDefinitionDependency } from "./definition-store-contracts";
import { flowReadFieldsScalarTypeForField } from "./flow-compilation";
import type { FlowRelease } from "./flow-orchestrator-types";

type SelectedRecordReadField = Readonly<{
  alias: string;
  fieldId: string;
  type: FlowReadFieldsScalarType;
}>;

type SelectedRecordReadProjection = Readonly<{
  recordTypeId: string;
  fields: readonly SelectedRecordReadField[];
}>;

type SelectedRecordReadModule = Readonly<{
  moduleRootId: string;
  moduleReleaseRevision: number;
  storageContractId: string;
}>;

type InstalledSelectedRecordReadContext = Readonly<{
  projections: NonNullable<FlowRelease["selectedRecordReadProjections"]>;
  /** Flow input name to its one exact selected-record type, keyed by lower-case flow ID. */
  inputs: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Exact installed Module owning each read target, keyed by lower-case record type ID. */
  modules: ReadonlyMap<string, SelectedRecordReadModule>;
}>;

type ModuleDependency = Extract<ExactDefinitionDependency, { kind: "module" }>;

const moduleDependencyMatches = (
  dependency: ModuleDependency,
  release: ModuleDefinitionConsumerReadResult,
): boolean =>
  sameId(dependency.rootId, release.rootId) &&
  dependency.key === release.definitionKey &&
  dependency.releaseRevision === release.releaseRevision &&
  dependency.releaseVersion === release.releaseVersion &&
  dependency.contentFingerprint === release.contentFingerprint;

/** Resolve only the exact Module closure reachable from the installed Application manifests. */
export const installedModuleClosure = (
  application: Readonly<{
    content: ApplicationContent;
    dependencyManifest: readonly ExactDefinitionDependency[];
  }>,
  releases: readonly ModuleDefinitionConsumerReadResult[],
): ReadonlyMap<string, ModuleDefinitionConsumerReadResult> | undefined => {
  const byRoot = new Map<string, ModuleDefinitionConsumerReadResult>();
  for (const release of releases) {
    const root = release.rootId.toLowerCase();
    if (byRoot.has(root)) return undefined;
    byRoot.set(root, release);
  }

  const directDependencies = application.dependencyManifest.filter(
    (entry): entry is ModuleDependency => entry.kind === "module",
  );
  if (directDependencies.length !== application.content.moduleBindings.length) return undefined;
  for (const binding of application.content.moduleBindings) {
    const matches = directDependencies.filter(
      (dependency) =>
        sameId(dependency.rootId, binding.moduleRootId) &&
        dependency.releaseVersion === binding.resolvedVersion,
    );
    if (matches.length !== 1) return undefined;
  }

  const reachable = new Map<string, ModuleDefinitionConsumerReadResult>();
  const pending = [...directDependencies];
  while (pending.length > 0) {
    const dependency = pending.pop();
    if (dependency === undefined) continue;
    const root = dependency.rootId.toLowerCase();
    const release = byRoot.get(root);
    if (release === undefined || !moduleDependencyMatches(dependency, release)) return undefined;
    if (reachable.has(root)) continue;
    reachable.set(root, release);
    pending.push(
      ...release.dependencyManifest.filter(
        (entry): entry is ModuleDependency => entry.kind === "module",
      ),
    );
  }

  return reachable.size === releases.length ? reachable : undefined;
};

export const installedSelectedRecordReadContext = (
  application: Readonly<{
    content: ApplicationContent;
    dependencyManifest: readonly ExactDefinitionDependency[];
  }>,
  releases: readonly ModuleDefinitionConsumerReadResult[],
): InstalledSelectedRecordReadContext | undefined => {
  const modules = installedModuleClosure(application, releases);
  if (modules === undefined) return undefined;

  const recordTypes = new Map<
    string,
    Array<
      Readonly<{
        module: ModuleDefinitionConsumerReadResult;
        recordType: ModuleDefinitionConsumerReadResult["content"]["recordTypes"][number];
      }>
    >
  >();
  const readModules = new Map<string, SelectedRecordReadModule>();
  for (const module of modules.values())
    for (const recordType of module.content.recordTypes) {
      const key = recordType.recordTypeId.toLowerCase();
      const owners = recordTypes.get(key) ?? [];
      owners.push({ module, recordType });
      recordTypes.set(key, owners);
    }

  const moduleByRoot = new Map(
    [...modules.values()].map((module) => [module.rootId.toLowerCase(), module] as const),
  );
  const moduleDependenciesFor = (rootId: string): Set<string> | undefined => {
    const root = rootId.toLowerCase();
    if (!moduleByRoot.has(root)) return undefined;
    const visited = new Set<string>();
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || visited.has(current)) continue;
      visited.add(current);
      const module = moduleByRoot.get(current);
      if (module === undefined) return undefined;
      for (const dependency of module.dependencyManifest)
        if (dependency.kind === "module") pending.push(dependency.rootId.toLowerCase());
    }
    visited.delete(root);
    return visited;
  };

  const projections = new Map<string, Map<string, SelectedRecordReadProjection>>();
  const inputs = new Map<string, Map<string, string>>();
  const seenFlowIds = new Set<string>();
  const flowOwners: Array<Readonly<{ flow: FlowDefinition; moduleRootId?: string }>> = [
    ...application.content.flows.map((flow) => ({ flow })),
    ...[...modules.values()].flatMap((module) =>
      module.content.flows.map((flow) => ({ flow, moduleRootId: module.rootId })),
    ),
  ];

  for (const { flow, moduleRootId } of flowOwners) {
    const flowId = String(flow.id);
    const normalizedFlowId = flowId.toLowerCase();
    if (seenFlowIds.has(normalizedFlowId)) return undefined;
    seenFlowIds.add(normalizedFlowId);
    const flowProjections = new Map<string, SelectedRecordReadProjection>();
    const flowInputs = new Map<string, string>();
    const seenTaskIds = new Set<string>();
    const moduleDependencies =
      moduleRootId === undefined ? undefined : moduleDependenciesFor(moduleRootId);
    if (moduleRootId !== undefined && moduleDependencies === undefined) return undefined;

    const visit = (tasks: readonly FlowTask[]): boolean => {
      for (const task of tasks) {
        const taskId = String(task.id);
        const normalizedTaskId = taskId.toLowerCase();
        if (seenTaskIds.has(normalizedTaskId)) return false;
        seenTaskIds.add(normalizedTaskId);
        if (task.type === "record.read_fields") {
          const compiled = task as FlowTask &
            Readonly<{
              properties?: Readonly<Record<string, unknown>>;
              readFieldTypes?: unknown;
            }>;
          const properties = compiled.properties;
          const recordTypeValue = properties?.record_type;
          const recordTypeLiteral =
            isRecord(recordTypeValue) && recordTypeValue.kind === "literal"
              ? recordTypeValue.literal
              : undefined;
          const recordTypeId =
            isRecord(recordTypeLiteral) && recordTypeLiteral.type === "text"
              ? recordTypeIdSchema.safeParse(recordTypeLiteral.value)
              : undefined;
          const fieldsValue = properties?.fields;
          const fieldsLiteral =
            isRecord(fieldsValue) && fieldsValue.kind === "literal"
              ? fieldsValue.literal
              : undefined;
          const fields =
            isRecord(fieldsLiteral) && fieldsLiteral.type === "json"
              ? flowReadFieldsProjectionSchema.safeParse(fieldsLiteral.value)
              : undefined;
          const fieldTypes = flowReadFieldsTypeMapSchema.safeParse(compiled.readFieldTypes);
          if (
            !recordTypeId?.success ||
            !fields?.success ||
            !fieldTypes.success ||
            Object.keys(fieldTypes.data).length !== fields.data.length ||
            flowProjections.has(taskId)
          )
            return false;

          const selectedRecordOwners = recordTypes.get(recordTypeId.data.toLowerCase()) ?? [];
          if (selectedRecordOwners.length !== 1) return false;
          const owner = selectedRecordOwners[0]!;
          const ownerRoot = owner.module.rootId.toLowerCase();
          if (
            (moduleDependencies !== undefined && !moduleDependencies.has(ownerRoot)) ||
            (moduleRootId !== undefined && sameId(moduleRootId, owner.module.rootId))
          )
            return false;

          const recordValue = properties?.record;
          const reference =
            isRecord(recordValue) && recordValue.kind === "reference"
              ? recordValue.reference
              : undefined;
          if (
            !isRecord(reference) ||
            reference.source !== "input" ||
            typeof reference.name !== "string"
          )
            return false;
          const inputName = reference.name;
          const declaration = flow.inputs[inputName];
          if (
            declaration === undefined ||
            declaration.type !== "record_reference" ||
            declaration.recordTypeIds?.length !== 1 ||
            !sameId(declaration.recordTypeIds[0]!, recordTypeId.data)
          )
            return false;
          const previousInputType = flowInputs.get(inputName);
          if (previousInputType !== undefined && !sameId(previousInputType, recordTypeId.data))
            return false;
          flowInputs.set(inputName, recordTypeId.data);

          const projectedFields: SelectedRecordReadField[] = [];
          const seenFieldIds = new Set<string>();
          for (const field of fields.data) {
            const fieldId = fieldIdSchema.safeParse(field.field);
            const scalarType = fieldTypes.data[field.alias];
            if (!fieldId.success || scalarType === undefined) return false;
            const normalizedFieldId = fieldId.data.toLowerCase();
            if (seenFieldIds.has(normalizedFieldId)) return false;
            seenFieldIds.add(normalizedFieldId);
            const matchingFields = owner.recordType.fields.filter((candidate) =>
              sameId(candidate.fieldId, fieldId.data),
            );
            if (
              matchingFields.length !== 1 ||
              flowReadFieldsScalarTypeForField(matchingFields[0]!.type) !== scalarType
            )
              return false;
            projectedFields.push({ alias: field.alias, fieldId: fieldId.data, type: scalarType });
          }

          flowProjections.set(taskId, {
            recordTypeId: recordTypeId.data,
            fields: projectedFields,
          });
          readModules.set(recordTypeId.data.toLowerCase(), {
            moduleRootId: owner.module.rootId,
            moduleReleaseRevision: owner.module.releaseRevision,
            storageContractId: owner.recordType.storageContractId,
          });
        }
        for (const child of flowTaskChildLists(task)) if (!visit(child.tasks)) return false;
      }
      return true;
    };

    if (!visit([...flow.tasks, ...flow.errors, ...flow.finally])) return undefined;
    if (flowProjections.size > 0) projections.set(flowId, flowProjections);
    if (flowInputs.size > 0) inputs.set(normalizedFlowId, flowInputs);
  }

  return { projections, inputs, modules: readModules };
};
