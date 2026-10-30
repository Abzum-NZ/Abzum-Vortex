import "server-only";

import {
  createHumanOrganizationRequestService,
  createProtectedQueryService,
  createRecordChoiceReader,
  delegableRoleIds,
  type BoundHumanOrganizationRequest,
  type RecordChoiceCommand,
} from "@vortex/platform/server";
import {
  isRecord,
  jsonValueSchema,
  sameId,
  type IdentitySession,
  type JsonValue,
  type ModuleDefinitionConsumerReadResult,
  type OrganizationSelectionCandidate,
} from "@vortex/platform/schema";
import { getQueryContinuationKey } from "../query-continuation-key";
import { requestDependencies } from "./installed-context";
import { optionFilterAdmission } from "./link-input";
import type { ProjectedOptionsField } from "./options-projection";

/** The submitted value of a link field: one record reference, nothing else. */
const referenceOf = (
  value: unknown,
): Readonly<{ recordTypeId: string; recordId: string }> | undefined =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  typeof value.recordTypeId === "string" &&
  typeof value.recordId === "string"
    ? { recordTypeId: value.recordTypeId, recordId: value.recordId }
    : undefined;

/**
 * The record types a field may point at as the installed Modules declare them, for the picker's
 * own read; undefined when one is not installed.
 */
const targetsOf = (
  field: ProjectedOptionsField,
  modules: readonly ModuleDefinitionConsumerReadResult[],
): RecordChoiceCommand["targets"] | undefined => {
  const targets: RecordChoiceCommand["targets"][number][] = [];
  for (const declared of field.recordTypes) {
    const module = modules.find((candidate) =>
      sameId(String(candidate.rootId), declared.moduleRootId),
    );
    const recordType = module?.content.recordTypes.find((candidate) =>
      sameId(String(candidate.recordTypeId), declared.recordTypeId),
    );
    if (module === undefined || recordType === undefined) return undefined;
    targets.push({
      moduleRootId: String(module.rootId),
      recordTypeId: String(recordType.recordTypeId),
      titleFieldId: String(recordType.titleFieldId),
      label: recordType.singularLabel,
    });
  }
  return targets.length === 0 ? undefined : targets;
};

/**
 * Proves every submitted value of a form's option-sourced fields is one the viewer is offered now:
 * the same picker read with the exact record asked for, so a record that is withheld, withdrawn or
 * filtered out by the field's option filter refuses the whole submission. Returns the values, or
 * undefined when any is refused.
 */
export const resolveFormOptionValues = async (
  args: Readonly<{
    session: IdentitySession;
    selection: OrganizationSelectionCandidate;
    modules: readonly ModuleDefinitionConsumerReadResult[];
    projectedFields: ReadonlyMap<string, ProjectedOptionsField>;
    values: unknown;
    bound?: BoundHumanOrganizationRequest;
  }>,
): Promise<Readonly<Record<string, JsonValue>> | undefined> => {
  if (!isRecord(args.values)) return undefined;
  const dependencies = {
    ...requestDependencies(),
    ...(args.bound === undefined ? {} : { boundRequest: args.bound }),
  };
  const queries = createProtectedQueryService({
    ...dependencies,
    continuationKey: getQueryContinuationKey(),
  });
  const requests = createHumanOrganizationRequestService(dependencies);
  const reader = createRecordChoiceReader(queries);
  // A bound transaction cannot overlap sibling savepoints, so the proofs run one after another.
  for (const [fieldKey, field] of args.projectedFields) {
    if (!Object.hasOwn(args.values, fieldKey)) continue;
    const submitted = args.values[fieldKey];
    if (submitted === null) continue;
    const reference = referenceOf(submitted);
    const targets = targetsOf(field, args.modules);
    if (
      reference === undefined ||
      targets === undefined ||
      !targets.some((target) => sameId(target.recordTypeId, reference.recordTypeId))
    )
      return undefined;
    const admission = optionFilterAdmission(field.optionFilter, async (ids) => {
      if (args.bound !== undefined) return delegableRoleIds(args.bound.transaction, ids);
      const decided = await requests.run(args.session, args.selection, (transaction) =>
        delegableRoleIds(transaction, ids),
      );
      if (decided.kind !== "available") throw new Error("OPTION_FILTER_UNAVAILABLE");
      return decided.value;
    });
    const proof = await reader.resolveExact(
      args.session,
      args.selection,
      { targets, pageSize: 1 },
      reference,
      admission,
    );
    if (
      proof.kind !== "available" ||
      proof.value.outcome !== "completed" ||
      !proof.value.choices.some(
        (choice) =>
          sameId(choice.recordTypeId, reference.recordTypeId) &&
          sameId(choice.recordId, reference.recordId),
      )
    ) {
      console.error(`[form-options] value of ${fieldKey} is not among the options offered`);
      return undefined;
    }
  }
  const parsed = jsonValueSchema.safeParse(args.values);
  return parsed.success && isRecord(parsed.data)
    ? (Object.freeze(parsed.data) as Readonly<Record<string, JsonValue>>)
    : undefined;
};
