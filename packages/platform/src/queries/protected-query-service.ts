import "server-only";

import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestResult,
} from "../access/human-organization-request";
import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import type { ExecutionAuthorityContext } from "../workflows/flow-contracts";
import {
  boardMembersCommand,
  boardColumnPagesCommandSchema,
  boardColumnPagesCommand,
} from "./protected-query-board";
import {
  type ProtectedQueryResult,
  protectedQueryCommandSchema,
  protectedQueryBoardMembersCommandSchema,
  type ProtectedQueryGroupedMembersResult,
  protectedQueryGroupedMembersCommandSchema,
  type ProtectedQueryTreeLevelResult,
  protectedQueryTreeLevelCommandSchema,
  type ProtectedQuerySummaryResult,
  protectedQuerySummaryCommandSchema,
  type ProtectedQueryBoardSummaryResult,
  protectedQueryBoardSummaryCommandSchema,
} from "./protected-query-contracts";
import { groupedMembersCommand } from "./protected-query-grouped";
import { treeLevelCommand } from "./protected-query-tree";
import { refuseInvalidCommand } from "./protected-query-helpers";
import { summariseCommand, boardSummaryCommand } from "./protected-query-summary";
import { runCommand } from "./protected-query-table";
import type { ProtectedQueryServiceDependencies } from "./protected-query-types";
import type {
  ProtectedQueryRow,
  ProtectedQuerySummaryCompleted,
} from "./protected-query-contracts";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import type { SelectedOrganizationScope } from "../access/identity-access";

export type { ProtectedQueryServiceDependencies } from "./protected-query-types";

/**
 * A decision the caller takes inside the read's own request transaction, after a completed read
 * and from the rows it returned (none for a summary, which passes its completed summary instead):
 * one protected request carries the read and every viewer decision the page shows beside it. The
 * caller keeps what it decides.
 */
export type ProtectedReadDecider = (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  issuedAt: string,
  rows: readonly ProtectedQueryRow[],
  summary?: ProtectedQuerySummaryCompleted,
) => Promise<void>;

/**
 * Protected Query execution for one published Module query. The verified
 * request supplies the organisation, Application and actor; the database
 * resolves the query from the exact installed release, reads only rows the
 * record projection admits, and returns one bounded keyset page with an opaque
 * continuation, or one neutral refusal before any row is exposed.
 */
