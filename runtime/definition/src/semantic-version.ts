import { stableDefinitionReleaseVersionSchema, type VersionImpact } from "@vortex/contracts";

type Version = readonly [major: bigint, minor: bigint, patch: bigint];

const parseStableVersion = (input: string): Version => {
  const value = stableDefinitionReleaseVersionSchema.parse(input);
  const parts = value.split(".");
  if (parts.length !== 3) throw new TypeError("A stable release version has three segments");
  return [BigInt(parts[0]!), BigInt(parts[1]!), BigInt(parts[2]!)];
};

export const compareStableVersions = (left: string, right: string): number => {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0n) return difference < 0n ? -1 : 1;
  }
  return 0;
};

export const assignNextDefinitionVersion = (
  currentVersion: string,
  impact: VersionImpact,
): string => {
  const [major, minor, patch] = parseStableVersion(currentVersion);
  const next: Version =
    impact === "patch"
      ? [major, minor, patch + 1n]
      : impact === "minor"
        ? [major, minor + 1n, 0n]
        : [major + 1n, 0n, 0n];
  return stableDefinitionReleaseVersionSchema.parse(next.join("."));
};
