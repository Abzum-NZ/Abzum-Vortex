import "server-only";

import { z } from "zod";
import type { IdentitySession } from "../access/identity-access";
import type { applicationRootIdSchema, organizationIdSchema } from "../catalogue/identifiers";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import type { FlowRefusalFeedback } from "../workflows/flow-refusal-feedback";
import { databaseErrorCode } from "./definition-error";
import {
  installationProblem,
  readInstallationHumanContext,
  readInstallationOrdinaryRoot,
  requireInstallationAuthority,
  type StoreReceiptCompletion,
} from "./installation-authority";
import type { FirstInstallCoordinatorEnvironment } from "./installation-first-install-coordinator";

const count = z.number().int().nonnegative();

/** What removing an application's data, or deleting the application, takes with it. */
const purgeImpactSchema = z
  .object({
    application_name: z.string().min(1),
    installed: z.boolean(),
    roles: count,
    role_assignments: count,
    permission_entries: count,
    releases: count,
    records: count,
    record_tables: count,
    external_links: count,
  })
  .strict();

export type ApplicationPurgeImpact = z.infer<typeof purgeImpactSchema>;

/** A refusal the person is told by name: the database or the typed confirmation said no. */
export class ApplicationPurgeRefused extends Error {
  readonly code: FlowRefusalFeedback["code"];
  constructor(code: FlowRefusalFeedback["code"], options?: ErrorOptions) {
    super(code, options);
    this.name = "ApplicationPurgeRefused";
    this.code = code;
  }
}

const purgeOperation = (rootId: string) => ({
  kind: "installation" as const,
  applicationRootId: rootId,
  change: "purge" as const,
  containsCustomComponents: false,
  acceptedPermissions: [],
});

type PurgeRow = DatabaseRow & { readonly purge_result: unknown };

/** One call of the purge function: count what it would take, or take it. */
const callPurge = async (
  transaction: RequestDatabaseTransaction,
  rootId: string,
  apply: boolean,
  deleteOnly: boolean,
  confirmedName: string | null,
): Promise<unknown> => {
  try {
    const rows = await transaction.query<PurgeRow>`
      select vortex_definition.purge_application(
        ${rootId}::uuid, ${apply}::boolean, ${deleteOnly}::boolean, ${confirmedName}::text
      ) as purge_result
    `;
    if (rows.length !== 1 || rows[0] === undefined)
      installationProblem("purge_result_missing", "failed");
    return rows[0].purge_result;
  } catch (error) {
    // The purge's own refusals have their own states; any other database error, a history
    // protection included, is a failure whose cause stays in the log.
    switch (databaseErrorCode(error)) {
      case "VX001":
        throw new ApplicationPurgeRefused("application_is_default", { cause: error });
      case "VX002":
        throw new ApplicationPurgeRefused("application_has_dependents", { cause: error });
      case "VX003":
        throw new ApplicationPurgeRefused("application_is_installed", { cause: error });
      case "VX004":
        throw new ApplicationPurgeRefused("application_name_mismatch", { cause: error });
      case "23514":
      case "23503":
        throw new ApplicationPurgeRefused("application_purge_blocked", { cause: error });
      default:
        throw error;
    }
  }
};

const readImpact = async (
  transaction: RequestDatabaseTransaction,
  rootId: string,
  deleteOnly: boolean,
): Promise<ApplicationPurgeImpact> =>
  purgeImpactSchema.parse(await callPurge(transaction, rootId, false, deleteOnly, null));

/**
 * Reads what removing the application's data (or deleting the application) would take, under the
 * installer's current authority, a recent sign-in included: the person is asked to sign in again
 * before the dialog shows the impact, not after the confirmation.
 */
