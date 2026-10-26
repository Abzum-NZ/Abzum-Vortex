import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { applicationRootIdSchema, type ApplicationRootId } from "../catalogue/identifiers";
import { logRefusal, asRecord } from "../catalogue/runtime-primitives";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
} from "../db/request-transaction";
import { DefinitionError } from "./definition-error";

export const runtimeBundleCleanupLimits = Object.freeze({
  batchSize: 100,
  minimumCredentialLength: 32,
  maximumCredentialLength: 1024,
});

export type RuntimeBundleCleanupAuthentication =
  | Readonly<{ outcome: "authenticated" }>
  | Readonly<{
      outcome: "refused";
      reason: "cleanup_not_configured" | "credential_missing" | "credential_rejected";
    }>;

export type RuntimeBundleCleanupBatchResult = Readonly<{
  bundlesRemoved: number;
  bundlePartsRemoved: number;
  accessPlansRemoved: number;
  orphanedAccessPlansRemoved: number;
}>;

export type InstallationRuntimeBundleRemovalReport = Readonly<{
  bundles: readonly Readonly<{
    applicationReleaseRevision: number;
    bundleFormatVersion: number;
  }>[];
  bundlePartsRemoved: number;
  accessPlansRemoved: number;
}>;

type CleanupRow = DatabaseRow & { readonly cleanup_result: unknown };

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const parseBatchResult = (candidate: unknown): RuntimeBundleCleanupBatchResult => {
  const value = asRecord(candidate);
  if (
    value === undefined ||
    Object.keys(value).length !== 4 ||
    !Object.hasOwn(value, "bundlesRemoved") ||
    !Object.hasOwn(value, "bundlePartsRemoved") ||
    !Object.hasOwn(value, "accessPlansRemoved") ||
    !Object.hasOwn(value, "orphanedAccessPlansRemoved") ||
    !isCount(value.bundlesRemoved) ||
    !isCount(value.bundlePartsRemoved) ||
    !isCount(value.accessPlansRemoved) ||
    !isCount(value.orphanedAccessPlansRemoved)
  )
    throw new DefinitionError("RUNTIME_BUNDLE_CLEANUP_UNAVAILABLE");
  return Object.freeze({
    bundlesRemoved: value.bundlesRemoved,
    bundlePartsRemoved: value.bundlePartsRemoved,
    accessPlansRemoved: value.accessPlansRemoved,
    orphanedAccessPlansRemoved: value.orphanedAccessPlansRemoved,
  });
};

const parseInstallationRemovalReport = (
  candidate: unknown,
): InstallationRuntimeBundleRemovalReport => {
  const value = asRecord(candidate);
  if (
    value === undefined ||
    Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, "bundles") ||
    !Object.hasOwn(value, "bundlePartsRemoved") ||
    !Object.hasOwn(value, "accessPlansRemoved") ||
    !Array.isArray(value.bundles) ||
    !isCount(value.bundlePartsRemoved) ||
    !isCount(value.accessPlansRemoved)
  )
    throw new DefinitionError("RUNTIME_BUNDLE_CLEANUP_UNAVAILABLE");

  const bundles = (value.bundles as readonly unknown[]).map((candidateBundle) => {
    const bundle = asRecord(candidateBundle);
    if (
      bundle === undefined ||
      Object.keys(bundle).length !== 2 ||
      !Object.hasOwn(bundle, "applicationReleaseRevision") ||
      !Object.hasOwn(bundle, "bundleFormatVersion") ||
      !Number.isSafeInteger(bundle.applicationReleaseRevision) ||
      (bundle.applicationReleaseRevision as number) < 1 ||
      !Number.isSafeInteger(bundle.bundleFormatVersion) ||
      (bundle.bundleFormatVersion as number) < 1
    )
      throw new DefinitionError("RUNTIME_BUNDLE_CLEANUP_UNAVAILABLE");
    return Object.freeze({
      applicationReleaseRevision: bundle.applicationReleaseRevision as number,
      bundleFormatVersion: bundle.bundleFormatVersion as number,
    });
  });

  return Object.freeze({
    bundles: Object.freeze(bundles),
    bundlePartsRemoved: value.bundlePartsRemoved,
    accessPlansRemoved: value.accessPlansRemoved,
  });
};

