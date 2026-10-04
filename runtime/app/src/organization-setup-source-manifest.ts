import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalJson,
  compareCanonicalStrings,
  namespacedKeySchema,
  organizationSetupReceiptResultSchema,
  organizationSetupReceiptSchema,
  organizationSetupSourceManifestCommandSchema,
  organizationSetupSourceManifestResultSchema,
  organizationSetupSourceManifestSchema,
  semanticVersionSchema,
  storedDefinitionSourceSchema,
  type OrganizationSetupReceipt,
  type OrganizationSetupReceiptCommand,
  type OrganizationSetupReceiptResult,
  type OrganizationSetupSourceManifest,
  type OrganizationSetupSourceManifestResult,
  type StoredDefinitionSource,
} from "@vortex/contracts";
import { withRuntimeTransaction, type RequestDatabaseTransaction } from "@vortex/db";

export type OrganizationSetupSourceManifestSelection = Readonly<{
  sourceManifestIdentity: string;
  sourceManifestVersion: string;
  sources: readonly StoredDefinitionSource[];
  intendedDefaultDefinitionKey: string;
}>;

export type OrganizationSetupSourceManifestServiceDependencies = Readonly<{
  readReceipt: (
    creation: OrganizationSetupReceiptCommand,
  ) => Promise<OrganizationSetupReceiptResult>;
  selectSources: (
    context: Readonly<Pick<OrganizationSetupReceipt, "tenantId" | "organizationId" | "operation">>,
  ) => Promise<OrganizationSetupSourceManifestSelection>;
}>;

export type OrganizationSetupSourceManifestService = Readonly<{
  claimOrRead: (candidate: unknown) => Promise<OrganizationSetupSourceManifestResult>;
}>;

