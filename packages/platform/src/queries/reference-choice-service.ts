import "server-only";

import type { HumanOrganizationRequestResult } from "../access/index";
import {
  sameId,
  type FieldId,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
  type ReferenceChoiceSelectionEvidence,
  type RecordTypeId,
  type RecordTypeReference,
} from "../schema";
import type { ProtectedQueryRow } from "./protected-query-contracts";
import {
  createProtectedQueryService,
  type ProtectedQueryServiceDependencies,
} from "./protected-query-service";
import {
  recordReferenceChoiceCommandSchema,
  type RecordReferenceChoiceCommand,
  type ReferenceChoiceOption,
  type ReferenceChoiceRefusal,
  type ReferenceChoiceRefusalReasonCode,
  type ReferenceChoiceResult,
  type ReferenceChoiceValue,
} from "./reference-choice-contracts";

export type ReferenceChoiceServiceDependencies = ProtectedQueryServiceDependencies;

/** The #582 `choice_input` projected values for one reference input placement. */
export type ReferenceChoiceInputValues = Readonly<{
  kind: "choice_input";
  value?: string | null;
  options: readonly Readonly<{ key: string; label: string }>[];
  optionEvidence: Readonly<Record<string, ReferenceChoiceSelectionEvidence>>;
  nextContinuationToken?: string;
  error?: string;
  /** New-release reset context; it is an opaque offered parent key, never authority. */
  dependencyKey?: string | null;
}>;

const refusal = (reasonCode: ReferenceChoiceRefusalReasonCode): ReferenceChoiceRefusal =>
  Object.freeze({ outcome: "refused", reasonCode });

const maximumLabelLength = 200;

const boundedLabel = (text: string): string => {
  const trimmed = text.trim();
  return Array.from(trimmed).slice(0, maximumLabelLength).join("");
};

/**
 * A choice-input option key for one referenced identity. Option keys are
 * builder keys, so the UUID is carried as its 32 lowercase hex digits under a
 * kind prefix; the key is resolved back only against the permitted choices.
 */
const choiceKey = (id: string): string => `r_${id.replaceAll("-", "").toLowerCase()}`;

const matchesSearch = (label: string, search: string | undefined): boolean =>
  search === undefined || label.toLowerCase().includes(search.toLowerCase());

const freezeChoices = (choices: readonly ReferenceChoiceOption[]): ReferenceChoiceOption[] =>
  choices.map((choice) => Object.freeze({ ...choice, value: Object.freeze(choice.value) }));

/**
 * Projects one page of permitted choices into #582 `choice_input` values. A
 * selected key outside the permitted choices is dropped rather than shown.
 */
export function projectReferenceChoiceInputValues(
  choices: readonly ReferenceChoiceOption[],
  selectedKey?: string | null,
  error?: string,
  page: Readonly<{
    search?: string;
    continuationToken?: string;
    nextContinuationToken?: string;
    optionEvidenceOverrides?: Readonly<Record<string, ReferenceChoiceSelectionEvidence>>;
    dependencyKey?: string | null;
  }> = {},
): ReferenceChoiceInputValues {
  const options = Object.freeze(
    choices.map((choice) => Object.freeze({ key: choice.key, label: choice.label })),
  );
  const optionEvidence = Object.freeze(
    Object.fromEntries(
      choices.map((choice) => [
        choice.key,
        Object.freeze(
          page.optionEvidenceOverrides?.[choice.key] ?? {
            ...(page.search === undefined || page.search.trim() === ""
              ? {}
              : { search: page.search.trim() }),
            ...(page.continuationToken === undefined
              ? {}
              : { continuationToken: page.continuationToken }),
          },
        ),
      ]),
    ),
  );
  const selected =
    selectedKey === undefined || selectedKey === null
      ? selectedKey
      : choices.some((choice) => choice.key === selectedKey)
        ? selectedKey
        : null;
  return Object.freeze({
    kind: "choice_input",
    options,
    optionEvidence,
    ...(page.dependencyKey === undefined ? {} : { dependencyKey: page.dependencyKey }),
    ...(page.nextContinuationToken === undefined
      ? {}
      : { nextContinuationToken: page.nextContinuationToken }),
    ...(selected === undefined ? {} : { value: selected }),
    ...(error === undefined ? {} : { error }),
  });
}

/**
 * The typed reference value a submitted option key stands for, or undefined
 * when the key is not one of the permitted choices, so a value outside the
 * offered set can never be submitted through the binding.
 */
export function resolveReferenceChoiceSelection(
  choices: readonly ReferenceChoiceOption[],
  selectedKey: string | null,
): ReferenceChoiceValue | null | undefined {
  if (selectedKey === null) return null;
  return choices.find((choice) => choice.key === selectedKey)?.value;
}

const allowsRecordType = (
  allowed: readonly RecordTypeReference[],
  target: RecordTypeReference,
): target is Extract<RecordTypeReference, { state: "resolved" }> =>
  target.state === "resolved" &&
  allowed.some(
    (candidate) =>
      candidate.state === "resolved" &&
      sameId(candidate.moduleRootId, target.moduleRootId) &&
      sameId(candidate.recordTypeId, target.recordTypeId),
  );

