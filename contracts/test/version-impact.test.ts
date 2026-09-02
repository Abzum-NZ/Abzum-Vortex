import { describe, expect, test } from "vitest";
import {
  definitionVersionConfirmationSchema,
  definitionVersionImpactResultSchema,
  stableDefinitionReleaseVersionSchema,
  versionImpactReasonSchema,
} from "../src/index";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
const fingerprint = `sha256:${"a".repeat(64)}`;

describe("definition version-impact contracts", () => {
  test("accepts only stable published definition versions", () => {
    expect(stableDefinitionReleaseVersionSchema.safeParse("0.0.0").success).toBe(true);
    expect(stableDefinitionReleaseVersionSchema.safeParse("1.2.3").success).toBe(true);
    expect(stableDefinitionReleaseVersionSchema.safeParse("1.2.3-preview.4").success).toBe(false);
    expect(stableDefinitionReleaseVersionSchema.safeParse("1.2.3+build.9").success).toBe(false);
  });

  test("keeps reasons closed and free of business names or arbitrary paths", () => {
    const reason = {
      impact: "major",
      code: "component_removed",
      location: { componentKind: "field", componentId: id(1), property: "identity" },
    };
    expect(versionImpactReasonSchema.safeParse(reason).success).toBe(true);
    expect(
      versionImpactReasonSchema.safeParse({
        ...reason,
        location: { ...reason.location, installedName: "example field" },
      }).success,
    ).toBe(false);
    expect(
      versionImpactReasonSchema.safeParse({
        ...reason,
        code: "example_specific_change",
      }).success,
    ).toBe(false);
  });

  test("uses mutually exclusive no-change, initial and required-release results", () => {
    expect(
      definitionVersionImpactResultSchema.safeParse({
        outcome: "no_change",
        subject: { definitionKind: "module", rootId: id(2) },
        comparisonFingerprint: fingerprint,
        currentVersion: "1.2.3",
        reasons: [],
      }).success,
    ).toBe(true);
    expect(
      definitionVersionImpactResultSchema.safeParse({
        outcome: "initial_release",
        subject: { definitionKind: "application", rootId: id(3) },
        comparisonFingerprint: fingerprint,
        assignedVersion: "1.0.0",
        reasons: [],
      }).success,
    ).toBe(true);
    expect(
      definitionVersionImpactResultSchema.safeParse({
        outcome: "release_required",
        subject: { definitionKind: "module", rootId: id(4) },
        comparisonFingerprint: fingerprint,
        currentVersion: "1.2.3",
        impact: "minor",
        assignedVersion: "1.3.0",
        reasons: [],
      }).success,
    ).toBe(false);
  });

  test("enforces the assigned increment and governed reason order", () => {
    const required = {
      outcome: "release_required" as const,
      subject: { definitionKind: "module" as const, rootId: id(4) },
      comparisonFingerprint: fingerprint,
      currentVersion: "1.2.3",
      impact: "major" as const,
      assignedVersion: "2.0.0",
      reasons: [
        {
          impact: "major" as const,
          code: "component_removed" as const,
          location: {
            componentKind: "field" as const,
            componentId: id(5),
            property: "identity" as const,
          },
        },
        {
          impact: "patch" as const,
          code: "definition_text_changed" as const,
          location: { componentKind: "module" as const, property: "description" as const },
        },
      ],
    };
    expect(definitionVersionImpactResultSchema.safeParse(required).success).toBe(true);
    expect(
      definitionVersionImpactResultSchema.safeParse({
        ...required,
        assignedVersion: "1.3.0",
      }).success,
    ).toBe(false);
    expect(
      definitionVersionImpactResultSchema.safeParse({
        ...required,
        reasons: [...required.reasons].reverse(),
      }).success,
    ).toBe(false);
    expect(
      definitionVersionImpactResultSchema.safeParse({
        ...required,
        reasons: [required.reasons[0], required.reasons[0]],
      }).success,
    ).toBe(false);
  });

  test("confirmation names only the assigned result and comparison fingerprint", () => {
    const confirmation = {
      subject: { definitionKind: "module", rootId: id(2) },
      comparisonFingerprint: fingerprint,
      assignedVersion: "1.3.0",
    };
    expect(definitionVersionConfirmationSchema.safeParse(confirmation).success).toBe(true);
    expect(
      definitionVersionConfirmationSchema.safeParse({
        ...confirmation,
        builderVersionOverride: "9.0.0",
      }).success,
    ).toBe(false);
  });
});
