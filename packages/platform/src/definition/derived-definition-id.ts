import { createHash } from "node:crypto";

/**
 * The permanent identity the database gives a new Definition component or owned Module root
 * (`vortex_definition.derived_definition_id`): a name-based (version-3) UUID from the MD5 of its parts joined
 * by the unit separator, with the RFC 9562 variant bits. A draft compiled in memory uses it for
 * what its publication has not yet recorded, so it names everything exactly as publication will.
 * The guard's derived-id-parity rule holds both to vectors recorded from the SQL function.
 */
export const derivedDefinitionId = (parts: readonly string[]): string => {
  const hex = createHash("md5").update(parts.join("\u001f"), "utf8").digest("hex");
  const variant = "89ab"[Number.parseInt(hex[16]!, 16) % 4]!;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-3${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** The version nibble a derived identity carries: 4, 5 or 8, as RFC 9562 defines them. */
export type DerivedUuidVersion = 4 | 5 | 8;

/**
 * The first 16 bytes of the SHA-256 of `text`, with the RFC 9562 variant bits and `version` as its
 * version nibble, formatted 8-4-4-4-12. A caller hashes exactly the text it always hashed, so an
 * identity already stored does not change.
 */
export const uuidFromText = (text: string, version: DerivedUuidVersion): string => {
  const bytes = createHash("sha256").update(text, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | (version << 4);
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** The root of an Application's inline Module, before or after the database creates it. */
export const derivedOwnedModuleRootId = (applicationRootId: string, moduleKey: string): string =>
  derivedDefinitionId(["owned_module_root", applicationRootId.toLowerCase(), moduleKey]);

/** A source identity of one Definition root, before or after the database records it. */
export const derivedSourceIdentityId = (
  rootId: string,
  ownerScope: string,
  kind: string,
  componentOwner: string,
): string =>
  derivedDefinitionId(["source_identity", rootId.toLowerCase(), ownerScope, kind, componentOwner]);