const cleanupCredential = (
  environment: Readonly<Record<string, string | undefined>>,
): Buffer | undefined => {
  const digest = environment.VORTEX_RUNTIME_BUNDLE_CLEANUP_CREDENTIAL_SHA256;
  return digest !== undefined && /^[0-9a-f]{64}$/.test(digest)
    ? Buffer.from(digest, "hex")
    : undefined;
};

/** Authenticates the cleanup route against the configured credential digest in constant time. */
export const authenticateRuntimeBundleCleanup = (
  authorization: string | null | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeBundleCleanupAuthentication => {
  const expectedDigest = cleanupCredential(environment);
  if (expectedDigest === undefined) return { outcome: "refused", reason: "cleanup_not_configured" };

  const match =
    typeof authorization === "string" ? /^Bearer ([\x21-\x7e]+)$/.exec(authorization) : undefined;
  const credential = match?.[1];
  if (
    credential === undefined ||
    credential.length < runtimeBundleCleanupLimits.minimumCredentialLength ||
    credential.length > runtimeBundleCleanupLimits.maximumCredentialLength
  )
    return { outcome: "refused", reason: "credential_missing" };

  const presentedDigest = createHash("sha256").update(credential, "utf8").digest();
  return timingSafeEqual(presentedDigest, expectedDigest)
    ? { outcome: "authenticated" }
    : { outcome: "refused", reason: "credential_rejected" };
};

/** Runs one fixed-size maintenance batch without accepting database credentials or tuning input. */
export const runScheduledRuntimeBundleCleanup =
  async (): Promise<RuntimeBundleCleanupBatchResult> => {
    try {
      const rows = await withRuntimeTransaction(
        (transaction) =>
          transaction.query<CleanupRow>`
        select vortex_definition.remove_abandoned_runtime_bundles(
          ${runtimeBundleCleanupLimits.batchSize}::integer
        ) as cleanup_result
      `,
      );
      if (rows.length !== 1 || rows[0] === undefined)
        throw new DefinitionError("RUNTIME_BUNDLE_CLEANUP_UNAVAILABLE");
      return parseBatchResult(rows[0].cleanup_result);
    } catch (error) {
      throw new DefinitionError("RUNTIME_BUNDLE_CLEANUP_UNAVAILABLE", { cause: error });
    }
  };

/** Removes the exact authenticated organisation's bundle registrations for one uninstalled app. */
export const createInstallationRuntimeBundleCleanupRepository = (
  transaction: RequestDatabaseTransaction,
) =>
  Object.freeze({
    async removeInstallation(
      applicationRootIdCandidate: ApplicationRootId,
    ): Promise<InstallationRuntimeBundleRemovalReport> {
      const parsedRootId = applicationRootIdSchema.safeParse(applicationRootIdCandidate);
      if (!parsedRootId.success) throw new DefinitionError("RUNTIME_BUNDLE_CLEANUP_UNAVAILABLE");
      try {
        const rows = await transaction.query<CleanupRow>`
          select vortex_definition.remove_installation_runtime_bundles(
            ${parsedRootId.data}::uuid
          ) as cleanup_result
        `;
        if (rows.length !== 1 || rows[0] === undefined)
          throw new DefinitionError("RUNTIME_BUNDLE_CLEANUP_UNAVAILABLE");
        return parseInstallationRemovalReport(rows[0].cleanup_result);
      } catch (error) {
        logRefusal("runtime-bundles", "cleanup", "RUNTIME_BUNDLE_CLEANUP_UNAVAILABLE", error);
        throw new DefinitionError("RUNTIME_BUNDLE_CLEANUP_UNAVAILABLE");
      }
    },
  });
