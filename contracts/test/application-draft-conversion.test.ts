import {
  confirmApplicationDraftV2ConversionCommandSchema,
  prepareApplicationDraftV2ConversionCommandSchema,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const fingerprint = `sha256:${"a".repeat(64)}`;
const selection = {
  rootId: id(1),
  expectedDraftRevision: 3,
  blockMappings: [
    {
      legacyRegistrationId: "legacy_card",
      platformBlockId: id(2),
      platformReleaseVersion: "7.1.0",
      propertyMappings: [{ sourceSettingKey: "title", targetPropertyKey: "heading" }],
    },
  ],
  listPageMappings: [
    {
      pageId: "contacts",
      placementId: "contacts_primary",
      platformBlockId: id(3),
      platformReleaseVersion: "2.0.0",
      propertyMappings: [{ sourceSettingKey: "query", targetPropertyKey: "source" }],
    },
  ],
  theme: { catalogueThemeId: id(4), releaseVersion: "5.0.0", tokenOverrides: {} },
};

describe("application draft V2 conversion contracts", () => {
  it("accepts closed exact selections and an explicit confirmation", () => {
    expect(prepareApplicationDraftV2ConversionCommandSchema.parse(selection)).toEqual(selection);
    expect(
      confirmApplicationDraftV2ConversionCommandSchema.parse({
        ...selection,
        preparedSourceFingerprint: fingerprint,
        confirmation: "convert",
      }),
    ).toMatchObject({ confirmation: "convert" });
  });

  it("does not accept converted source bytes or catalogue fingerprints from callers", () => {
    expect(
      prepareApplicationDraftV2ConversionCommandSchema.safeParse({
        ...selection,
        preparedSource: {},
        contentFingerprint: fingerprint,
      }).success,
    ).toBe(false);
    expect(
      confirmApplicationDraftV2ConversionCommandSchema.safeParse({
        ...selection,
        preparedSourceFingerprint: fingerprint,
        confirmation: "yes",
      }).success,
    ).toBe(false);
  });
});
