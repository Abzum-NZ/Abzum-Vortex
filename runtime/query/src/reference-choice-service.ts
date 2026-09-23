import "server-only";

import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import {
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import type { RequestDatabaseTransaction } from "@vortex/db";
import {
  referenceChoiceCommandSchema,
  type RecordReferenceChoiceCommand,
  type OrganizationAccountReferenceChoiceCommand,
  type ReferenceChoiceCommand,
  type ReferenceChoiceOption,
  type ReferenceChoicePage,
  type ReferenceChoiceRefusal,
  type ReferenceChoiceRefusalReasonCode,
  type ReferenceChoiceResult,
} from "./reference-choice-contracts";
import type { ProtectedQueryRow } from "./protected-query-contracts";
import {
  createProtectedQueryService,
  type ProtectedQueryServiceDependencies,
} from "./protected-query-service";
import type { QueryContinuationKey } from "./continuation-token";

/** Choice option shape compatible with UI control projected data. */
export type ChoiceOption = Readonly<{ key: string; label: string }>;

/** Projected control values for #582 choice_input controls. */
export type ChoiceInputControlProjection = Readonly<{
  kind: "choice_input";
  value?: string | null;
  options: readonly ChoiceOption[];
  error?: string;
}>;

/** Candidate account representation from identity or directory sources. */
export type ActiveAccountCandidate = Readonly<{
  organizationAccountId: string;
  organizationId: string;
  displayName?: string | null;
  state: string;
  identityState?: string;
}>;

const refusal = (reasonCode: ReferenceChoiceRefusalReasonCode): ReferenceChoiceRefusal =>
  Object.freeze({
    outcome: "refused",
    reasonCode,
  });

/**
 * Projects reference choices into #582 choice_input control values for the data-binding runtime.
 */
export function projectReferenceChoicesToControlValues(
  choices: readonly ReferenceChoiceOption[],
  selected?: string | null,
  error?: string,
): ChoiceInputControlProjection {
  const options: readonly ChoiceOption[] = Object.freeze(
    choices.map((choice) =>
      Object.freeze({
        key: choice.key,
        label: choice.label,
      }),
    ),
  );
  return Object.freeze({
    kind: "choice_input",
    options,
    ...(selected !== undefined ? { value: selected } : {}),
    ...(error !== undefined ? { error } : {}),
  });
}

/**
 * Ensures that a selected or submitted choice value is strictly one of the permitted options,
 * refusing any out-of-set value.
 */
export function validateReferenceChoiceSubmission(
  permittedChoices: readonly { readonly key: string }[],
  value: string | null,
): boolean {
  if (value === null) return true;
  return permittedChoices.some((choice) => choice.key === value);
}

/**
 * Derives permitted record-reference choices from permission-filtered query rows (#572).
 * Only returns rows the viewer was allowed to read, with bounded search filtering.
 * Never leaks or infers hidden records.
 */
export function deriveRecordReferenceChoices(
  rows: readonly ProtectedQueryRow[],
  options: Readonly<{
    recordTypeIds?: readonly string[];
    search?: string;
    labelFieldId?: string;
    pageSize?: number;
  }> = {},
): readonly ReferenceChoiceOption[] {
  const searchNormalized = options.search?.trim().toLowerCase();
  const limit = Math.min(Math.max(1, options.pageSize ?? 50), 200);

  const choices: ReferenceChoiceOption[] = [];
  for (const row of rows) {
    if (choices.length >= limit) break;

    // Resolve human-readable label: labelFieldId first, then first readable string value, or record ID
    let label: string | undefined;
    if (options.labelFieldId !== undefined && row.values[options.labelFieldId] !== undefined) {
      const val = row.values[options.labelFieldId];
      if (typeof val === "string" && val.trim().length > 0) {
        label = val.trim();
      }
    }
    if (label === undefined) {
      for (const val of Object.values(row.values)) {
        if (typeof val === "string" && val.trim().length > 0) {
          label = val.trim();
          break;
        }
      }
    }
    if (label === undefined) {
      label = row.recordId;
    }

    // Apply bounded search filtering
    if (
      searchNormalized !== undefined &&
      searchNormalized.length > 0 &&
      !label.toLowerCase().includes(searchNormalized) &&
      !row.recordId.toLowerCase().includes(searchNormalized)
    ) {
      continue;
    }

    choices.push(
      Object.freeze({
        key: row.recordId,
        label,
        recordId: row.recordId,
      }),
    );
  }

  return Object.freeze(choices);
}

/**
 * Derives permitted account-reference choices for the current organisation.
 * Strictly limited to active accounts in the current organisation; cross-organisation
 * accounts are refused.
 */
export function deriveAccountReferenceChoices(
  candidates: readonly ActiveAccountCandidate[],
  currentOrganizationId: string,
  options: Readonly<{
    search?: string;
    pageSize?: number;
  }> = {},
): readonly ReferenceChoiceOption[] {
  const currentOrg = currentOrganizationId.toLowerCase();
  const searchNormalized = options.search?.trim().toLowerCase();
  const limit = Math.min(Math.max(1, options.pageSize ?? 50), 200);

  const choices: ReferenceChoiceOption[] = [];
  for (const account of candidates) {
    if (choices.length >= limit) break;

    // Strict organisation boundary: refuse cross-organisation accounts
    if (account.organizationId.toLowerCase() !== currentOrg) {
      continue;
    }

    // Only active accounts and active identities
    if (account.state !== "active") {
      continue;
    }
    if (account.identityState !== undefined && account.identityState !== "active") {
      continue;
    }

    const label =
      typeof account.displayName === "string" && account.displayName.trim().length > 0
        ? account.displayName.trim()
        : "Account";

    // Bounded search filtering
    if (
      searchNormalized !== undefined &&
      searchNormalized.length > 0 &&
      !label.toLowerCase().includes(searchNormalized) &&
      !account.organizationAccountId.toLowerCase().includes(searchNormalized)
    ) {
      continue;
    }

    choices.push(
      Object.freeze({
        key: account.organizationAccountId,
        label,
        organizationAccountId: account.organizationAccountId,
      }),
    );
  }

  return Object.freeze(choices);
}

export type ReferenceChoiceServiceDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    continuationKey: QueryContinuationKey;
    queryService?: ReturnType<typeof createProtectedQueryService>;
    recordSource?: (
      transaction: RequestDatabaseTransaction,
      scope: SelectedOrganizationScope,
      command: RecordReferenceChoiceCommand,
    ) => Promise<readonly ProtectedQueryRow[]>;
    accountSource?: (
      transaction: RequestDatabaseTransaction,
      scope: SelectedOrganizationScope,
      command: OrganizationAccountReferenceChoiceCommand,
    ) => Promise<readonly ActiveAccountCandidate[]>;
  }>;

