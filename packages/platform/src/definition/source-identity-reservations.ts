import "server-only";
import { z } from "zod";
import {
  applicationRootIdSchema,
  sourceIdentityReservationSchema,
  type SourceIdentityReservation,
} from "../schema";
import type { RequestDatabaseTransaction } from "../db/index";

/** The protected database read includes this application's owned modules and historical aliases. */
export const readSourceIdentityReservations = async (
  transaction: RequestDatabaseTransaction,
  rootId: string,
): Promise<readonly SourceIdentityReservation[]> => {
  const rows = await transaction.query`
    select vortex_definition.read_source_identity_reservations(${applicationRootIdSchema.parse(rootId)}::uuid) as reservations
  `;
  return z
    .array(z.object({ reservations: z.array(sourceIdentityReservationSchema) }).strict())
    .length(1)
    .parse(rows)[0]!.reservations;
};
