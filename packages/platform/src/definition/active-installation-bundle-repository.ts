import "server-only";

import { correlationIdSchema, jsonValueSchema } from "../catalogue/common";
import {
  fingerprintSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  applicationRootIdSchema,
  revisionSchema,
  semanticVersionSchema,
  namespacedKeySchema,
} from "../catalogue/identifiers";
import {
  activeApplicationInstallationEvidenceSchema,
  type ActiveApplicationInstallationEvidence,
} from "../files/storage";
import {
  installationRuntimeBundleIndexSchema,
  installationRuntimeBundleKeySchema,
  installationRuntimeBundleSections,
} from "./installation-runtime-bundle";
import { stableDefinitionReleaseVersionSchema } from "./version-impact";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import { z } from "zod";
import {
  createInstallationRuntimeBundleRepository,
  type InstallationRuntimeBundleSections,
} from "./installation-runtime-bundle-repository";
import {
  DefinitionError,
  classifyDatabaseError,
  unexpectedDefinitionFailure,
} from "./definition-error";

const activeIdentitySchema = z
  .object({
    tenantId: z.uuid(),
    organizationId: organizationIdSchema,
    organizationAccountId: z.uuid(),
    identityId: z.uuid(),
    sessionId: z.uuid(),
    accessVersion: revisionSchema,
    correlationId: correlationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
    registeredApplication: z
      .object({
        rootId: applicationRootIdSchema,
        definitionKey: namespacedKeySchema,
        releaseRevision: revisionSchema,
        releaseVersion: stableDefinitionReleaseVersionSchema,
        validationContractVersion: semanticVersionSchema,
        contentFingerprint: fingerprintSchema,
        resolutionFingerprint: fingerprintSchema,
      })
      .strict(),
    moduleBindings: z
      .array(
        z
          .object({
            moduleRootId: moduleRootIdSchema,
            moduleReleaseRevision: revisionSchema,
            bindingRevision: revisionSchema,
            state: z.literal("active"),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
    pinFacts: z
      .array(
        z
          .object({
            moduleRootId: moduleRootIdSchema,
            moduleReleaseRevision: revisionSchema,
            contentFingerprint: fingerprintSchema,
            resolutionFingerprint: fingerprintSchema,
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
    pinFingerprint: fingerprintSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.registeredApplication.rootId !== value.applicationRootId ||
      value.registeredApplication.releaseRevision !== value.applicationReleaseRevision
    )
      context.addIssue({
        code: "custom",
        message: "Active bundle identity must match its registered Application",
      });
    const roots = value.moduleBindings.map((binding) => binding.moduleRootId.toLowerCase());
    if (new Set(roots).size !== roots.length)
      context.addIssue({
        code: "custom",
        path: ["moduleBindings"],
        message: "Active bindings must be unique",
      });
    if (roots.some((root, index) => index > 0 && roots[index - 1]! >= root))
      context.addIssue({
        code: "custom",
        path: ["moduleBindings"],
        message: "Active bindings must be ordered",
      });
    const pinRoots = value.pinFacts.map((pin) => pin.moduleRootId.toLowerCase());
    if (
      roots.length !== pinRoots.length ||
      roots.some((root, index) => root !== pinRoots[index]) ||
      value.pinFacts.some(
        (pin, index) =>
          pin.moduleReleaseRevision !== value.moduleBindings[index]?.moduleReleaseRevision,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["pinFacts"],
        message: "Active pins must match the binding set",
      });
  });

export const activeInstallationBundleStateSchema = z
  .object({
    identity: activeIdentitySchema,
    bundleIndex: installationRuntimeBundleIndexSchema.nullable(),
    repairNeeded: z.boolean(),
    coldSource: jsonValueSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.repairNeeded !== (value.bundleIndex === null))
      context.addIssue({
        code: "custom",
        path: ["repairNeeded"],
        message: "Bundle repair state is inconsistent",
      });
    if (value.repairNeeded !== (value.coldSource !== null))
      context.addIssue({
        code: "custom",
        path: ["coldSource"],
        message: "Cold source must accompany only a missing bundle",
      });
    if (
      value.bundleIndex !== null &&
      (value.bundleIndex.organizationId !== value.identity.organizationId ||
        value.bundleIndex.applicationRootId !== value.identity.applicationRootId ||
        value.bundleIndex.applicationReleaseRevision !==
          value.identity.applicationReleaseRevision ||
        value.bundleIndex.pinFingerprint !== value.identity.pinFingerprint)
    )
      context.addIssue({
        code: "custom",
        path: ["bundleIndex"],
        message: "Bundle index must match active identity",
      });
  });

export type ActiveInstallationBundleState = z.infer<typeof activeInstallationBundleStateSchema>;

type StateRow = DatabaseRow & { readonly bundle_state: unknown };

export const activeInstallationBundleErrorCodes = [
  "ACTIVE_INSTALLATION_BUNDLE_REFUSED",
  "ACTIVE_INSTALLATION_BUNDLE_UNAVAILABLE",
  "ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED",
  "ACTIVE_INSTALLATION_BUNDLE_STORAGE_FAILED",
] as const;

export type ActiveInstallationBundleErrorCode = (typeof activeInstallationBundleErrorCodes)[number];

const failure = (error: unknown): DefinitionError<ActiveInstallationBundleErrorCode> => {
  if (error instanceof DefinitionError) return error;
  const kind = classifyDatabaseError(error);
  if (kind === "refused" || kind === "invalid")
    return new DefinitionError("ACTIVE_INSTALLATION_BUNDLE_REFUSED", { cause: error });
  if (kind === "not_found")
    return new DefinitionError("ACTIVE_INSTALLATION_BUNDLE_UNAVAILABLE", { cause: error });
  return unexpectedDefinitionFailure(
    "ACTIVE_INSTALLATION_BUNDLE_STORAGE_FAILED",
    error,
    "active-installation-bundle-repository",
  );
};

export interface ActiveInstallationBundleRepository {
  readCurrentState(): Promise<ActiveInstallationBundleState>;
  readCurrent(): Promise<ActiveApplicationInstallationEvidence>;
  readSections(state: ActiveInstallationBundleState): Promise<InstallationRuntimeBundleSections>;
}

/** Reads only the active format-2 bundle under the verified HUMAN request transaction. */
export const createActiveInstallationBundleRepository = (
  transaction: RequestDatabaseTransaction,
): ActiveInstallationBundleRepository => {
  let statePromise: Promise<ActiveInstallationBundleState> | undefined;
  const bundles = createInstallationRuntimeBundleRepository(transaction);

  const readCurrentState = async (): Promise<ActiveInstallationBundleState> => {
    if (statePromise !== undefined) return statePromise;
    statePromise = (async () => {
      try {
        const rows = await transaction.query<StateRow>`
          select vortex_definition.read_active_installation_bundle_identity() as bundle_state
        `;
        if (rows.length !== 1 || rows[0] === undefined)
          throw new DefinitionError("ACTIVE_INSTALLATION_BUNDLE_UNAVAILABLE");
        const parsed = activeInstallationBundleStateSchema.safeParse(rows[0].bundle_state);
        if (!parsed.success)
          throw unexpectedDefinitionFailure(
            "ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED",
            parsed.error,
            "active-installation-bundle-repository",
          );
        const roots = parsed.data.identity.moduleBindings.map((binding) => binding.moduleRootId);
        if (
          new Set(roots.map((root) => root.toLowerCase())).size !== roots.length ||
          parsed.data.identity.moduleBindings.some(
            (binding, index) =>
              index > 0 && roots[index - 1]!.toLowerCase() >= binding.moduleRootId.toLowerCase(),
          )
        )
          throw new DefinitionError("ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED");
        return parsed.data;
      } catch (error) {
        throw failure(error);
      }
    })();
    return statePromise;
  };

  return Object.freeze({
    readCurrentState,
    async readCurrent() {
      const state = await readCurrentState();
      const identity = state.identity;
      const installation = activeApplicationInstallationEvidenceSchema.safeParse({
        organizationId: identity.organizationId,
        applicationRootId: identity.applicationRootId,
        applicationReleaseRevision: identity.applicationReleaseRevision,
        moduleBindings: identity.moduleBindings.map((binding) => ({
          organizationId: identity.organizationId,
          applicationRootId: identity.applicationRootId,
          applicationReleaseRevision: identity.applicationReleaseRevision,
          moduleRootId: binding.moduleRootId,
          bindingRevision: binding.bindingRevision,
          moduleReleaseRevision: binding.moduleReleaseRevision,
          state: binding.state,
        })),
      });
      if (!installation.success)
        throw unexpectedDefinitionFailure(
          "ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED",
          installation.error,
          "active-installation-bundle-repository",
        );
      return installation.data;
    },
    async readSections(state: ActiveInstallationBundleState) {
      if (state.bundleIndex === null)
        throw new DefinitionError("ACTIVE_INSTALLATION_BUNDLE_UNAVAILABLE");
      try {
        const keyCandidate = installationRuntimeBundleKeySchema.safeParse({
          applicationRootId: state.identity.applicationRootId,
          applicationReleaseRevision: state.identity.applicationReleaseRevision,
          bundleFormatVersion: 2,
        });
        if (!keyCandidate.success)
          throw unexpectedDefinitionFailure(
            "ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED",
            keyCandidate.error,
            "active-installation-bundle-repository",
          );
        return await bundles.readSections(keyCandidate.data, installationRuntimeBundleSections);
      } catch (error) {
        throw failure(error);
      }
    },
  });
};