/**
 * Protected reference choice service for form and action controls.
 * Provides permitted choices for record references and account references
 * in the current verified organisation scope with bounded search and paging.
 */
export function createReferenceChoiceService(dependencies: ReferenceChoiceServiceDependencies) {
  const requests = createHumanOrganizationRequestService(dependencies);
  const queryService =
    dependencies.queryService ??
    createProtectedQueryService(dependencies as ProtectedQueryServiceDependencies);

  const handleRecordReferenceChoices = async (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: RecordReferenceChoiceCommand,
  ): Promise<ReferenceChoiceResult> => {
    // If bound to a published module query, reuse the #572 query engine
    if (command.moduleRootId !== undefined && command.queryId !== undefined) {
      const requestedFieldIds = command.labelFieldId !== undefined ? [command.labelFieldId] : [];
      const queryResult = await queryService.run(session, selection, {
        moduleRootId: command.moduleRootId,
        queryId: command.queryId,
        inputValues: {},
        requestedFieldIds: requestedFieldIds.length > 0 ? requestedFieldIds : ["name"],
        pageSize: command.pageSize,
        ...(command.continuationToken ? { continuationToken: command.continuationToken } : {}),
      });

      if (queryResult.kind !== "available" || queryResult.value.outcome === "refused") {
        return refusal("query_unavailable");
      }

      const page = queryResult.value;
      const choices = deriveRecordReferenceChoices(page.rows, {
        recordTypeIds: command.recordTypeIds,
        search: command.search,
        labelFieldId: command.labelFieldId,
        pageSize: command.pageSize,
      });

      const response: ReferenceChoicePage = {
        outcome: "completed",
        kind: "record_reference",
        choices,
        ...(page.nextContinuationToken ? { nextContinuationToken: page.nextContinuationToken } : {}),
      };
      return response;
    }

    // Direct record source if provided
    if (dependencies.recordSource !== undefined) {
      const rows = await dependencies.recordSource(transaction, scope, command);
      const choices = deriveRecordReferenceChoices(rows, {
        recordTypeIds: command.recordTypeIds,
        search: command.search,
        labelFieldId: command.labelFieldId,
        pageSize: command.pageSize,
      });
      const response: ReferenceChoicePage = {
        outcome: "completed",
        kind: "record_reference",
        choices,
      };
      return response;
    }

    // Without a specific query or record source, return empty permitted page
    return {
      outcome: "completed",
      kind: "record_reference",
      choices: [],
    };
  };

  const handleAccountReferenceChoices = async (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    command: OrganizationAccountReferenceChoiceCommand,
  ): Promise<ReferenceChoiceResult> => {
    let candidates: readonly ActiveAccountCandidate[] = [];

    if (dependencies.accountSource !== undefined) {
      candidates = await dependencies.accountSource(transaction, scope, command);
    }

    const choices = deriveAccountReferenceChoices(candidates, scope.organizationId, {
      search: command.search,
      pageSize: command.pageSize,
    });

    const response: ReferenceChoicePage = {
      outcome: "completed",
      kind: "organization_account_reference",
      choices,
    };
    return response;
  };

  return Object.freeze({
    async run(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ReferenceChoiceResult>> {
      const commandParsed = referenceChoiceCommandSchema.safeParse(commandCandidate);
      if (!commandParsed.success) {
        return { kind: "available", value: refusal("request_invalid") };
      }
      const command = commandParsed.data;

      return requests.run(session, selection, async (transaction, scope) => {
        if (command.kind === "record_reference") {
          return handleRecordReferenceChoices(transaction, scope, session, selection, command);
        }
        return handleAccountReferenceChoices(transaction, scope, command);
      });
    },
  });
}
