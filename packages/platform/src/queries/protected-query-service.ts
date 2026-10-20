import "server-only";

import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestResult,
} from "../access/index";
import type {
  IdentitySession,
  ExecutionAuthorityContext,
  OrganizationSelectionCandidate,
} from "../schema";
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
import { refusal } from "./protected-query-helpers";
import { summariseCommand, boardSummaryCommand } from "./protected-query-summary";
import { runCommand } from "./protected-query-table";
import type { ProtectedQueryServiceDependencies, QueryCache } from "./protected-query-types";

export type {
  ProtectedQueryCacheContext,
  ProtectedQueryServiceDependencies,
} from "./protected-query-types";

/**
 * Protected Query execution for one published Module query. The verified
 * request supplies the organisation, Application and actor; the database
 * resolves the query from the exact installed release, reads only rows the
 * record projection admits, and returns one bounded keyset page with an opaque
 * continuation, or one neutral refusal before any row is exposed.
 */
export const createProtectedQueryService = (dependencies: ProtectedQueryServiceDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const { continuationKey, sharedCacheStore, resolveQueryCacheContext } = dependencies;
  const now = dependencies.clock ?? (() => new Date());

  return Object.freeze({
    async run(
      caller: IdentitySession | ExecutionAuthorityContext,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ProtectedQueryResult>> {
      // Do not turn a non-person authority into a person session on this adapter.
      if (caller !== null && typeof caller === "object" && "kind" in caller)
        return { kind: "unavailable" };
      const command = protectedQueryCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "available", value: refusal("request_invalid") };
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      const cache: QueryCache | undefined =
        sharedCacheStore === undefined || resolveQueryCacheContext === undefined
          ? undefined
          : {
              store: sharedCacheStore,
              resolveContext: resolveQueryCacheContext,
              now,
              // Verified by the request service before this operation runs.
              sessionExpiresAt: caller.accessTokenExpiresAt,
            };
      return requests.run(caller, selection, (transaction, scope) =>
        runCommand(transaction, scope, command.data, continuationKey, cache),
      );
    },
    async boardMembers(
      caller: IdentitySession | ExecutionAuthorityContext,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ProtectedQueryResult>> {
      if (caller !== null && typeof caller === "object" && "kind" in caller)
        return { kind: "unavailable" };
      const command = protectedQueryBoardMembersCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "available", value: refusal("request_invalid") };
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
        return { kind: "available", value: { outcome: "refused", reasonCode: "request_invalid" } };
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      return requests.run(caller, selection, (transaction, scope) =>
        boardColumnPagesCommand(transaction, scope, command.data, continuationKey),
      );
    },
    async groupedMembers(
      caller: IdentitySession | ExecutionAuthorityContext,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ProtectedQueryGroupedMembersResult>> {
      if (caller !== null && typeof caller === "object" && "kind" in caller)
        return { kind: "unavailable" };
      const personCaller: IdentitySession = caller;
      const command = protectedQueryGroupedMembersCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return {
          kind: "available",
          value: { outcome: "refused", reasonCode: "request_invalid" },
        };
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      return requests.run(personCaller, selection, (transaction, scope) =>
        groupedMembersCommand(transaction, scope, personCaller, command.data, continuationKey),
      );
    },
    async treeLevel(
      caller: IdentitySession | ExecutionAuthorityContext,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ProtectedQueryTreeLevelResult>> {
      if (caller !== null && typeof caller === "object" && "kind" in caller)
        return { kind: "unavailable" };
      const personCaller: IdentitySession = caller;
      const command = protectedQueryTreeLevelCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return {
          kind: "available",
          value: { outcome: "refused", reasonCode: "request_invalid" },
        };
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      return requests.run(personCaller, selection, (transaction, scope) =>
        treeLevelCommand(transaction, scope, personCaller, command.data, continuationKey),
      );
    },
    async summarise(
      caller: IdentitySession | ExecutionAuthorityContext,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ProtectedQuerySummaryResult>> {
      if (caller !== null && typeof caller === "object" && "kind" in caller)
        return { kind: "unavailable" };
      const command = protectedQuerySummaryCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "available", value: refusal("request_invalid") };
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      return requests.run(caller, selection, (transaction, scope) =>
        summariseCommand(transaction, scope, command.data),
      );
    },
    async boardSummary(
      caller: IdentitySession | ExecutionAuthorityContext,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ProtectedQueryBoardSummaryResult>> {
      if (caller !== null && typeof caller === "object" && "kind" in caller)
        return { kind: "unavailable" };
      const command = protectedQueryBoardSummaryCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "available", value: refusal("request_invalid") };
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      return requests.run(caller, selection, (transaction, scope) =>
        boardSummaryCommand(transaction, scope, command.data),
      );
    },
  });
};
