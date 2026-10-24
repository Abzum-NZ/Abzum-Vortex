import { createOrganizationLifecycleLimitsStore } from "@vortex/platform/server";
import type { DevelopmentSetupManifest } from "./manifest";

/**
 * The local organisation's record lifecycle ceilings: records may be deleted (and recovered), with
 * no automatic age or count limit. The manifest supplies the initial policy that installation
 * copies for record types without an organisation policy.
 */

/** Stores the organisation's lifecycle ceilings once; an identical retry is a no-op. */
export const initializeLifecycleLimits = async (
  organizationId: string,
  initialPolicy: DevelopmentSetupManifest["initialLifecyclePolicy"],
): Promise<void> => {
  await createOrganizationLifecycleLimitsStore().initialize(
    {
      organizationId,
      settingsRevision: 1,
      maxRetentionDays: null,
      maxRecordCount: null,
      allowUnlimitedRetentionDays: true,
      allowUnlimitedRecordCount: true,
      allowedActions: ["delete"],
      allowedArchiveDestinations: [],
    },
    initialPolicy,
  );
};
