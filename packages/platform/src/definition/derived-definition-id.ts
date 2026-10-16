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
