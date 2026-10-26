import "server-only";

import {
  connectionInstanceIdSchema,
  organizationIdSchema,
  type ConnectionInstanceId,
  type OrganizationId,
} from "../catalogue/identifiers";
import { logRefusal, sameId } from "../catalogue/runtime-primitives";
import {
  connectionInstanceStatusSchema,
  type ConnectionInstanceStatus,
} from "./integration-contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";

/**
 * The protected read side of connection administration.
 *
 * A connection administration page must show the organisation's instances and their safe status
 * without ever receiving a secret. This module reads through the request-callable
 * `vortex_platform.*_for_administration` readers, which are SECURITY DEFINER functions that
 * require the validated connection-administration context: the caller must hold
 * `platform.organization.connections.manage` in the request-context organisation, and every row is
 * filtered to that organisation, so another organisation's instance is never returned. The reader
 * returns only the page read model - state, health, expiry, authority revision and both scope lists -
 * and never a secret value, a secret reference, an organisation identity or an administrator
 * activity identity.
 *
 * Nothing here is authority. The SQL readers decide the organisation and the permission on every
 * call; this module validates shape, applies the caller's expected organisation as a cross-check and
 * returns a fixed safe outcome.
 */

/** The largest page of connection instances one read may return, matching the SQL reader's own bound. */
export const MAXIMUM_CONNECTION_INSTANCE_PAGE_SIZE = 100;

/** The closed set of reasons a connection instance read may be refused. */
export const connectionInstanceReaderRefusalCodes = [
  "invalid_parameters",
  "not_authorized",
  "connection_unavailable",
  "administration_unavailable",
] as const;

export type ConnectionInstanceReaderRefusalCode =
  (typeof connectionInstanceReaderRefusalCodes)[number];

export type ConnectionInstanceReadResult =
  | Readonly<{ outcome: "available"; instance: ConnectionInstanceStatus }>
  | Readonly<{ outcome: "unavailable"; reasonCode: ConnectionInstanceReaderRefusalCode }>;

/** One bounded page of safe instance statuses, with the cursor for the next page when there is one. */
export type ConnectionInstancePageReadResult =
  | Readonly<{
      outcome: "available";
      instances: readonly ConnectionInstanceStatus[];
      nextAfterConnectionInstanceId?: ConnectionInstanceId;
    }>
  | Readonly<{ outcome: "unavailable"; reasonCode: ConnectionInstanceReaderRefusalCode }>;

/** One reader page request: an optional exclusive cursor and a bounded page size. */
export type ConnectionInstancePageQuery = Readonly<{
  afterConnectionInstanceId?: ConnectionInstanceId;
  pageSize: number;
}>;

type ListConnectionInstancesRow = DatabaseRow & {
  readonly organization_id: unknown;
  readonly connection_instances: unknown;
  readonly next_after_connection_instance_id: unknown;
};

const unavailable = (
  reasonCode: ConnectionInstanceReaderRefusalCode,
  cause?: unknown,
): Readonly<{ outcome: "unavailable"; reasonCode: ConnectionInstanceReaderRefusalCode }> => {
  logRefusal("connection", "administration instance page", reasonCode, cause);
  return Object.freeze({ outcome: "unavailable", reasonCode });
};

/** Maps a database failure to a fixed code by SQLSTATE only; the message is never read. */
const refusalForFailure = (error: unknown): ConnectionInstanceReaderRefusalCode => {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  if (code === "42501") return "not_authorized";
  if (code === "22023" || code === "22003") return "invalid_parameters";
  return "administration_unavailable";
};

class ConnectionInstanceReadFailure<Code extends string> extends Error {
  readonly code: Code;

  constructor(
    readonly reasonCode: Code,
    cause: unknown,
  ) {
    super("Connection instance administration read failed", { cause });
    this.name = "ConnectionInstanceReadFailure";
    this.code = reasonCode;
  }
}

/** Identifiers are case-insensitive: compare the canonical lower-cased forms. */
const sameIdentifier = (left: unknown, right: string): boolean =>
  typeof left === "string" && sameId(left, right);

