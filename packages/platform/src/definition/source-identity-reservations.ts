import "server-only";
import { z } from "zod";
import { applicationRootIdSchema } from "../catalogue/identifiers";
import {
  sourceIdentityReservationSchema,
  type SourceIdentityReservation,
} from "./definition-compilation-contracts";
import type { RequestDatabaseTransaction } from "../db/request-transaction";

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
