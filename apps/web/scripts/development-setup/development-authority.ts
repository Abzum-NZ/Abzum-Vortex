import { randomUUID } from "node:crypto";
import {
  identitySessionSchema,
  sessionContextSchema,
  type IdentitySession,
  type SessionContext,
} from "@vortex/contracts";
import { withResolvedRequestTransaction, type RequestDatabaseTransaction } from "@vortex/db";
import type { BuilderAuthority } from "@vortex/access";

/**
 * The development-only authorities this script needs and that no runtime package provides on
 * purpose. They exist only in this script: no runtime package gains a stub authority, a
 * system-context minter or a bypass, and the script refuses to start unless it targets the
 * local Supabase database (see guards.ts).
 */

/**
 * The builder authority for the disposable local setup. Production builder authority decides from
 * the installer's own platform permissions; a freshly provisioned steward holds none by design, so
 * the local setup, which the developer runs deliberately on their own machine, allows the builder
 * operations it performs. The database still decides every write through its own protected checks.
 */
export const developmentBuilderAuthority = (organizationId: string): BuilderAuthority => ({
  organizationId,
  require: async () => ({ outcome: "allowed" }),
});

export type SystemContextFacts = Readonly<{
  tenantId: string;
  organizationId: string;
  systemActorId: string;
  accessVersion: number;
}>;

/** A fresh, short-lived system context for the target organisation. */
export const mintSystemContext = (facts: SystemContextFacts): SessionContext => {
  const now = Date.now();
  return sessionContextSchema.parse({
    callerKind: "system",
    tenantId: facts.tenantId,
    organizationId: facts.organizationId,
    systemActorId: facts.systemActorId,
    sessionId: randomUUID(),
    authenticationStrength: "service",
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 15 * 60_000).toISOString(),
    accessVersion: facts.accessVersion,
    correlationId: randomUUID(),
  });
};

/** Runs one operation in a request transaction initialised with the given system context. */
export const inSystemTransaction = <Result>(
  context: SessionContext,
  operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
): Promise<Result> =>
  withResolvedRequestTransaction(
    async () => ({ context, scope: undefined }),
    (transaction) => operation(transaction),
  );

/**
 * The identity session of the nominated first owner as the trusted local setup vouches for it: the
 * person just signed up locally and the developer named them on the command line. The recent
 * primary authentication that installing an application requires is the developer's own run of
 * this command, so it is stamped now and lasts one hour.
 */
export const nominatedOwnerSession = (identityId: string): IdentitySession => {
  const now = Date.now();
  const issuedAt = new Date(now - 1_000).toISOString();
  return identitySessionSchema.parse({
    identityId,
    sessionId: randomUUID(),
    authenticationStrength: "single_factor",
    accessTokenIssuedAt: issuedAt,
    accessTokenExpiresAt: new Date(now + 60 * 60_000).toISOString(),
    primaryAuthenticatedAt: issuedAt,
  });
};