/** Validates a page request as shapes, returning no value when the page size or cursor is malformed. */
const validatePageQuery = (
  organizationId: unknown,
  query: unknown,
):
  | Readonly<{
      organization: string;
      afterConnectionInstanceId: string | null;
      pageSize: number;
    }>
  | undefined => {
  try {
    if (query === null || typeof query !== "object") return undefined;
    const candidate = query as Readonly<{
      afterConnectionInstanceId?: unknown;
      pageSize?: unknown;
    }>;
    if (
      typeof candidate.pageSize !== "number" ||
      !Number.isInteger(candidate.pageSize) ||
      candidate.pageSize < 1 ||
      candidate.pageSize > MAXIMUM_CONNECTION_INSTANCE_PAGE_SIZE
    )
      return undefined;
    return Object.freeze({
      organization: organizationIdSchema.parse(organizationId),
      afterConnectionInstanceId:
        candidate.afterConnectionInstanceId === undefined
          ? null
          : connectionInstanceIdSchema.parse(candidate.afterConnectionInstanceId),
      pageSize: candidate.pageSize,
    });
  } catch (error) {
    logRefusal("connection", "administration page query", "page_query_malformed", error);
    return undefined;
  }
};

/**
 * Reads one bounded page of the organisation's connection instance safe statuses.
 *
 * The page size and optional cursor are validated as shapes first; the SQL reader then re-checks the
 * organisation and the administration permission from the request context and returns only instances
 * of that organisation. A malformed page, a row from a different organisation than the caller
 * asserted, and a malformed status value are all one neutral `unavailable`, so neither a secret nor
 * another organisation's instance is ever returned.
 */
export async function listConnectionInstancesForAdministration(
  transaction: RequestDatabaseTransaction,
  organizationId: OrganizationId,
  query: ConnectionInstancePageQuery,
): Promise<ConnectionInstancePageReadResult> {
  const validated = validatePageQuery(organizationId, query);
  if (validated === undefined) return unavailable("invalid_parameters");
  const { organization, afterConnectionInstanceId, pageSize } = validated;

  try {
    const rows = await transaction.query<ListConnectionInstancesRow>`
      select organization_id, connection_instances, next_after_connection_instance_id
      from vortex_platform.list_connection_instances_for_administration(
        ${organization}::uuid,
        ${afterConnectionInstanceId}::uuid,
        ${pageSize}::integer
      )
    `;
    const row = rows.length === 1 ? rows[0] : undefined;
    if (row === undefined) return unavailable("administration_unavailable");
    if (!sameIdentifier(row.organization_id, organization))
      throw new Error("CONNECTION_INSTANCE_PAGE_ORGANIZATION_MISMATCH");
    if (!Array.isArray(row.connection_instances))
      throw new Error("CONNECTION_INSTANCE_PAGE_VALUE_INVALID");

    const parsed = connectionInstanceStatusSchema
      .array()
      .max(MAXIMUM_CONNECTION_INSTANCE_PAGE_SIZE)
      .safeParse(row.connection_instances);
    if (!parsed.success)
      throw new Error("CONNECTION_INSTANCE_PAGE_STATUS_MALFORMED", { cause: parsed.error });

    if (
      row.next_after_connection_instance_id === null ||
      row.next_after_connection_instance_id === undefined
    )
      return Object.freeze({ outcome: "available", instances: Object.freeze([...parsed.data]) });

    const next = connectionInstanceIdSchema.safeParse(row.next_after_connection_instance_id);
    if (!next.success)
      throw new Error("CONNECTION_INSTANCE_PAGE_CURSOR_MALFORMED", { cause: next.error });
    return Object.freeze({
      outcome: "available",
      instances: Object.freeze([...parsed.data]),
      nextAfterConnectionInstanceId: next.data,
    });
  } catch (error) {
    const failure = new ConnectionInstanceReadFailure(refusalForFailure(error), error);
    return unavailable(failure.reasonCode, failure);
  }
}
