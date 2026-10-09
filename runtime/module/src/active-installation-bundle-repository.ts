import "server-only";

import { createHash } from "node:crypto";
import {
  activeApplicationInstallationEvidenceSchema,
  canonicalJson,
  correlationIdSchema,
  fingerprintSchema,
  installationRuntimeBundleIndexSchema,
  installationRuntimeBundleKeySchema,
  installationRuntimeBundleMaximumPartBytes,
  installationRuntimeBundlePartSchema,
  installationRuntimeBundleSourceManifestSchema,
  installationRuntimeBundleSections,
  installationRuntimeBundleWriteCommandSchema,
  jsonValueSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  applicationRootIdSchema,
  revisionSchema,
  stableDefinitionReleaseVersionSchema,
  semanticVersionSchema,
  namespacedKeySchema,
  type ActiveApplicationInstallationEvidence,
  type InstallationRuntimeBundleIndex,
  type InstallationRuntimeBundleKey,
  type InstallationRuntimeBundlePart,
  type InstallationRuntimeBundleSection,
  type InstallationRuntimeBundleWriteCommand,
  type JsonValue,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { z } from "zod";
import { createInstallationRuntimeBundleRepository } from "./installation-runtime-bundle-repository";

const activeIdentitySchema = z.object({
  tenantId: z.uuid(),
  organizationId: organizationIdSchema,
  organizationAccountId: z.uuid(),
  identityId: z.uuid(),
  sessionId: z.uuid(),
  accessVersion: revisionSchema,
  correlationId: correlationIdSchema,
  applicationRootId: applicationRootIdSchema,
  applicationReleaseRevision: revisionSchema,
  registeredApplication: z.object({
    rootId: applicationRootIdSchema,
    definitionKey: namespacedKeySchema,
    releaseRevision: revisionSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    validationContractVersion: semanticVersionSchema,
    contentFingerprint: fingerprintSchema,
    resolutionFingerprint: fingerprintSchema,
  }).strict(),
  moduleBindings: z.array(z.object({
    moduleRootId: moduleRootIdSchema,
    moduleReleaseRevision: revisionSchema,
    bindingRevision: revisionSchema,
    state: z.literal("active"),
  }).strict()).min(1).max(10_000),
  pinFacts: z.array(z.object({
    moduleRootId: moduleRootIdSchema,
    moduleReleaseRevision: revisionSchema,
    contentFingerprint: fingerprintSchema,
    resolutionFingerprint: fingerprintSchema,
  }).strict()).min(1).max(10_000),
  pinFingerprint: fingerprintSchema,
}).strict().superRefine((value, context) => {
  if (
    value.registeredApplication.rootId !== value.applicationRootId ||
    value.registeredApplication.releaseRevision !== value.applicationReleaseRevision
  ) context.addIssue({ code: "custom", message: "Active bundle identity must match its registered Application" });
  const roots = value.moduleBindings.map((binding) => binding.moduleRootId.toLowerCase());
  if (new Set(roots).size !== roots.length)
    context.addIssue({ code: "custom", path: ["moduleBindings"], message: "Active bindings must be unique" });
  if (roots.some((root, index) => index > 0 && roots[index - 1]! >= root))
    context.addIssue({ code: "custom", path: ["moduleBindings"], message: "Active bindings must be ordered" });
  const pinRoots = value.pinFacts.map((pin) => pin.moduleRootId.toLowerCase());
  if (
    roots.length !== pinRoots.length ||
    roots.some((root, index) => root !== pinRoots[index]) ||
    value.pinFacts.some((pin, index) =>
      pin.moduleReleaseRevision !== value.moduleBindings[index]?.moduleReleaseRevision,
    )
  ) context.addIssue({ code: "custom", path: ["pinFacts"], message: "Active pins must match the binding set" });
});

export const activeInstallationBundleStateSchema = z.object({
  identity: activeIdentitySchema,
  bundleIndex: installationRuntimeBundleIndexSchema.nullable(),
  repairNeeded: z.boolean(),
  coldSource: jsonValueSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.repairNeeded !== (value.bundleIndex === null))
    context.addIssue({ code: "custom", path: ["repairNeeded"], message: "Bundle repair state is inconsistent" });
  if (value.repairNeeded !== (value.coldSource !== null))
    context.addIssue({ code: "custom", path: ["coldSource"], message: "Cold source must accompany only a missing bundle" });
  if (value.bundleIndex !== null && (
    value.bundleIndex.organizationId !== value.identity.organizationId ||
    value.bundleIndex.applicationRootId !== value.identity.applicationRootId ||
    value.bundleIndex.applicationReleaseRevision !== value.identity.applicationReleaseRevision ||
    value.bundleIndex.pinFingerprint !== value.identity.pinFingerprint
  )) context.addIssue({ code: "custom", path: ["bundleIndex"], message: "Bundle index must match active identity" });
});

