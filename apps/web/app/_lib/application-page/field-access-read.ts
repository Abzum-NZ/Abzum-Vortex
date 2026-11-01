import {
  decideChoiceOptionGates,
  readCurrentOrganizationRuntimeSettingsAfterAuthorization,
  type ChoiceOptionPlan,
  type DateTimeZones,
  type HumanOrganizationRequestDependencies,
} from "@vortex/platform/server";
import {
  organizationRuntimeSettingsSchema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "@vortex/platform/schema";
import { humanOrganizationRequests } from "../server-composition";

/**
 * What a page's field placements need decided under the person's own verified request scope: the
 * time zones a date-time field shows, the organisation's currency a money field in that mode shows,
 * and which gated choice options the person may use now. The access version the decisions were made
 * at comes back with them.
 */
export const readFieldAccess = (
  input: Readonly<{
    session: IdentitySession;
    dependencies: HumanOrganizationRequestDependencies;
    selection: OrganizationSelectionCandidate;
    needsDateTimeZones: boolean;
    /** The page shows a money field whose currency is the organisation's. */
    needsOrganizationCurrency: boolean;
    choicePlan: ChoiceOptionPlan;
    /** The record the page addresses, whose own access decides its gated options. */
    choiceSubject: Readonly<{ recordTypeId: string; recordId: string }> | undefined;
  }>,
) =>
  humanOrganizationRequests(input.dependencies.identityAuthorityId).run(
    input.session,
    input.selection,
    async (transaction, scope) => {
      const zones: DateTimeZones = {};
      let organizationCurrency: string | undefined;
      if (input.needsDateTimeZones || input.needsOrganizationCurrency) {
        if (input.needsDateTimeZones) {
          const profileRows = await transaction.query<{ time_zone: unknown }>`
            select time_zone from vortex_access.read_own_profile()
          `;
          if (profileRows.length !== 1 || profileRows[0] === undefined)
            throw new Error("PAGE_PROFILE_TIME_ZONE_UNAVAILABLE");
          const profileZone = profileRows[0].time_zone;
          if (profileZone !== null) {
            const parsed = organizationRuntimeSettingsSchema.shape.timeZone.safeParse(profileZone);
            if (!parsed.success) throw new Error("PAGE_PROFILE_TIME_ZONE_UNAVAILABLE");
            zones.personTimeZone = parsed.data;
          }
        }
        const organizationSettings =
          await readCurrentOrganizationRuntimeSettingsAfterAuthorization(transaction);
        if (organizationSettings !== undefined) {
          if (input.needsDateTimeZones)
            zones.organizationTimeZone = organizationSettings.timeZone;
          if (input.needsOrganizationCurrency)
            organizationCurrency = organizationSettings.currency;
        }
      }
      const allowed = await decideChoiceOptionGates(
        transaction,
        input.choicePlan,
        input.choiceSubject,
      );
      return { zones, organizationCurrency, allowed, accessVersion: scope.accessVersion };
    },
  );
