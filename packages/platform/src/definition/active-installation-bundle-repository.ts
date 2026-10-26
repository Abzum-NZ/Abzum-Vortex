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
import { installationRuntimeBundleIndexSchema } from "./installation-runtime-bundle";
import { stableDefinitionReleaseVersionSchema } from "./version-impact";
import { z } from "zod";

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