export const createProtectedQueryService = (dependencies: ProtectedQueryServiceDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const { continuationKey } = dependencies;

  /**
   * The one validation and cache wiring of a protected read. A refusal is the final result; a
   * ready read runs inside a request transaction the caller already holds, so a caller that must
   * decide authority and read in one transaction (the export) shares this path with `run`.
   */
  const prepareRead = (
    caller: IdentitySession | ExecutionAuthorityContext,
    selection: OrganizationSelectionCandidate,
    commandCandidate: unknown,
  ):
    | Readonly<{
        kind: "ready";
        person: IdentitySession;
        read: (
          transaction: Parameters<typeof runCommand>[0],
          scope: Parameters<typeof runCommand>[1],
        ) => Promise<ProtectedQueryResult>;
      }>
    | Readonly<{ kind: "final"; result: HumanOrganizationRequestResult<ProtectedQueryResult> }> => {
    // Do not turn a non-person authority into a person session on this adapter.
    if (caller !== null && typeof caller === "object" && "kind" in caller)
      return { kind: "final", result: { kind: "unavailable" } };
    const command = protectedQueryCommandSchema.safeParse(commandCandidate);
    if (!command.success)
      return {
        kind: "final",
        result: { kind: "available", value: refuseInvalidCommand(command.error) },
      };
    if (selection.applicationRootId === undefined)
      return { kind: "final", result: { kind: "unavailable" } };
    return {
      kind: "ready",
      person: caller,
      read: (transaction, scope) => runCommand(transaction, scope, command.data, continuationKey),
    };
  };

  return Object.freeze({
    async run(
      caller: IdentitySession | ExecutionAuthorityContext,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
      decide?: ProtectedReadDecider,
    ): Promise<HumanOrganizationRequestResult<ProtectedQueryResult>> {
      const prepared = prepareRead(caller, selection, commandCandidate);
      if (prepared.kind === "final") return prepared.result;
      return requests.run(prepared.person, selection, async (transaction, scope, issuedAt) => {
        const result = await prepared.read(transaction, scope);
        if (decide !== undefined && result.outcome === "completed")
          await decide(transaction, scope, issuedAt, result.rows);
        return result;
      });
    },
    /** Validates a protected read for a caller that runs it inside its own request transaction. */
    prepareRead,
    async boardMembers(
      caller: IdentitySession | ExecutionAuthorityContext,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ProtectedQueryResult>> {
      if (caller !== null && typeof caller === "object" && "kind" in caller)
        return { kind: "unavailable" };
      const command = protectedQueryBoardMembersCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return { kind: "available", value: refuseInvalidCommand(command.error) };
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      return requests.run(caller, selection, (transaction, scope) =>
        boardMembersCommand(transaction, scope, command.data, continuationKey),
      );
    },
    async boardColumnPages(
      caller: IdentitySession | ExecutionAuthorityContext,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<
      HumanOrganizationRequestResult<
        | Readonly<{ outcome: "completed"; pages: readonly ProtectedQueryResult[] }>
        | Extract<ProtectedQueryResult, { outcome: "refused" }>
      >
    > {
      if (caller !== null && typeof caller === "object" && "kind" in caller)
        return { kind: "unavailable" };
      const command = boardColumnPagesCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return { kind: "available", value: refuseInvalidCommand(command.error) };
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      return requests.run(caller, selection, (transaction, scope) =>
        boardColumnPagesCommand(transaction, scope, command.data, continuationKey),
      );
    },
    async groupedMembers(
      caller: IdentitySession | ExecutionAuthorityContext,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
      decide?: ProtectedReadDecider,
    ): Promise<HumanOrganizationRequestResult<ProtectedQueryGroupedMembersResult>> {
      if (caller !== null && typeof caller === "object" && "kind" in caller)
        return { kind: "unavailable" };
      const personCaller: IdentitySession = caller;
      const command = protectedQueryGroupedMembersCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return { kind: "available", value: refuseInvalidCommand(command.error) };
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      return requests.run(personCaller, selection, async (transaction, scope, issuedAt) => {
        const result = await groupedMembersCommand(
          transaction,
          scope,
          personCaller,
          command.data,
          continuationKey,
        );
        if (decide !== undefined && result.outcome === "completed")
          await decide(transaction, scope, issuedAt, result.rows);
        return result;
      });
    },
    async treeLevel(
      caller: IdentitySession | ExecutionAuthorityContext,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
      decide?: ProtectedReadDecider,
    ): Promise<HumanOrganizationRequestResult<ProtectedQueryTreeLevelResult>> {
      if (caller !== null && typeof caller === "object" && "kind" in caller)
        return { kind: "unavailable" };
      const personCaller: IdentitySession = caller;
      const command = protectedQueryTreeLevelCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return { kind: "available", value: refuseInvalidCommand(command.error) };
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      return requests.run(personCaller, selection, async (transaction, scope, issuedAt) => {
        const result = await treeLevelCommand(
          transaction,
          scope,
          personCaller,
          command.data,
          continuationKey,
        );
        if (decide !== undefined && result.outcome === "completed")
          await decide(transaction, scope, issuedAt, result.rows);
        return result;
      });
    },
    async summarise(
      caller: IdentitySession | ExecutionAuthorityContext,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
      decide?: ProtectedReadDecider,
    ): Promise<HumanOrganizationRequestResult<ProtectedQuerySummaryResult>> {
      if (caller !== null && typeof caller === "object" && "kind" in caller)
        return { kind: "unavailable" };
      const command = protectedQuerySummaryCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return { kind: "available", value: refuseInvalidCommand(command.error) };
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      return requests.run(caller, selection, async (transaction, scope, issuedAt) => {
        const result = await summariseCommand(transaction, scope, command.data);
        if (decide !== undefined && result.outcome === "completed")
          await decide(transaction, scope, issuedAt, [], result);
        return result;
      });
    },
    async boardSummary(
      caller: IdentitySession | ExecutionAuthorityContext,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ProtectedQueryBoardSummaryResult>> {
      if (caller !== null && typeof caller === "object" && "kind" in caller)
        return { kind: "unavailable" };
      const command = protectedQueryBoardSummaryCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return { kind: "available", value: refuseInvalidCommand(command.error) };
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      return requests.run(caller, selection, (transaction, scope) =>
        boardSummaryCommand(transaction, scope, command.data),
      );
    },
  });
};
