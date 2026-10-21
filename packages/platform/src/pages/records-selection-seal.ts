import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  applicationRootIdSchema,
  identityIdSchema,
  jsonValueSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  queryIdSchema,
  revisionSchema,
  sameId,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
  type RecordsTableQueryState,
} from "../schema";
import type { QueryContinuationKey } from "../queries/index";

/**
 * The sealed "every matching record" descriptor of one Records table read: the page and placement and the
 * exact installed release it was read from, the query inputs its parameter bindings resolved to on
 * the server, and the query state minus the page (sort, filters, search). It is bound to the
 * person, organisation and application like a continuation token, and it is encrypted as well as
 * authenticated, so the browser holds an opaque token it can neither read nor change. A command
 * that runs over it re-reads the records under the person's current access.
 */
const selectionDescriptorSchema = z
  .object({
    version: z.literal(1),
    identityId: identityIdSchema,
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    previewInstallationId: z.string().uuid().optional(),
    installationRevision: revisionSchema,
    pageId: z.string().min(1).max(200),
    placementId: z.string().min(1).max(200),
    moduleRootId: moduleRootIdSchema,
    queryId: queryIdSchema,
    inputValues: z.record(z.string(), jsonValueSchema),
    sort: z.array(jsonValueSchema).max(20),
    filters: z.array(jsonValueSchema).max(200),
    search: z.string().max(500).nullable(),
    /** The organisation time zone a date-and-time filter was read in, when one applies. */
    timeZone: z.string().min(1).max(100).optional(),
    issuedAt: z.number().int().positive(),
  })
  .strict();
export type RecordsSelectionDescriptor = z.infer<typeof selectionDescriptorSchema>;

/** A sealed descriptor stays usable for an hour; "Select all matching records" seals a fresh one. */
const descriptorLifetimeMilliseconds = 3_600_000;
const tokenVersion = 1;
const nonceLength = 12;
const tagLength = 16;
const associatedData = Buffer.from("vortex.records.selection.v1", "utf8");

const cipherKey = (key: QueryContinuationKey): Buffer => {
  if (!(key.key instanceof Uint8Array) || key.key.byteLength !== 32)
    throw new Error("RECORDS_SELECTION_KEY_INVALID");
  return Buffer.from(key.key);
};

/** What one table read knows that the descriptor carries, beside who reads it. */
export type RecordsSelectionTarget = Readonly<{
  installationRevision: number;
  pageId: string;
  placementId: string;
  moduleRootId: string;
  queryId: string;
  inputValues: Readonly<Record<string, JsonValue>>;
  state: Omit<RecordsTableQueryState, "page">;
  timeZone?: string;
}>;

/** Seals one table read's descriptor for the reading person; the page read calls it. */
export type RecordsSelectionSealer = (target: RecordsSelectionTarget) => string;

export const createRecordsSelectionSealer =
  (
    key: QueryContinuationKey,
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    now: () => number = Date.now,
  ): RecordsSelectionSealer =>
  (target) => {
    if (selection.applicationRootId === undefined)
      throw new Error("RECORDS_SELECTION_APPLICATION_NOT_SELECTED");
    const descriptor = selectionDescriptorSchema.parse({
      version: 1,
      identityId: session.identityId,
      organizationId: selection.organizationId,
      applicationRootId: selection.applicationRootId,
      ...(selection.previewInstallationId === undefined
        ? {}
        : { previewInstallationId: selection.previewInstallationId }),
      installationRevision: target.installationRevision,
      pageId: target.pageId,
      placementId: target.placementId,
      moduleRootId: target.moduleRootId,
      queryId: target.queryId,
      inputValues: target.inputValues,
      sort: target.state.sort,
      filters: target.state.filters,
      search: target.state.search,
      ...(target.timeZone === undefined ? {} : { timeZone: target.timeZone }),
      issuedAt: now(),
    });
    const nonce = randomBytes(nonceLength);
    const cipher = createCipheriv("aes-256-gcm", cipherKey(key), nonce, {
      authTagLength: tagLength,
    });
    cipher.setAAD(associatedData);
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(descriptor), "utf8")),
      cipher.final(),
    ]);
    return Buffer.concat([
      Buffer.from([tokenVersion]),
      nonce,
      cipher.getAuthTag(),
      encrypted,
    ]).toString("base64url");
  };

/** Who opens a descriptor, and the release and placement the command addresses now. */
export type RecordsSelectionExpectation = Readonly<{
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
  installationRevision: number;
  pageId: string;
  placementId: string;
}>;

/**
 * Opens a sealed descriptor for the person it was sealed for, in the same organisation,
 * application and installed release, for the same placement, within its lifetime. Anything else
 * (a tampered or foreign token, another person, a newer release) is refused, with the cause logged.
 */
export const openRecordsSelection = (
  token: string,
  key: QueryContinuationKey,
  expected: RecordsSelectionExpectation,
  now: () => number = Date.now,
): RecordsSelectionDescriptor | undefined => {
  const refuse = (cause: string): undefined => {
    console.error(`[records-selection] descriptor refused cause=${cause}`);
    return undefined;
  };
  let descriptor: RecordsSelectionDescriptor;
  try {
    const bytes = Buffer.from(token, "base64url");
    if (bytes.length <= 1 + nonceLength + tagLength || bytes[0] !== tokenVersion)
      return refuse("token_malformed");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      cipherKey(key),
      bytes.subarray(1, 1 + nonceLength),
      { authTagLength: tagLength },
    );
    decipher.setAAD(associatedData);
    decipher.setAuthTag(bytes.subarray(1 + nonceLength, 1 + nonceLength + tagLength));
    const payload = Buffer.concat([
      decipher.update(bytes.subarray(1 + nonceLength + tagLength)),
      decipher.final(),
    ]).toString("utf8");
    const parsed = selectionDescriptorSchema.safeParse(JSON.parse(payload));
    if (!parsed.success) return refuse("payload_invalid");
    descriptor = parsed.data;
  } catch {
    return refuse("token_not_authentic");
  }
  const { session, selection } = expected;
  if (!sameId(descriptor.identityId, session.identityId)) return refuse("other_person");
  if (
    !sameId(descriptor.organizationId, selection.organizationId) ||
    selection.applicationRootId === undefined ||
    !sameId(descriptor.applicationRootId, selection.applicationRootId) ||
    (descriptor.previewInstallationId ?? "") !== (selection.previewInstallationId ?? "")
  )
    return refuse("other_scope");
  if (descriptor.installationRevision !== expected.installationRevision)
    return refuse("release_changed");
  if (!sameId(descriptor.pageId, expected.pageId)) return refuse("other_page");
  if (!sameId(descriptor.placementId, expected.placementId)) return refuse("other_placement");
  if (now() - descriptor.issuedAt > descriptorLifetimeMilliseconds) return refuse("expired");
  return descriptor;
};