export const readApplicationPurge = async (
  environment: FirstInstallCoordinatorEnvironment,
  session: IdentitySession,
  organizationId: z.infer<typeof organizationIdSchema>,
  rootId: z.infer<typeof applicationRootIdSchema>,
  deleteOnly: boolean,
): Promise<ApplicationPurgeImpact> => {
  let failure: unknown;
  const result = await environment.requests.runChange(
    session,
    { organizationId },
    async (transaction, scope, issuedAt) => {
      try {
        await readInstallationHumanContext(transaction, scope, session, issuedAt, {
          organizationId,
        });
        await readInstallationOrdinaryRoot(transaction, rootId);
        await requireInstallationAuthority(
          transaction,
          scope,
          environment.permissions,
          purgeOperation(rootId),
        );
        return await readImpact(transaction, rootId, deleteOnly);
      } catch (error) {
        failure = error;
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (failure !== undefined) throw failure;
  return installationProblem(
    "purge_read_unavailable",
    result.kind === "unavailable" ? "refused" : "temporarily_unavailable",
  );
};

/**
 * Removes the application and everything it holds in one atomic transaction: the typed name must
 * match the application's, the installer's authority and recent sign-in are proved again, and the
 * purge function takes the data, the access and the definition together and records the Activity.
 * Deleting refuses an installed application; purging also removes an installed one.
 */
export const purgeApplication = async (
  environment: FirstInstallCoordinatorEnvironment,
  session: IdentitySession,
  organizationId: z.infer<typeof organizationIdSchema>,
  rootId: z.infer<typeof applicationRootIdSchema>,
  confirmedName: string,
  deleteOnly: boolean,
  receipt?: StoreReceiptCompletion,
): Promise<ApplicationPurgeImpact> => {
  let failure: unknown;
  const result = await environment.requests.runAccessChange(
    session,
    { organizationId },
    async (transaction, scope, issuedAt) => {
      try {
        await readInstallationHumanContext(transaction, scope, session, issuedAt, {
          organizationId,
        });
        await readInstallationOrdinaryRoot(transaction, rootId);
        await requireInstallationAuthority(
          transaction,
          scope,
          environment.permissions,
          purgeOperation(rootId),
        );
        const impact = await readImpact(transaction, rootId, deleteOnly);
        // The purge is the target: its receipt completes before the purge changes the access
        // version the completion checks. The typed name is checked inside the purge itself.
        if (receipt !== undefined)
          await receipt(transaction, {
            application_name: impact.application_name,
            roles: impact.roles,
            records: impact.records,
            record_tables: impact.record_tables,
          });
        await callPurge(transaction, rootId, true, deleteOnly, confirmedName);
        return impact;
      } catch (error) {
        failure = error;
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (failure !== undefined) throw failure;
  return installationProblem(
    "purge_unavailable",
    result.kind === "unavailable" ? "refused" : "temporarily_unavailable",
  );
};

/**
 * Proves, before an install, upgrade or removal is shown, that the person's sign-in is recent
 * enough for the change: the dialog asks to sign in again up front, never after the form is filled.
 */
export const requireApplicationChangeStepUp = async (
  environment: FirstInstallCoordinatorEnvironment,
  session: IdentitySession,
  organizationId: z.infer<typeof organizationIdSchema>,
  rootId: z.infer<typeof applicationRootIdSchema>,
): Promise<void> => {
  let failure: unknown;
  const result = await environment.requests.runChange(
    session,
    { organizationId },
    async (transaction, scope, issuedAt) => {
      try {
        await readInstallationHumanContext(transaction, scope, session, issuedAt, {
          organizationId,
        });
        await requireInstallationAuthority(transaction, scope, environment.permissions, {
          kind: "installation",
          applicationRootId: rootId,
          change: "install_or_upgrade",
          containsCustomComponents: false,
          acceptedPermissions: [],
          stepUp: true,
        });
        return true;
      } catch (error) {
        failure = error;
        throw error;
      }
    },
  );
  if (result.kind === "available") return;
  if (failure !== undefined) throw failure;
  installationProblem(
    "step_up_unavailable",
    result.kind === "unavailable" ? "refused" : "temporarily_unavailable",
  );
};
