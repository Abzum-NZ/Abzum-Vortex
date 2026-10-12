import { createHash } from "node:crypto";
import { canonicalJson } from "../schema";

export { canonicalJson, compareCanonicalStrings } from "../schema";

export const fingerprintCanonicalValue = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
