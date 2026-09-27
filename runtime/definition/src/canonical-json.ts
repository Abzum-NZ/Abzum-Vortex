import { createHash } from "node:crypto";
import { canonicalJson } from "@vortex/contracts";

export { canonicalJson, compareCanonicalStrings } from "@vortex/contracts";

export const fingerprintCanonicalValue = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