export type ActiveInstallationBundleState = z.infer<typeof activeInstallationBundleStateSchema>;

type StateRow = DatabaseRow & { readonly bundle_state: unknown };
type RepairRow = DatabaseRow & { readonly bundle_index: unknown };

export const activeInstallationBundleErrorCodes = [
  "ACTIVE_INSTALLATION_BUNDLE_REFUSED",
  "ACTIVE_INSTALLATION_BUNDLE_UNAVAILABLE",
  "ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED",
  "ACTIVE_INSTALLATION_BUNDLE_STORAGE_FAILED",
] as const;

export type ActiveInstallationBundleErrorCode =
  (typeof activeInstallationBundleErrorCodes)[number];

export class ActiveInstallationBundleError extends Error {
  readonly code: ActiveInstallationBundleErrorCode;

  constructor(code: ActiveInstallationBundleErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "ActiveInstallationBundleError";
    this.code = code;
  }
}

const failure = (error: unknown): ActiveInstallationBundleError => {
  if (error instanceof ActiveInstallationBundleError) return error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
  if (code === "42501" || code === "22023")
    return new ActiveInstallationBundleError("ACTIVE_INSTALLATION_BUNDLE_REFUSED", { cause: error });
  if (code === "P0002")
    return new ActiveInstallationBundleError("ACTIVE_INSTALLATION_BUNDLE_UNAVAILABLE", { cause: error });
  return new ActiveInstallationBundleError("ACTIVE_INSTALLATION_BUNDLE_STORAGE_FAILED", { cause: error });
};

const sha256 = (content: string): string =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

const splitSection = (
  section: InstallationRuntimeBundleSection,
  serialized: string,
): InstallationRuntimeBundlePart[] => {
  const result: InstallationRuntimeBundlePart[] = [];
  let content = "";
  let byteSize = 0;
  let ordinal = 0;
  const save = (): void => {
    if (content.length === 0) return;
    result.push({ section, ordinal, byteSize, sha256: sha256(content), content });
    ordinal += 1;
    content = "";
    byteSize = 0;
  };
  for (const character of serialized) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (byteSize + characterBytes > installationRuntimeBundleMaximumPartBytes) save();
    content += character;
    byteSize += characterBytes;
  }
  save();
  return result;
};

const prepareParts = (command: InstallationRuntimeBundleWriteCommand): InstallationRuntimeBundlePart[] => {
  const parts = installationRuntimeBundleSections.flatMap((section) =>
    splitSection(section, canonicalJson(command.sections[section])),
  );
  if (parts.some((part) => !installationRuntimeBundlePartSchema.safeParse(part).success))
    throw new ActiveInstallationBundleError("ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED");
  return parts;
};

export interface ActiveInstallationBundleRepository {
  readCurrentState(): Promise<ActiveInstallationBundleState>;
  readCurrent(): Promise<ActiveApplicationInstallationEvidence>;
  readSections(
    state: ActiveInstallationBundleState,
    expectedIndex?: InstallationRuntimeBundleIndex,
  ): Promise<Readonly<Partial<Record<InstallationRuntimeBundleSection, JsonValue>>>>;
  repair(
    state: ActiveInstallationBundleState,
    commandCandidate: InstallationRuntimeBundleWriteCommand,
  ): Promise<InstallationRuntimeBundleIndex>;
}