const refused = Object.freeze({ kind: "refused" as const });
const maximumCanonicalBytes = 16 * 1024 * 1024;
const unavailable = (): Error => new Error("Organisation setup source checkpoint is unavailable");
const fingerprint = (text: string): string =>
  `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const sameReceipt = (left: OrganizationSetupReceipt, right: OrganizationSetupReceipt): boolean =>
  sameId(left.tenantId, right.tenantId) &&
  sameId(left.organizationId, right.organizationId) &&
  sameId(left.organizationAccountId, right.organizationAccountId) &&
  sameId(left.identityId, right.identityId) &&
  sameId(left.receiptId, right.receiptId) &&
  left.operation === right.operation &&
  left.commandFingerprint === right.commandFingerprint;

const selectionSchema = z
  .object({
    sourceManifestIdentity: namespacedKeySchema,
    sourceManifestVersion: semanticVersionSchema.max(120),
    sources: z.array(storedDefinitionSourceSchema).min(1).max(64),
    intendedDefaultDefinitionKey: namespacedKeySchema,
  })
  .strict();

const internalRowSchema = z.discriminatedUnion("result_kind", [
  z.object({ result_kind: z.literal("missing"), checkpoint: z.null() }).strict(),
  z
    .object({ result_kind: z.literal("pending"), checkpoint: organizationSetupSourceManifestSchema })
    .strict(),
]);

const originalReceipt = (creation: OrganizationSetupReceiptCommand): OrganizationSetupReceipt => {
  const { command, result } = creation;
  const tenantId =
    result.operation === "provision_tenant"
      ? result.tenantId
      : command.operation === "create_tenant_organization"
        ? command.tenantId
        : undefined;
  if (tenantId === undefined || command.operation !== result.operation) throw unavailable();
  return organizationSetupReceiptSchema.parse({
    tenantId: tenantId.toLowerCase(),
    organizationId: (
      result.operation === "provision_tenant" ? result.rootOrganizationId : result.organizationId
    ).toLowerCase(),
    organizationAccountId: result.organizationAccountId.toLowerCase(),
    identityId: command.organizationSteward.identityId.toLowerCase(),
    operation: command.operation,
    receiptId: result.correlationId.toLowerCase(),
    // Original creation writers hash parsed-command JSON, never the canonical manifest algorithm.
    commandFingerprint: fingerprint(JSON.stringify(command)),
  });
};

const hashPayload = (manifest: OrganizationSetupSourceManifest) => ({
  receipt: manifest.receipt,
  sourceManifestIdentity: manifest.sourceManifestIdentity,
  sourceManifestVersion: manifest.sourceManifestVersion,
  sources: manifest.sources,
  intendedDefaultDefinitionKey: manifest.intendedDefaultDefinitionKey,
});

const checkedCanonicalText = (payload: unknown): string => {
  const text = canonicalJson(payload);
  if (Buffer.byteLength(text, "utf8") > maximumCanonicalBytes) throw unavailable();
  return text;
};

const checkedPending = (
  manifest: OrganizationSetupSourceManifest,
  expected: OrganizationSetupReceipt,
): OrganizationSetupSourceManifestResult => {
  if (!sameReceipt(manifest.receipt, expected)) throw unavailable();
  for (const entry of manifest.sources)
    if (entry.sourceFingerprint !== fingerprint(canonicalJson(entry.source))) throw unavailable();
  if (manifest.manifestFingerprint !== fingerprint(checkedCanonicalText(hashPayload(manifest))))
    throw unavailable();
  return organizationSetupSourceManifestResultSchema.parse({ kind: "pending", manifest });
};

const callClaim = async (
  transaction: RequestDatabaseTransaction,
  receipt: OrganizationSetupReceipt,
  text: string | null,
  manifestFingerprint: string | null,
) => {
  const rows = await transaction.query`
    select result_kind, checkpoint
    from vortex_module.claim_organization_setup_source_manifest(
      ${receipt.tenantId}::uuid,
      ${receipt.organizationId}::uuid,
      ${receipt.organizationAccountId}::uuid,
      ${receipt.identityId}::uuid,
      ${receipt.operation}::text,
      ${receipt.receiptId}::uuid,
      ${receipt.commandFingerprint}::text,
      ${0}::integer,
      ${text}::text,
      ${manifestFingerprint}::text
    )
  `;
  if (rows.length !== 1) throw unavailable();
  return internalRowSchema.parse(rows[0]);
};

/** Freezes initial source data; no setup capability, publication or effective rights are produced. */
export const createOrganizationSetupSourceManifestService = (
  dependencies: OrganizationSetupSourceManifestServiceDependencies,
): OrganizationSetupSourceManifestService =>
  Object.freeze({
    async claimOrRead(candidate: unknown): Promise<OrganizationSetupSourceManifestResult> {
      try {
        const parsed = organizationSetupSourceManifestCommandSchema.safeParse(candidate);
        if (!parsed.success) return refused;
        // Derive the expected original facts before invoking any injected dependency.
        const expected = originalReceipt(parsed.data.creation);
        const read = organizationSetupReceiptResultSchema.parse(
          await dependencies.readReceipt(parsed.data.creation),
        );
        if (read.kind !== "available" || !sameReceipt(read.receipt, expected)) return refused;

        return await withRuntimeTransaction(async (transaction) => {
          const existing = await callClaim(transaction, expected, null, null);
          if (existing.result_kind === "pending")
            return checkedPending(existing.checkpoint, expected);

          const selected = selectionSchema.parse(
            await dependencies.selectSources(
              Object.freeze({
                tenantId: expected.tenantId,
                organizationId: expected.organizationId,
                operation: expected.operation,
              }),
            ),
          );
          const sources = selected.sources
            .map((source) => ({
              kind: source.kind,
              key: source.key,
              sourceContractVersion: source.source_contract_version,
              source,
              sourceFingerprint: fingerprint(canonicalJson(source)),
            }))
            .sort((left, right) =>
              compareCanonicalStrings(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
            );
          const identities = new Set(sources.map((source) => `${source.kind}:${source.key}`));
          if (
            identities.size !== sources.length ||
            !sources.some(
              (source) =>
                source.kind === "application" &&
                source.key === selected.intendedDefaultDefinitionKey,
            )
          )
            throw unavailable();
          const text = checkedCanonicalText({
            receipt: expected,
            sourceManifestIdentity: selected.sourceManifestIdentity,
            sourceManifestVersion: selected.sourceManifestVersion,
            sources,
            intendedDefaultDefinitionKey: selected.intendedDefaultDefinitionKey,
          });
          const claimed = await callClaim(transaction, expected, text, fingerprint(text));
          if (claimed.result_kind !== "pending") throw unavailable();
          // Throw inside the transaction on malformed storage evidence so an insert cannot commit.
          return checkedPending(claimed.checkpoint, expected);
        });
      } catch {
        return refused;
      }
    },
  });
