import { CURRENT_CONNECTION_TYPE_RELEASES } from "@vortex/platform/schema";
import organisationAdministration from "./modules/organisation_administration.json";

/** Choices and display labels are derived from the platform's current releases. */
export const connectionTypeChoices = CURRENT_CONNECTION_TYPE_RELEASES.map((release) => ({
  key: release.source.key,
  label: release.source.body.name,
}));
export const connectionTypeDisplayOptions = CURRENT_CONNECTION_TYPE_RELEASES.map((release) => ({
  value: release.rootId,
  label: release.source.body.name,
}));

/** The Module Organisation Administration owns: notices, privacy cases, settings and activity. */
export const organisationAdministrationModules: readonly unknown[] = [organisationAdministration];
