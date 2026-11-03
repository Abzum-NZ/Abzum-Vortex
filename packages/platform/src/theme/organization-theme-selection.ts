import type { z } from "zod";
import {
  applicationThemeSelectionSchema,
  type ApplicationThemeSelection,
} from "../definition/application-composition/theme";
import { DEFAULT_APPLICATION_THEME_SELECTION } from "../definition/application-composition/theme-defaults";

/**
 * The organisation theme: only the dimensions the organisation changed from the platform default
 * selection, in the one selection format the application theme uses. A dimension the organisation
 * leaves out follows the platform.
 */
export const organizationThemeSelectionSchema = applicationThemeSelectionSchema.partial();
export type OrganizationThemeSelection = z.infer<typeof organizationThemeSelectionSchema>;

const dimensionKeys = Object.keys(
  applicationThemeSelectionSchema.shape,
) as (keyof ApplicationThemeSelection)[];

/**
 * The selection a viewer sees at three levels, decided per dimension: the application's value if it
 * differs from the platform default (the application chose it), else the organisation's value if it
 * has one, else the platform's. `application` is the application's own selection; Studio's own
 * chrome passes its platform selection, which has no application choice to protect.
 */
export const effectiveThemeSelection = (
  application: ApplicationThemeSelection,
  organization: OrganizationThemeSelection | undefined,
): ApplicationThemeSelection => {
  const effective = { ...application };
  for (const key of dimensionKeys) {
    const organizationValue = organization?.[key];
    if (
      organizationValue !== undefined &&
      application[key] === DEFAULT_APPLICATION_THEME_SELECTION[key]
    )
      effective[key] = organizationValue;
  }
  return effective;
};

/** The organisation theme a full selection comes to: the dimensions that differ from the platform default. */
export const organizationThemeDelta = (
  selection: ApplicationThemeSelection,
): OrganizationThemeSelection =>
  Object.fromEntries(
    dimensionKeys
      .filter((key) => selection[key] !== DEFAULT_APPLICATION_THEME_SELECTION[key])
      .map((key) => [key, selection[key]]),
  );

/** The full selection an organisation theme stands for: the platform default with the delta applied. */
export const organizationThemeFullSelection = (
  organization: OrganizationThemeSelection | undefined,
): ApplicationThemeSelection =>
  effectiveThemeSelection(DEFAULT_APPLICATION_THEME_SELECTION, organization);
