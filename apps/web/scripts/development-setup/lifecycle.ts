import {
  createOrganizationLifecycleLimitsStore,
  createRecordTypeLifecyclePolicyService,
} from "@vortex/record";
import type {
  IdentityAuthorityId,
  SystemApplicationBoundReleaseSetResult,
} from "@vortex/contracts";
import { nominatedOwnerSession } from "./development-authority";

/**
 * Installing an application requires an executable record-type lifecycle policy for every record
 * type its modules own (the activation gate). The setup states one explicit, conservative choice
 * for the local organisation: records may be deleted and recovered for thirty days, with no
 * automatic age or count limit.
 */

const recoveryWindowDays = 30;

/** Stores the organisation's lifecycle ceilings once; an identical retry is a no-op. */
export const initializeLifecycleLimits = async (organizationId: string): Promise<void> => {
  await createOrganizationLifecycleLimitsStore().initialize({
    organizationId,
    settingsRevision: 1,
    maxRetentionDays: null,
    maxRecordCount: null,
    allowUnlimitedRetentionDays: true,
    allowUnlimitedRecordCount: true,
    allowedActions: ["delete"],
    allowedArchiveDestinations: [],
  });
};

/**
 * Stores revision 1 of the delete policy for every record type of the prepared modules, through
 * the record lifecycle policy service's provisioned-setup entry, bound to each provisioned binding.
 */
export const storeInitialLifecyclePolicies = async (
  input: Readonly<{
    identityAuthorityId: IdentityAuthorityId;
    organizationId: string;
    stewardIdentityId: string;
    applicationRootId: string;
    releaseSet: SystemApplicationBoundReleaseSetResult;
    bindings: readonly Readonly<{ moduleRootId: string; bindingRevision: number }>[];
  }>,
): Promise<number> => {
  const service = createRecordTypeLifecyclePolicyService({
    identityAuthorityId: input.identityAuthorityId,
  });
  let stored = 0;
  for (const module of input.releaseSet.modules) {
    const binding = input.bindings.find(
      (candidate) => candidate.moduleRootId.toLowerCase() === module.rootId.toLowerCase(),
    );
    if (binding === undefined)
      throw new Error(`No provisioned binding for ${module.definitionKey}`);
    for (const recordType of module.content.recordTypes) {
      const result = await service.saveInitialForProvisionedSetup(
        nominatedOwnerSession(input.stewardIdentityId),
        {
          organizationId: input.organizationId,
          bindingApplicationRootId: input.applicationRootId,
          expectedBindingRevision: binding.bindingRevision,
          storageContractId: recordType.storageContractId,
          applicationRootId:
            recordType.storageScope === "application_contained" ? input.applicationRootId : null,
          expectedSettingsRevision: 1,
          policy: {
            action: "delete",
            maxAgeDays: null,
            maxCount: null,
            allowUnlimitedAge: true,
            allowUnlimitedCount: true,
            recoveryWindowDays,
          },
        },
      );
      if (result.kind !== "available")
        throw new Error(
          `The lifecycle policy for ${recordType.storageContractId} could not be stored (${result.kind})`,
        );
      stored += 1;
    }
  }
  return stored;
};