const recordChoice = (
  row: ProtectedQueryRow,
  recordTypeId: RecordTypeId,
  labelFieldId: FieldId,
  search: string | undefined,
): ReferenceChoiceOption => {
  // A withheld label field is absent from the row, so the fallback names only
  // the record the viewer may already read.
  const labelValue: JsonValue | undefined = row.values[labelFieldId];
  const labelText =
    typeof labelValue === "number" && Number.isFinite(labelValue) ? String(labelValue) : labelValue;
  const matchingText =
    Array.isArray(labelText) && search !== undefined
      ? labelText.find(
          (member): member is string => typeof member === "string" && matchesSearch(member, search),
        )
      : labelText;
  const label =
    typeof matchingText === "string" && matchingText.trim().length > 0
      ? (() => {
          const first = boundedLabel(matchingText);
          if (search === undefined || matchesSearch(first, search)) return first;
          const matchAt = matchingText.toLowerCase().indexOf(search.toLowerCase());
          return matchAt < 0 ? first : boundedLabel(matchingText.slice(matchAt));
        })()
      : `Record ${row.recordId.slice(0, 8).toLowerCase()}`;
  return {
    key: choiceKey(row.recordId),
    label,
    value: { recordTypeId, recordId: row.recordId },
  };
};

const recordChoices = async (
  queries: ReturnType<typeof createProtectedQueryService>,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  command: RecordReferenceChoiceCommand,
): Promise<HumanOrganizationRequestResult<ReferenceChoiceResult>> => {
  const { source } = command;
  const target = source.query.recordType;
  const bound = command.boundInput;
  const input = source.query.inputs[0];
  const validInputs =
    bound === undefined
      ? !source.query.inputs.some((declaration) => declaration.required)
      : source.query.inputs.length === 1 &&
        input?.required === true &&
        input.type === "text" &&
        input.key === bound.key;
  if (
    !allowsRecordType(command.allowedRecordTypes, target) ||
    !source.query.selectedFieldIds.some((fieldId) => sameId(fieldId, command.labelFieldId)) ||
    source.query.groupByFieldIds.length > 0 ||
    source.query.aggregates.length > 0 ||
    !validInputs
  )
    return { kind: "available", value: refusal("source_invalid") };

  const result = await queries.run(session, selection, {
    moduleRootId: source.moduleRootId,
    queryId: source.query.queryId,
    inputValues: bound === undefined ? {} : { [bound.key]: bound.value },
    requestedFieldIds: [command.labelFieldId],
    searchableFieldIds: [command.labelFieldId],
    ...(command.search === undefined ? {} : { search: command.search }),
    ...(command.exactRecordId === undefined ? {} : { exactRecordId: command.exactRecordId }),
    pageSize:
      command.exactRecordId === undefined ? Math.min(command.pageSize, source.query.pageSize) : 1,
    ...(command.continuationToken === undefined
      ? {}
      : { continuationToken: command.continuationToken }),
  });
  if (result.kind !== "available") return result;
  const page = result.value;
  if (page.outcome === "refused") {
    switch (page.reasonCode) {
      case "cursor_invalid":
      case "cursor_stale":
        return { kind: "available", value: refusal(page.reasonCode) };
      case "request_invalid":
        return { kind: "available", value: refusal("request_invalid") };
      default:
        return { kind: "available", value: refusal("source_unavailable") };
    }
  }
  // Choice values name the descriptor's record type, so the rows must come
  // from that exact installed release.
  if (
    !sameId(page.moduleRootId, source.moduleRootId) ||
    !sameId(page.queryId, source.query.queryId) ||
    page.moduleReleaseVersion !== source.moduleReleaseVersion
  )
    return { kind: "available", value: refusal("source_stale") };

  // The protected query applies search before pagination. A matching suffix is
  // shown when the match lies beyond the normal 200-character label boundary.
  const choices = page.rows.map((row) =>
    recordChoice(row, target.recordTypeId, command.labelFieldId, command.search),
  );
  return {
    kind: "available",
    value: {
      outcome: "completed",
      kind: "record_reference",
      choices: freezeChoices(choices),
      ...(page.nextContinuationToken === undefined
        ? {}
        : { nextContinuationToken: page.nextContinuationToken }),
    },
  };
};

/**
 * Protected record choices are the rows the #572 protected Query admits for a
 * published query of an allowed record type. Refusals carry no counts.
 */
export const createReferenceChoiceService = (dependencies: ReferenceChoiceServiceDependencies) => {
  const queries = createProtectedQueryService(dependencies);

  return Object.freeze({
    async run(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ReferenceChoiceResult>> {
      const command = recordReferenceChoiceCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "available", value: refusal("request_invalid") };
      return recordChoices(queries, session, selection, command.data);
    },
  });
};
