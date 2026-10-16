import { createOrganizationLifecycleLimitsStore } from "@vortex/platform/server";

/**
 * The local organisation's record lifecycle ceilings: records may be deleted (and recovered), with
 * no automatic age or count limit. Installation gives every record type its lifecycle policy within
 * these ceilings; the setup stores no policy of its own.
 */

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
