import "server-only";

import { z } from "zod";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import {
  applicationRootIdSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  organizationLifecycleLimitsSchema,
  recordLifecyclePolicyIdSchema,
  recordTypeLifecyclePolicySchema,
  revisionSchema,
  sameId,
  storageContractIdSchema,
  type ModuleInstallationBindingEvidence,
  type SystemApplicationBoundReleaseSetResult,
} from "../schema";

/** Stable reason codes of a refused provisioned-setup read; `detail` names the failed check. */
export class ProvisionedSetupError extends Error {
  constructor(
    readonly reason: "setup_unavailable" | "installation_incomplete" | "refused",
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`${reason}: ${detail}`, options);
    this.name = "ProvisionedSetupError";
  }
}

export const provisionedSetupSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
    registrationRevision: revisionSchema,
    organizationLimits: organizationLifecycleLimitsSchema,
    targets: z
      .array(
        z
          .object({
            storageContractId: storageContractIdSchema,
            storageScope: z.enum(["application_contained", "organization_shared"]),
            applicationRootId: applicationRootIdSchema.nullable(),
            sourceBindings: z
              .array(
                z
                  .object({
                    moduleRootId: moduleRootIdSchema,
                    moduleReleaseRevision: revisionSchema,
                    bindingRevision: revisionSchema,
                  })
                  .strict(),
              )
              .min(1)
              .max(10_000),
            policy: z.discriminatedUnion("state", [
              z.object({ state: z.literal("absent") }).strict(),
              z
                .object({
                  state: z.literal("configured"),
                  policyId: recordLifecyclePolicyIdSchema,
                  policyRevision: revisionSchema,
                  policyBody: recordTypeLifecyclePolicySchema,
                })
                .strict(),
            ]),
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict();

export type ProvisionedSetup = z.infer<typeof provisionedSetupSchema>;

export type ProvisionedSetupSelector = Readonly<{
  organizationId: string;
  rootId: string;
  releaseRevision: number;
}>;

export type ProvisionedSetupBindings = Readonly<{
  registeredReleaseRevision: number | null;
  moduleBindings: readonly ModuleInstallationBindingEvidence[];
}>;

const provisionedModulePins = (
  selector: ProvisionedSetupSelector,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  provisioned: readonly ModuleInstallationBindingEvidence[],
  registeredReleaseRevision: number | null,
): readonly Readonly<{ moduleRootId: string; bindingRevision: number }>[] => {
  if (releaseSet.modules.length === 0)
    throw new ProvisionedSetupError("setup_unavailable", "release_has_no_modules");
  if (
    provisioned.length !== releaseSet.modules.length ||
    registeredReleaseRevision !== selector.releaseRevision
  )
    throw new ProvisionedSetupError(
      "installation_incomplete",
      "provisioned_modules_differ_from_release",
    );
  const pins = provisioned
    .map((binding) => {
      if (
        !sameId(binding.organizationId, selector.organizationId) ||
        !sameId(binding.applicationRootId, selector.rootId) ||
        binding.applicationReleaseRevision !== selector.releaseRevision
      )
        throw new ProvisionedSetupError(
          "installation_incomplete",
          "binding_outside_selected_release",
        );
      return { moduleRootId: binding.moduleRootId, bindingRevision: binding.bindingRevision };
    })
    .sort((left, right) =>
      left.moduleRootId < right.moduleRootId ? -1 : left.moduleRootId > right.moduleRootId ? 1 : 0,
    );
  for (const module of releaseSet.modules) {
    const matches = provisioned.filter(
      (binding) =>
        sameId(binding.moduleRootId, module.rootId) &&
        binding.moduleReleaseRevision === module.releaseRevision &&
        binding.applicationReleaseRevision === selector.releaseRevision,
    );
    if (matches.length !== 1)
      throw new ProvisionedSetupError("installation_incomplete", "module_binding_not_exactly_one");
  }
  return pins;
};

/**
 * Reads the provisioned lifecycle-policy setup of one exact release inside the open transaction
 * and proves it belongs to that release's provisioned module bindings. Access decisions stay with
 * the caller: a setup read is not authority.
 */
export const readProvisionedLifecycleSetup = async (
  transaction: RequestDatabaseTransaction,
  selector: ProvisionedSetupSelector,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  bindings: ProvisionedSetupBindings,
  exactWorkflowIds: readonly string[],
): Promise<ProvisionedSetup> => {
  const provisioned = bindings.moduleBindings.filter((binding) => binding.state === "provisioned");
  const expectedModuleBindings = provisionedModulePins(
    selector,
    releaseSet,
    provisioned,
    bindings.registeredReleaseRevision,
  );
  const rows = await transaction.query<DatabaseRow>`
    select vortex_record.read_provisioned_lifecycle_policy_setup(
      ${selector.rootId}::uuid,
      ${selector.releaseRevision}::bigint,
      ${JSON.stringify(expectedModuleBindings)}::text::jsonb
    ) as snapshot
  `;
  if (rows.length !== 1)
    throw new ProvisionedSetupError("refused", `setup_snapshot_rows=${rows.length}`);
  const parsed = provisionedSetupSchema.safeParse(rows[0]?.snapshot);
  if (!parsed.success)
    throw new ProvisionedSetupError("refused", "setup_snapshot_unreadable", {
      cause: parsed.error,
    });
  const setup = parsed.data;
  if (setup.targets.length === 0)
    throw new ProvisionedSetupError("setup_unavailable", "no_lifecycle_targets");
  if (
    !sameId(setup.organizationId, selector.organizationId) ||
    !sameId(setup.applicationRootId, selector.rootId) ||
    setup.applicationReleaseRevision !== selector.releaseRevision
  )
    throw new ProvisionedSetupError("refused", "setup_snapshot_for_other_release");
  if (
    new Set(setup.targets.map((target) => target.storageContractId.toLowerCase())).size !==
    setup.targets.length
  )
    throw new ProvisionedSetupError("refused", "duplicate_storage_contract");
  if (
    setup.targets.some((target) =>
      target.storageScope === "organization_shared"
        ? target.applicationRootId !== null
        : target.applicationRootId === null || !sameId(target.applicationRootId, selector.rootId),
    )
  )
    throw new ProvisionedSetupError("refused", "storage_scope_application_mismatch");
  if (
    setup.targets.some((target) =>
      target.sourceBindings.some(
        (binding) =>
          !expectedModuleBindings.some(
            (pin) =>
              sameId(pin.moduleRootId, binding.moduleRootId) &&
              pin.bindingRevision === binding.bindingRevision,
          ),
      ),
    )
  )
    throw new ProvisionedSetupError("refused", "source_binding_not_pinned");
  const workflowIds = new Set(exactWorkflowIds.map((workflowId) => workflowId.toLowerCase()));
  if (
    setup.targets.some(
      (target) =>
        target.policy.state === "configured" &&
        target.policy.policyBody.action === "archive_workflow" &&
        (target.policy.policyBody.expectedWorkflowRevision !== selector.releaseRevision ||
          !workflowIds.has(target.policy.policyBody.archiveWorkflowId.toLowerCase())),
    )
  )
    throw new ProvisionedSetupError("setup_unavailable", "archive_workflow_not_in_release");
  return setup;
};

/**
 * Proves the setup's organisation limits are this organisation's and that every target's source
 * bindings are exactly the installation's provisioned bindings, once per module.
 */
export const assertProvisionedSetupMatchesInstallation = (
  setup: ProvisionedSetup,
  bindings: ProvisionedSetupBindings,
  organizationId: string,
): void => {
  if (!sameId(setup.organizationLimits.organizationId, organizationId))
    throw new ProvisionedSetupError("refused", "limits_for_other_organization");
  const provisioned = new Map(
    bindings.moduleBindings
      .filter((binding) => binding.state === "provisioned")
      .map((binding) => [binding.moduleRootId.toLowerCase(), binding]),
  );
  for (const target of setup.targets) {
    const seen = new Set<string>();
    for (const sourceBinding of target.sourceBindings) {
      const key = sourceBinding.moduleRootId.toLowerCase();
      const expected = provisioned.get(key);
      if (
        expected === undefined ||
        seen.has(key) ||
        !sameId(expected.moduleRootId, sourceBinding.moduleRootId) ||
        expected.moduleReleaseRevision !== sourceBinding.moduleReleaseRevision ||
        expected.bindingRevision !== sourceBinding.bindingRevision
      )
        throw new ProvisionedSetupError("refused", "source_binding_differs_from_installation");
      seen.add(key);
    }
  }
};
