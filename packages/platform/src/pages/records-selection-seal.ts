import "server-only";

import { z } from "zod";
import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import { jsonValueSchema, type JsonValue } from "../catalogue/common";
import {
  applicationRootIdSchema,
  identityIdSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  queryIdSchema,
  revisionSchema,
} from "../catalogue/identifiers";
import { sameId } from "../catalogue/runtime-primitives";
import type { RecordsTableQueryState } from "./records-table-state";
import type { QueryContinuationKey } from "../queries/continuation-token";
import { openToken, sealToken } from "../queries/sealed-token";

/** Who reads a placement-bound sealed token, and the release, page and placement it addresses. */
export type PlacementTokenExpectation = Readonly<{
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
  installationRevision: number;
  pageId: string;
  placementId: string;
}>;

/**
 * The binding every placement-bound sealed token carries (a records selection, a pivot position):
 * the person, organisation, application, installed release, page and placement it was issued for,
 * and when.
 */
export const placementTokenBindingShape = {
  identityId: identityIdSchema,
  organizationId: organizationIdSchema,
  applicationRootId: applicationRootIdSchema,
  previewInstallationId: z.string().uuid().optional(),
  installationRevision: revisionSchema,
  pageId: z.string().min(1).max(200),
  placementId: z.string().min(1).max(200),
  issuedAt: z.number().int().positive(),
};
type PlacementTokenBinding = z.infer<z.ZodObject<typeof placementTokenBindingShape>>;

/** The binding of a token issued now for the expected reader and placement. */
export const placementTokenBinding = (
  expected: PlacementTokenExpectation,
  now: () => number,
): PlacementTokenBinding => {
  const { session, selection } = expected;
  if (selection.applicationRootId === undefined)
    throw new Error("PLACEMENT_TOKEN_APPLICATION_NOT_SELECTED");
  return {
    identityId: session.identityId,
    organizationId: selection.organizationId,
    applicationRootId: selection.applicationRootId,
    ...(selection.previewInstallationId === undefined
      ? {}
      : { previewInstallationId: selection.previewInstallationId }),
    installationRevision: expected.installationRevision,
    pageId: expected.pageId,
    placementId: expected.placementId,
    issuedAt: now(),
  };
};

/**
 * Why an opened token is not for the read that now presents it (another person, scope, release,
 * page or placement, or past its lifetime); undefined when it is.
 */
export const placementTokenRefusal = (
  binding: PlacementTokenBinding,
  expected: PlacementTokenExpectation,
  lifetimeMilliseconds: number,
  now: () => number,
): string | undefined => {
  const { session, selection } = expected;
  if (!sameId(binding.identityId, session.identityId)) return "other_person";
  if (
    !sameId(binding.organizationId, selection.organizationId) ||
    selection.applicationRootId === undefined ||
    !sameId(binding.applicationRootId, selection.applicationRootId) ||
    (binding.previewInstallationId ?? "") !== (selection.previewInstallationId ?? "")
  )
    return "other_scope";
  if (binding.installationRevision !== expected.installationRevision) return "release_changed";
  if (!sameId(binding.pageId, expected.pageId)) return "other_page";
  if (!sameId(binding.placementId, expected.placementId)) return "other_placement";
  if (now() - binding.issuedAt > lifetimeMilliseconds) return "expired";
  return undefined;
};

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
    ...placementTokenBindingShape,
    moduleRootId: moduleRootIdSchema,
    queryId: queryIdSchema,
    inputValues: z.record(z.string(), jsonValueSchema),
    sort: z.array(jsonValueSchema).max(20),
    filters: z.array(jsonValueSchema).max(200),
    search: z.string().max(500).nullable(),
    /** The organisation time zone a date-and-time filter was read in, when one applies. */
    timeZone: z.string().min(1).max(100).optional(),
  })
  .strict();
export type RecordsSelectionDescriptor = z.infer<typeof selectionDescriptorSchema>;

/** A sealed descriptor stays usable for an hour; "Select all matching records" seals a fresh one. */
const descriptorLifetimeMilliseconds = 3_600_000;
const purpose = "vortex.records.selection.v1";

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
  (target) =>
    sealToken(
      key,
      purpose,
      selectionDescriptorSchema.parse({
        version: 1,
        ...placementTokenBinding(
          {
            session,
            selection,
            installationRevision: target.installationRevision,
            pageId: target.pageId,
            placementId: target.placementId,
          },
          now,
        ),
        moduleRootId: target.moduleRootId,
        queryId: target.queryId,
        inputValues: target.inputValues,
        sort: target.state.sort,
        filters: target.state.filters,
        search: target.state.search,
        ...(target.timeZone === undefined ? {} : { timeZone: target.timeZone }),
      }),
    );

/**
 * Opens a sealed descriptor for the person it was sealed for, in the same organisation,
 * application and installed release, for the same placement, within its lifetime. Anything else
 * (a tampered or foreign token, another person, a newer release) is refused, with the cause logged.
 */
export const openRecordsSelection = (
  token: string,
  key: QueryContinuationKey,
  /** Who opens the descriptor, and the release and placement the command addresses now. */
  expected: PlacementTokenExpectation,
  now: () => number = Date.now,
): RecordsSelectionDescriptor | undefined => {
  const refuse = (cause: string): undefined => {
    console.error(`[records-selection] descriptor refused cause=${cause}`);
    return undefined;
  };
  const opening = openToken(key, purpose, token);
  if (opening.kind === "refused") return refuse(opening.cause);
  const parsed = selectionDescriptorSchema.safeParse(opening.payload);
  if (!parsed.success) return refuse("payload_invalid");
  const cause = placementTokenRefusal(parsed.data, expected, descriptorLifetimeMilliseconds, now);
  return cause === undefined ? parsed.data : refuse(cause);
};
