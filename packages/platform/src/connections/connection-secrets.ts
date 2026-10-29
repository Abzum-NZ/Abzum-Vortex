import "server-only";

import { z } from "zod";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";

type SecretRow = DatabaseRow & { readonly reference: unknown };

/** Store a secret inside the current authorised request and return only its opaque reference. */
export async function storeConnectionSecret(
  transaction: RequestDatabaseTransaction,
  secret: string,
): Promise<string> {
  let rows: readonly SecretRow[];
  try {
    rows = await transaction.query<SecretRow>`
      select vortex_platform.store_connection_secret(${secret}::text) as reference
    `;
  } catch (error) {
    // Database diagnostics can contain parameter values. Preserve the SQLSTATE for diagnosis,
    // never the original message, detail, query or cause in the request logger.
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[A-Z0-9]{5}$/.test(error.code)
        ? error.code
        : "unknown";
    throw new Error(`Connection secret storage failed (${code})`);
  }
  if (rows.length !== 1) throw new Error("Connection secret storage returned an invalid row count");
  return z.guid().parse(rows[0]?.reference);
}
