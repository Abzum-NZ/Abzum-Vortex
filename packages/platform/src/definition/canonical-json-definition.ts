import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalJson } from "./canonical-json";

export { canonicalJson, compareCanonicalStrings, sameCanonicalValue } from "./canonical-json";

export const fingerprintCanonicalJson = (value: string): `sha256:${string}` =>
  `sha256:${bytesToHex(sha256(new TextEncoder().encode(value)))}`;

export const fingerprintCanonicalValue = (value: unknown): `sha256:${string}` =>
  fingerprintCanonicalJson(canonicalJson(value));
