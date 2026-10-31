import "server-only";

import { z } from "zod";
import type { IdentitySession } from "../../access/identity-access";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
} from "../../access/human-organization-request";
import type { RecordsTableRunRequest, RecordsTableRunResult } from "../records-selection";
import type { RecordsTableCommandAddress } from "./placement";

const chainSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("refused") }),
  z.object({
    kind: z.literal("read"),
    state: z.enum(["running", "succeeded", "failed"]),
    pages: z.number().int().min(1),
    failureCode: z.string().max(100).nullable(),
  }),
]);

/**
 * Where a background run the person started has got to. The database decides, from the person's
 * own request context, that the run is theirs in this application; it reports state, number of
 * runs and failure code, never what a run produced.
 */
export const createRecordsTableRunService = (
  dependencies: HumanOrganizationRequestDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  return Object.freeze({
    async read(
      session: IdentitySession,
      address: RecordsTableCommandAddress,
      request: RecordsTableRunRequest,
    ): Promise<RecordsTableRunResult> {
      const result = await requests.run(session, address.selection, async (transaction) => {
        const rows = await transaction.query`
          select vortex_platform.read_own_backend_run_chain(${request.run}::uuid) as chain
        `;
        return chainSchema.parse((rows[0] as { chain: unknown } | undefined)?.chain);
      });
      if (result.kind !== "available") return { kind: "unavailable" };
      if (result.value.kind === "refused") return { kind: "refused", reason: "not_available" };
      return result.value;
    },
  });
};