/** Reads and repairs only the active format-2 bundle under the verified HUMAN request transaction. */
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
          select vortex_module.read_active_installation_bundle_identity() as bundle_state
        `;
        if (rows.length !== 1 || rows[0] === undefined)
          throw new ActiveInstallationBundleError("ACTIVE_INSTALLATION_BUNDLE_UNAVAILABLE");
        const parsed = activeInstallationBundleStateSchema.safeParse(rows[0].bundle_state);
        if (!parsed.success)
          throw new ActiveInstallationBundleError("ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED");
        const roots = parsed.data.identity.moduleBindings.map((binding) => binding.moduleRootId);
        if (
          new Set(roots.map((root) => root.toLowerCase())).size !== roots.length ||
          parsed.data.identity.moduleBindings.some((binding, index) =>
            index > 0 && roots[index - 1]!.toLowerCase() >= binding.moduleRootId.toLowerCase(),
          )
        ) throw new ActiveInstallationBundleError("ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED");
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
        throw new ActiveInstallationBundleError("ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED");
      return installation.data;
    },
    async readSections(
      state: ActiveInstallationBundleState,
      expectedIndexCandidate?: InstallationRuntimeBundleIndex,
    ) {
      const expectedIndex = expectedIndexCandidate ?? state.bundleIndex;
      if (expectedIndex === null)
        throw new ActiveInstallationBundleError("ACTIVE_INSTALLATION_BUNDLE_UNAVAILABLE");
      try {
        if (
          expectedIndex.organizationId !== state.identity.organizationId ||
          expectedIndex.applicationRootId !== state.identity.applicationRootId ||
          expectedIndex.applicationReleaseRevision !== state.identity.applicationReleaseRevision ||
          expectedIndex.pinFingerprint !== state.identity.pinFingerprint
        ) throw new ActiveInstallationBundleError("ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED");
        const keyCandidate = installationRuntimeBundleKeySchema.safeParse({
          applicationRootId: state.identity.applicationRootId,
          applicationReleaseRevision: state.identity.applicationReleaseRevision,
          bundleFormatVersion: 2,
        });
        if (!keyCandidate.success)
          throw new ActiveInstallationBundleError("ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED");
        const key: InstallationRuntimeBundleKey = {
          applicationRootId: keyCandidate.data.applicationRootId,
          applicationReleaseRevision: keyCandidate.data.applicationReleaseRevision,
          bundleFormatVersion: keyCandidate.data.bundleFormatVersion,
        };
        const index = await bundles.readIndex(key);
        if (canonicalJson(index) !== canonicalJson(expectedIndex))
          throw new ActiveInstallationBundleError("ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED");
        const sections = await bundles.readSections(key, installationRuntimeBundleSections);
        for (const section of installationRuntimeBundleSections)
          if (!jsonValueSchema.safeParse(sections[section]).success)
            throw new ActiveInstallationBundleError("ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED");
        return sections;
      } catch (error) {
        throw failure(error);
      }
    },
    async repair(
      state: ActiveInstallationBundleState,
      commandCandidate: InstallationRuntimeBundleWriteCommand,
    ) {
      if (!state.repairNeeded || state.coldSource === null)
        throw new ActiveInstallationBundleError("ACTIVE_INSTALLATION_BUNDLE_UNAVAILABLE");
      const parsedCommand = installationRuntimeBundleWriteCommandSchema.safeParse(commandCandidate);
      if (!parsedCommand.success ||
        parsedCommand.data.applicationRootId !== state.identity.applicationRootId ||
        parsedCommand.data.applicationReleaseRevision !== state.identity.applicationReleaseRevision ||
        parsedCommand.data.pinFingerprint !== state.identity.pinFingerprint
      ) throw new ActiveInstallationBundleError("ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED");
      const parts = prepareParts(parsedCommand.data);
      const coldSource = z.object({
        sourceManifest: installationRuntimeBundleSourceManifestSchema,
      }).passthrough().safeParse(state.coldSource);
      if (!coldSource.success)
        throw new ActiveInstallationBundleError("ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED");
      try {
        const rows = await transaction.query<RepairRow>`
          select vortex_module.repair_active_installation_runtime_bundle_internal(
            ${JSON.stringify(state.identity)}::text::jsonb,
            ${JSON.stringify(parts)}::text::jsonb
          ) as bundle_index
        `;
        if (rows.length !== 1 || rows[0] === undefined)
          throw new ActiveInstallationBundleError("ACTIVE_INSTALLATION_BUNDLE_STORAGE_FAILED");
        const index = installationRuntimeBundleIndexSchema.safeParse(rows[0].bundle_index);
        if (!index.success ||
          index.data.organizationId !== state.identity.organizationId ||
          index.data.applicationRootId !== state.identity.applicationRootId ||
          index.data.applicationReleaseRevision !== state.identity.applicationReleaseRevision ||
          index.data.pinFingerprint !== state.identity.pinFingerprint ||
          canonicalJson(index.data.sourceManifest) !== canonicalJson(coldSource.data.sourceManifest)
        ) throw new ActiveInstallationBundleError("ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED");
        return index.data;
      } catch (error) {
        throw failure(error);
      }
    },
  });
};
