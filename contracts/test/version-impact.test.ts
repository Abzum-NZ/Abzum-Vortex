import { describe, expect, test } from "vitest";
import {
  assignNextDefinitionVersion,
  definitionVersionConfirmationSchema,
  definitionVersionImpactResultSchema,
  versionImpactReasonSchema,
} from "../src/index";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
const fingerprint = `sha256:${"a".repeat(64)}`;

describe("definition version-impact contracts", () => {
  test.each([
    ["patch", "1.2.4"],
    ["minor", "1.3.0"],
    ["major", "2.0.0"],
  ] as const)("assigns the minimum %s version", (impact, expected) => {
    expect(assignNextDefinitionVersion("1.2.3", impact)).toBe(expected);
  });

  test("increments from the stable core and removes prerelease/build metadata", () => {
    expect(assignNextDefinitionVersion("1.2.3-preview.4+build.9", "patch")).toBe("1.2.4");
  });

  test("refuses invalid and unsupported version segments", () => {
    expect(() => assignNextDefinitionVersion("1.2", "patch")).toThrow();
    expect(() => assignNextDefinitionVersion(`${Number.MAX_SAFE_INTEGER}.0.0`, "major")).toThrow();
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
        definitionKind: "module",
        comparisonFingerprint: fingerprint,
        currentVersion: "1.2.3",
        reasons: [],
      }).success,
    ).toBe(true);
    expect(
      definitionVersionImpactResultSchema.safeParse({
        outcome: "initial_release",
        definitionKind: "application",
        comparisonFingerprint: fingerprint,
        assignedVersion: "1.0.0",
        reasons: [],
      }).success,
    ).toBe(true);
    expect(
      definitionVersionImpactResultSchema.safeParse({
        outcome: "release_required",
        definitionKind: "module",
        comparisonFingerprint: fingerprint,
        currentVersion: "1.2.3",
        impact: "minor",
        assignedVersion: "1.3.0",
        reasons: [],
      }).success,
    ).toBe(false);
  });

  test("confirmation names only the assigned result and comparison fingerprint", () => {
    const confirmation = {
      definitionKind: "module",
      rootId: id(2),
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
