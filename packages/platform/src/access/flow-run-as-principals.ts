import "server-only";
import { databaseCode } from "../catalogue/runtime-primitives";

import { z } from "zod";
import {
  applicationRootIdSchema,
  containedComponentIdSchema,
  organizationIdSchema,
  ruleIdSchema,
  stableDefinitionReleaseVersionSchema,
} from "../catalogue/identifiers";
import { flowRunAsPrincipalSchema } from "../workflows/flow-run-as-principal";
import type { FlowRunAsPrincipal } from "../workflows/flow-run-as-principal";
import type { DatabaseRow, RuntimeDatabaseTransaction } from "../db/request-transaction";

const flowRunAsPrincipalScopeShape = {
  organizationId: organizationIdSchema,
  applicationRootId: applicationRootIdSchema,
  releaseVersion: stableDefinitionReleaseVersionSchema,
  flowId: ruleIdSchema,
} as const;

/** Runtime reads require the full compiled scope and never fall back to another revision or actor. */
export const readFlowRunAsPrincipalForRunCommandSchema = z
  .object({
    executionBindingId: containedComponentIdSchema,
    ...flowRunAsPrincipalScopeShape,
  })
  .strict();

export const flowRunAsPrincipalReadResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), principal: flowRunAsPrincipalSchema }).strict(),
  z.object({ outcome: z.literal("unavailable") }).strict(),
]);

export type ReadFlowRunAsPrincipalForRunCommand = z.infer<
  typeof readFlowRunAsPrincipalForRunCommandSchema
>;
export type FlowRunAsPrincipalReadResult = z.infer<typeof flowRunAsPrincipalReadResultSchema>;

export const flowRunAsPrincipalErrorCodes = [
  "INVALID_FLOW_RUN_AS_PRINCIPAL_COMMAND",
  "INVALID_FLOW_RUN_AS_PRINCIPAL_STORAGE_RESULT",
  "FLOW_RUN_AS_PRINCIPAL_SCOPE_UNAVAILABLE",
  "FLOW_RUN_AS_PRINCIPAL_STALE_OR_UNAVAILABLE",
  "FLOW_RUN_AS_PRINCIPAL_DUPLICATE_CONFLICTS",
  "FLOW_RUN_AS_PRINCIPAL_ALREADY_EXISTS",
  "FLOW_RUN_AS_PRINCIPAL_OPERATION_FAILED",
] as const;

export type FlowRunAsPrincipalErrorCode = (typeof flowRunAsPrincipalErrorCodes)[number];

export class FlowRunAsPrincipalError extends Error {
  readonly code: FlowRunAsPrincipalErrorCode;

  constructor(code: FlowRunAsPrincipalErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "FlowRunAsPrincipalError";
    this.code = code;
  }
}

type ReadResultRow = DatabaseRow & { outcome: unknown; result: unknown };

const mapStorageFailure = (error: unknown): FlowRunAsPrincipalError => {
  const code = databaseCode(error);
  if (code === "22023")
    return new FlowRunAsPrincipalError("INVALID_FLOW_RUN_AS_PRINCIPAL_COMMAND", {
      cause: error,
    });
  if (code === "42501")
    return new FlowRunAsPrincipalError("FLOW_RUN_AS_PRINCIPAL_SCOPE_UNAVAILABLE", {
      cause: error,
    });
  if (code === "V3101" || code === "V3102" || code === "40001")
    return new FlowRunAsPrincipalError("FLOW_RUN_AS_PRINCIPAL_STALE_OR_UNAVAILABLE", {
      cause: error,
    });
  if (code === "V3001")
    return new FlowRunAsPrincipalError("FLOW_RUN_AS_PRINCIPAL_DUPLICATE_CONFLICTS", {
      cause: error,
    });
  if (code === "23505")
    return new FlowRunAsPrincipalError("FLOW_RUN_AS_PRINCIPAL_ALREADY_EXISTS", { cause: error });
  return new FlowRunAsPrincipalError("FLOW_RUN_AS_PRINCIPAL_OPERATION_FAILED", { cause: error });
};

const requireOne = <Row extends DatabaseRow>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new FlowRunAsPrincipalError("INVALID_FLOW_RUN_AS_PRINCIPAL_STORAGE_RESULT");
  return rows[0];
};

const parsePrincipal = (value: unknown): FlowRunAsPrincipal => {
  const parsed = flowRunAsPrincipalSchema.safeParse(value);
  if (!parsed.success)
    throw new FlowRunAsPrincipalError("INVALID_FLOW_RUN_AS_PRINCIPAL_STORAGE_RESULT", {
      cause: parsed.error,
    });
  return parsed.data;
};

/**
 * Reads the active principal for one exact compiled scope. Revoked, expired or mismatched records
 * are unavailable.
 */
export const readFlowRunAsPrincipalForRun = async (
  transaction: RuntimeDatabaseTransaction,
  commandCandidate: ReadFlowRunAsPrincipalForRunCommand,
): Promise<FlowRunAsPrincipalReadResult> => {
  const command = readFlowRunAsPrincipalForRunCommandSchema.safeParse(commandCandidate);
  if (!command.success)
    throw new FlowRunAsPrincipalError("INVALID_FLOW_RUN_AS_PRINCIPAL_COMMAND", {
      cause: command.error,
    });
  const value = command.data;
  let rows: readonly ReadResultRow[];
  try {
    rows = await transaction.query<ReadResultRow>`
      select outcome, result
      from vortex_access.read_flow_run_as_principal_for_run(
        ${value.executionBindingId}::uuid,
        ${value.organizationId}::uuid,
        ${value.applicationRootId}::uuid,
        ${value.releaseVersion}::text,
        ${value.flowId}::uuid
      )
    `;
  } catch (error) {
    throw mapStorageFailure(error);
  }
  const row = requireOne(rows);
  if (row.outcome === "unavailable") return { outcome: "unavailable" };
  if (row.outcome !== "available")
    throw new FlowRunAsPrincipalError("INVALID_FLOW_RUN_AS_PRINCIPAL_STORAGE_RESULT");
  const parsed = flowRunAsPrincipalReadResultSchema.safeParse({
    outcome: "available",
    principal: parsePrincipal(row.result),
  });
  if (!parsed.success)
    throw new FlowRunAsPrincipalError("INVALID_FLOW_RUN_AS_PRINCIPAL_STORAGE_RESULT", {
      cause: parsed.error,
    });
  return parsed.data;
};
