import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";

export { canonicalJson, compareCanonicalStrings } from "./canonical-json";

export const fingerprintCanonicalValue = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
