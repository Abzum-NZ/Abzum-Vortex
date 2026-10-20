import { z } from "zod";
import { databaseErrorCode, DefinitionError } from "./definition-error";

const retiredIdentitySchema = z
  .object({
    kind: z.string().min(1),
    componentOwner: z.string().min(1),
    alias: z.string().min(1),
  })
  .strict();

/** Map only this database refusal; unrelated uniqueness failures keep their own handling. */
export const identityRetiredFailure = (
  cause: unknown,
  source?: unknown,
): DefinitionError | undefined => {
  if (
    databaseErrorCode(cause) !== "23505" ||
    !(cause instanceof Error) ||
    !("constraint_name" in cause) ||
    cause.constraint_name !== "source_identity_alias_retired"
  )
    return undefined;
  const detail = "detail" in cause ? cause.detail : undefined;
  const identity = retiredIdentitySchema.parse(
    typeof detail === "string" ? JSON.parse(detail) : detail,
  );
  const findName = (value: unknown): string | undefined => {
    if (value === null || typeof value !== "object") return undefined;
    const item = value as Record<string, unknown>;
    if (item.id === identity.componentOwner) {
      for (const key of ["label", "name", "title"])
        if (typeof item[key] === "string") return item[key];
    }
    for (const child of Object.values(item)) {
      const name = findName(child);
      if (name !== undefined) return name;
    }
    return undefined;
  };
  const name = findName(source) ?? identity.alias;
  return new DefinitionError("DEFINITION_IDENTITY_RETIRED", {
    cause,
    sentence: `“${name}” was used before under this name. Restore it from Releases, or give the new item a different name.`,
  });
};
