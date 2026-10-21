import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  applicationRootIdSchema,
  identityIdSchema,
  organizationIdSchema,
  revisionSchema,
  sameId,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "../../schema";
import type { QueryContinuationKey } from "../../queries/index";
import { canonicalJson } from "../../definition/canonical-json";

/**
 * The sealed row position of a pivot: the group key the next page continues after, bound to the
 * person, organisation, application, installed release, page and placement it was issued for and
 * to the exact query the pivot ran (its resolved inputs, search, filters and dimensions). It is
 * encrypted and authenticated, so the browser holds an opaque token it can neither read nor edit,
 * and it never continues a read under other filters or another person.
 */
const cursorSchema = z
  .object({
    version: z.literal(1),
    identityId: identityIdSchema,
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    previewInstallationId: z.string().uuid().optional(),
    installationRevision: revisionSchema,
    pageId: z.string().min(1).max(200),
    placementId: z.string().min(1).max(200),
    query: z.string().length(64),
    groupKey: z.string().min(1).max(4096),
    issuedAt: z.number().int().positive(),
  })
  .strict();

/** A cursor stays usable for an hour; the pivot's next page seals a fresh one. */
const cursorLifetimeMilliseconds = 3_600_000;
const tokenVersion = 1;
const nonceLength = 12;
const tagLength = 16;
const associatedData = Buffer.from("vortex.records.pivot.cursor.v1", "utf8");

const cipherKey = (key: QueryContinuationKey): Buffer => {
  if (!(key.key instanceof Uint8Array) || key.key.byteLength !== 32)
    throw new Error("PIVOT_CURSOR_KEY_INVALID");
  return Buffer.from(key.key);
};

/** What a cursor is bound to: who reads, where, and which query the pivot ran. */
export type PivotCursorBinding = Readonly<{
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
  installationRevision: number;
  pageId: string;
  placementId: string;
  /** The pivot's summary command without its row position: the resolved filters and state. */
  query: unknown;
}>;

const queryFingerprint = (query: unknown): string =>
  createHash("sha256").update(canonicalJson(query)).digest("hex");

export const sealPivotCursor = (
  key: QueryContinuationKey,
  binding: PivotCursorBinding,
  groupKey: string,
  now: () => number = Date.now,
): string => {
  if (binding.selection.applicationRootId === undefined)
    throw new Error("PIVOT_CURSOR_APPLICATION_NOT_SELECTED");
  const payload = cursorSchema.parse({
    version: 1,
    identityId: binding.session.identityId,
    organizationId: binding.selection.organizationId,
    applicationRootId: binding.selection.applicationRootId,
    ...(binding.selection.previewInstallationId === undefined
      ? {}
      : { previewInstallationId: binding.selection.previewInstallationId }),
    installationRevision: binding.installationRevision,
    pageId: binding.pageId,
    placementId: binding.placementId,
    query: queryFingerprint(binding.query),
    groupKey,
    issuedAt: now(),
  });
  const nonce = randomBytes(nonceLength);
  const cipher = createCipheriv("aes-256-gcm", cipherKey(key), nonce, {
    authTagLength: tagLength,
  });
  cipher.setAAD(associatedData);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([
    Buffer.from([tokenVersion]),
    nonce,
    cipher.getAuthTag(),
    encrypted,
  ]).toString("base64url");
};

export type PivotCursorOpening =
  | Readonly<{ kind: "opened"; groupKey: string }>
  /** The cursor is not usable for this read; `cause` names why, for the log only. */
  | Readonly<{ kind: "stale"; cause: string }>;

/**
 * Opens a sealed cursor for the read that now asks for it. Anything that is not exactly the read
 * it was issued for (another person, scope, release, page, placement or query, a tampered or old
 * token) is stale; the caller logs the cause and restarts the pivot at its first page.
 */
export const openPivotCursor = (
  token: string,
  key: QueryContinuationKey,
  binding: PivotCursorBinding,
  now: () => number = Date.now,
): PivotCursorOpening => {
  let payload: z.infer<typeof cursorSchema>;
  try {
    const bytes = Buffer.from(token, "base64url");
    if (bytes.length <= 1 + nonceLength + tagLength || bytes[0] !== tokenVersion)
      return { kind: "stale", cause: "token_malformed" };
    const decipher = createDecipheriv(
      "aes-256-gcm",
      cipherKey(key),
      bytes.subarray(1, 1 + nonceLength),
      { authTagLength: tagLength },
    );
    decipher.setAAD(associatedData);
    decipher.setAuthTag(bytes.subarray(1 + nonceLength, 1 + nonceLength + tagLength));
    const text = Buffer.concat([
      decipher.update(bytes.subarray(1 + nonceLength + tagLength)),
      decipher.final(),
    ]).toString("utf8");
    const parsed = cursorSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { kind: "stale", cause: "payload_invalid" };
    payload = parsed.data;
  } catch {
    return { kind: "stale", cause: "token_not_authentic" };
  }
  const { session, selection } = binding;
  if (!sameId(payload.identityId, session.identityId))
    return { kind: "stale", cause: "other_person" };
  if (
    !sameId(payload.organizationId, selection.organizationId) ||
    selection.applicationRootId === undefined ||
    !sameId(payload.applicationRootId, selection.applicationRootId) ||
    (payload.previewInstallationId ?? "") !== (selection.previewInstallationId ?? "")
  )
    return { kind: "stale", cause: "other_scope" };
  if (payload.installationRevision !== binding.installationRevision)
    return { kind: "stale", cause: "release_changed" };
  if (!sameId(payload.pageId, binding.pageId)) return { kind: "stale", cause: "other_page" };
  if (!sameId(payload.placementId, binding.placementId))
    return { kind: "stale", cause: "other_placement" };
  if (payload.query !== queryFingerprint(binding.query))
    return { kind: "stale", cause: "query_changed" };
  if (now() - payload.issuedAt > cursorLifetimeMilliseconds)
    return { kind: "stale", cause: "expired" };
  return { kind: "opened", groupKey: payload.groupKey };
};
