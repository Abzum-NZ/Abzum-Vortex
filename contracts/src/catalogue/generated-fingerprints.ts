import fingerprints from "./catalogue-fingerprints.generated.json";

type GeneratedReleaseFingerprints = Readonly<{
  contentFingerprint: string;
  catalogueFingerprint: string;
}>;

/**
 * The content and catalogue fingerprints that `pnpm catalogue:fingerprints` generated for one
 * catalogue release, found by its exact release identity (the key the generator writes). A release
 * with no generated entry means its source changed without regenerating, so loading the catalogue
 * fails instead of using a stale value.
 */
export const generatedReleaseFingerprints = (
  kind: keyof typeof fingerprints,
  identity: string,
): GeneratedReleaseFingerprints => {
  const generated = (
    fingerprints[kind] as Readonly<Record<string, GeneratedReleaseFingerprints | undefined>>
  )[identity];
  if (generated === undefined)
    throw new Error(
      `No generated ${kind} fingerprints for ${identity}; run pnpm catalogue:fingerprints`,
    );
  return generated;
};
