import "server-only";

import { createHash } from "node:crypto";
import {
  organizationSetupReceiptCommandSchema,
  organizationSetupReceiptResultSchema,
  organizationSetupReceiptSchema,
  type OrganizationSetupReceiptResult,
} from "@vortex/contracts";
import { withRuntimeTransaction, type RequestDatabaseTransaction } from "@vortex/db";

type RuntimeTransactionRunner = <Result>(
  operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

export type OrganizationSetupReceiptReaderDependencies = Readonly<{
  runtimeTransaction?: RuntimeTransactionRunner;
}>;

const refused = Object.freeze({ kind: "refused" as const });
const sameId = (actual: string, expected: string): boolean =>
  actual.toLowerCase() === expected.toLowerCase();

/** Reads original immutable creation evidence without creating any setup authority. */
export const createOrganizationSetupReceiptReader = (
  dependencies: OrganizationSetupReceiptReaderDependencies = {},
) => {
  const runtimeTransaction = dependencies.runtimeTransaction ?? withRuntimeTransaction;
  return Object.freeze({
    async read(candidate: unknown): Promise<OrganizationSetupReceiptResult> {
      try {
        const parsed = organizationSetupReceiptCommandSchema.safeParse(candidate);
        if (!parsed.success) return refused;
        const { command, result } = parsed.data;
        const tenantId =
          result.operation === "provision_tenant"
            ? result.tenantId
            : command.operation === "create_tenant_organization"
              ? command.tenantId
              : undefined;
        if (tenantId === undefined || command.operation !== result.operation) return refused;
        const organizationId =
          result.operation === "provision_tenant"
            ? result.rootOrganizationId
            : result.organizationId;
        // Match the creation writers' parsed-command bytes, including their schema field order.
        const commandFingerprint = `sha256:${createHash("sha256")
          .update(JSON.stringify(command), "utf8")
          .digest("hex")}`;

        return await runtimeTransaction(
          async (transaction): Promise<OrganizationSetupReceiptResult> => {
            const rows = await transaction.query`
              select tenant_id as "tenantId",
                organization_id as "organizationId",
                organization_account_id as "organizationAccountId",
                identity_id as "identityId",
                operation_key as "operation",
                receipt_id as "receiptId",
                command_fingerprint as "commandFingerprint"
              from vortex_identity.read_organization_setup_receipt(
                ${result.correlationId}::uuid,
                ${command.operation}::text,
                ${organizationId}::uuid
              )
            `;
            if (rows.length !== 1) return refused;
            const receipt = organizationSetupReceiptSchema.safeParse(rows[0]);
            if (!receipt.success) return refused;
            const evidence = receipt.data;
            if (
              !sameId(evidence.tenantId, tenantId) ||
              !sameId(evidence.organizationId, organizationId) ||
              !sameId(evidence.organizationAccountId, result.organizationAccountId) ||
              !sameId(evidence.identityId, command.organizationSteward.identityId) ||
              evidence.operation !== command.operation ||
              evidence.operation !== result.operation ||
              !sameId(evidence.receiptId, result.correlationId) ||
              evidence.commandFingerprint !== commandFingerprint
            )
              return refused;
            return organizationSetupReceiptResultSchema.parse({ kind: "available", receipt: evidence });
          },
        );
      } catch {
        return refused;
      }
    },
  });
};

const defaultReader = createOrganizationSetupReceiptReader();
export const readOrganizationSetupReceipt = defaultReader.read;
