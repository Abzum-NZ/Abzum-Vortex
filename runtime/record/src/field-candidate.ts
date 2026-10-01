import "server-only";

import { recordTypeDefinitionV3Schema, type JsonValue } from "@vortex/contracts";
import {
  applyBeforeSaveRules,
  beforeSaveRuleRefusedIssueCode,
  beforeSaveRuleUnavailableIssueCode,
  type BeforeSaveRuleExecution,
} from "./before-save-rules";
import { evaluateRecordCalculations } from "./calculations";
import { isDateDeadlineDueFieldV2 } from "./deadline-transitions";
import {
  finalizeRecordFieldCandidateV2,
  prepareInitialRecordFieldCandidateV2,
  type PrepareRecordFieldValuesV2Result,
  type RecordFieldValueRequirementV2,
} from "./field-values";

type CalculateAndFinalizeInput = Readonly<{
  operation: "create" | "update";
  submittedValues: Readonly<Record<string, unknown>>;
  recordType: ReturnType<typeof recordTypeDefinitionV3Schema.parse>;
  existingValues?: Readonly<Record<string, unknown>>;
  issuedAt: string;
  organizationCurrency?: string | undefined;
  timeZone?: string | undefined;
  rules?: BeforeSaveRuleExecution | undefined;
}>;

const localDate = (instant: string, timeZone: string): string | undefined => {
  const date = new Date(instant);
  if (!Number.isFinite(date.valueOf())) return undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value;
    const year = value("year");
    const month = value("month");
    const day = value("day");
    return year && month && day ? `${year}-${month}-${day}` : undefined;
  } catch {
    return undefined;
  }
};

type CalculatedFieldValues =
  | PrepareRecordFieldValuesV2Result
  | Readonly<{
      success: false;
      issues: ReadonlyArray<
        Readonly<{
          code: string;
          fieldId?: string;
          path: readonly (string | number)[];
        }>
      >;
    }>;

/**
 * Builds the ordinary pre-allocation value candidate only. Success confirms no
 * Access, uniqueness, generated-reference/total, or live pending-check facts;
 * the owning caller retains all authority, total selection, and writer work.
 * Submitted generated values are refused by initial preparation; only the
 * trusted calculation engine can add calculation values here.
 * @internal Shared by ordinary Record saves and named-action candidate composition.
 */
export const calculateAndFinalize = ({
  operation,
  submittedValues,
  recordType,
  existingValues,
  issuedAt,
  organizationCurrency,
  timeZone,
  rules,
}: CalculateAndFinalizeInput): CalculatedFieldValues => {
  const initial = prepareInitialRecordFieldCandidateV2({
    operation,
    recordType,
    submittedValues,
    ...(organizationCurrency === undefined ? {} : { organizationCurrency }),
    ...(operation === "update" && existingValues !== undefined ? { existingValues } : {}),
  });
  if (!initial.success) return initial;

  // Every applicable compiled rule runs exactly once here, before calculations
  // and final field policy, so rule effects are revalidated like any other value.
  let ruleCandidateValues: Readonly<Record<string, JsonValue>> = initial.candidate.candidateValues;
  let requirements: readonly RecordFieldValueRequirementV2[] = [];
  if (rules !== undefined) {
    const applied = applyBeforeSaveRules({
      execution: rules,
      recordType,
      initialCandidate: initial.candidate,
      ...(organizationCurrency === undefined ? {} : { organizationCurrency }),
    });
    if (!applied.success)
      return {
        success: false,
        issues: [
          applied.reason === "refused"
            ? {
                code: beforeSaveRuleRefusedIssueCode,
                ...(applied.fieldId === undefined ? {} : { fieldId: applied.fieldId }),
                path: ["rules"],
              }
            : { code: beforeSaveRuleUnavailableIssueCode, path: ["rules"] },
        ],
      };
    ruleCandidateValues = applied.candidateValues;
    requirements = applied.requirements;
  }

  const calculationFieldIds = recordType.fields
    .filter((field) => field.type === "calculation")
    .map((field) => field.fieldId);
  if (calculationFieldIds.length === 0)
    return finalizeRecordFieldCandidateV2({
      recordType,
      initialCandidate: initial.candidate,
      candidateValues: ruleCandidateValues,
      requirements,
      requiredGeneratedFieldIds: [],
      ...(organizationCurrency === undefined ? {} : { organizationCurrency }),
    });

  // Most calculation forms do not use the organisation clock. Only a date
  // deadline comparison needs the organisation-local date; date-time
  // deadlines compare exact instants and remain deterministic without it.
  const needsOrganizationLocalDate = recordType.fields.some((field) => {
    if (field.type !== "calculation") return false;
    const expression = field.settings.expression;
    if (expression.kind !== "deadline_passed") return false;
    const dueField = recordType.fields.find(
      (candidate) => candidate.fieldId === expression.dueFieldId,
    );
    return dueField !== undefined && isDateDeadlineDueFieldV2(dueField);
  });
  const organizationLocalDate = needsOrganizationLocalDate
    ? timeZone === undefined
      ? undefined
      : localDate(issuedAt, timeZone)
    : issuedAt.slice(0, 10);
  if (organizationLocalDate === undefined)
    return {
      success: false,
      issues: [{ code: "invalid_input", path: ["organizationRuntimeSettings"] }],
    };

  const calculations = evaluateRecordCalculations({
    recordType,
    authoritativeFieldValues: ruleCandidateValues,
    clock: { instant: issuedAt, organizationLocalDate },
  });
  if (!calculations.success) return calculations;

  const candidateValues: Record<string, unknown> = {
    ...ruleCandidateValues,
    ...calculations.setValues,
  };
  for (const fieldId of calculations.clearFieldIds) delete candidateValues[fieldId];
  return finalizeRecordFieldCandidateV2({
    recordType,
    initialCandidate: initial.candidate,
    candidateValues,
    requirements,
    requiredGeneratedFieldIds: calculationFieldIds,
    ...(organizationCurrency === undefined ? {} : { organizationCurrency }),
  });
};

/** @internal Shared by ordinary Record saves and named-action candidate composition. */
export const operationClock = (
  recordTypes: readonly ReturnType<typeof recordTypeDefinitionV3Schema.parse>[],
  issuedAt: string,
  timeZone: string | undefined,
): Readonly<{ instant: string; organizationLocalDate: string }> | undefined => {
  const needsOrganizationLocalDate = recordTypes.some((recordType) =>
    recordType.fields.some((field) => {
      if (field.type !== "calculation") return false;
      const expression = field.settings.expression;
      if (expression.kind !== "deadline_passed") return false;
      const dueField = recordType.fields.find(
        (candidate) => candidate.fieldId === expression.dueFieldId,
      );
      return dueField !== undefined && isDateDeadlineDueFieldV2(dueField);
    }),
  );
  const organizationLocalDate = needsOrganizationLocalDate
    ? timeZone === undefined
      ? undefined
      : localDate(issuedAt, timeZone)
    : issuedAt.slice(0, 10);
  return organizationLocalDate === undefined
    ? undefined
    : { instant: issuedAt, organizationLocalDate };
};
