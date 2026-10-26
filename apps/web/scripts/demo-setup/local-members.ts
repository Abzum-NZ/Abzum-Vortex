import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  acceptOrganizationInvitationCommandSchema,
  createOrganizationInvitationForAdministrationCommandSchema,
  organizationSelectionCandidateSchema,
  unavailableError,
  verifiedIdentitySchema,
} from "@vortex/platform/schema";
import {
  acceptOrganizationInvitation,
  createOrganizationLocalAdministrationService,
} from "@vortex/platform/server";
import { nominatedOwnerSession } from "../development-setup/development-authority";

/**
 * Adds an organisation member to a local database the way the application does: a confirmed Auth
 * identity, an invitation from the nominated owner and its acceptance by the invited identity.
 */

export type LocalOrganisationFacts = Readonly<{
  organizationId: string;
  stewardIdentityId: string;
  identityAuthorityId: string;
}>;

/** Finds or creates the confirmed local Auth identity for an email; a new one has a random password nobody knows. */
export const ensureLocalIdentity = async (email: string, displayName: string): Promise<string> => {
  const url = process.env.VORTEX_SUPABASE_URL;
  const key = process.env.VORTEX_DEV_SERVICE_ROLE_KEY;
  if (url === undefined || key === undefined)
    throw new Error("The local Supabase URL and service key are not in the web environment.");
  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const findExistingIdentity = async (): Promise<string | undefined> => {
    for (let page = 1; page <= 50; page += 1) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error !== null)
        throw unavailableError(
          `Local Auth user lookup failed (${error.status ?? "unknown"}).`,
          "LOCAL_AUTH_USER_LOOKUP_FAILED",
          error,
        );
      const found = data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
      if (found !== undefined) return found.id;
      if (data.users.length < 200) return undefined;
    }
    throw unavailableError(
      "Local Auth user lookup exceeded its page limit.",
      "LOCAL_AUTH_USER_LOOKUP_LIMIT",
    );
  };
  const existing = await findExistingIdentity();
  if (existing !== undefined) return existing;
  const created = await admin.auth.admin.createUser({
    email,
    password: `${randomUUID()}-Aa1`,
    email_confirm: true,
    user_metadata: { full_name: displayName },
  });
  if (created.error === null && created.data.user !== null) return created.data.user.id;
  if (created.error?.code === "email_exists") {
    const createdByAnotherRun = await findExistingIdentity();
    if (createdByAnotherRun !== undefined) return createdByAnotherRun;
  }
  throw unavailableError(
    `Local account creation failed (${created.error?.code ?? "unknown"}).`,
    "LOCAL_AUTH_USER_CREATION_FAILED",
    created.error,
  );
};

/** Invites the identity's email into the organisation, accepts as that identity and returns its new account id. */
export const inviteLocalMember = async (
  facts: LocalOrganisationFacts,
  identityId: string,
  email: string,
  displayName: string,
): Promise<string> => {
  const owner = nominatedOwnerSession(facts.stewardIdentityId);
  const selection = organizationSelectionCandidateSchema.parse({
    organizationId: facts.organizationId,
  });
  const administration = createOrganizationLocalAdministrationService({
    identityAuthorityId: facts.identityAuthorityId as never,
  });
  const created = await administration.createOrganizationInvitation(
    owner,
    selection,
    createOrganizationInvitationForAdministrationCommandSchema.parse({
      duplicateKey: randomUUID(),
      invitedEmail: email,
      expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    }),
  );
  if (created.kind !== "available" || created.value.outcome !== "accepted")
    throw unavailableError(
      `The invitation for ${email} was not created (${created.kind}).`,
      `LOCAL_INVITATION_CREATE_${created.kind.toUpperCase()}${created.kind === "available" ? `_${created.value.outcome.toUpperCase()}` : ""}`,
    );
  const now = new Date();
  const verified = verifiedIdentitySchema.parse({
    identityId,
    verifiedPrimaryEmail: email,
    issuer: `${process.env.VORTEX_SUPABASE_URL}/auth/v1`,
    audience: "authenticated",
    sessionId: randomUUID(),
    issuedAt: new Date(now.getTime() - 1_000).toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    authenticationStrength: "single_factor",
    primaryAuthenticatedAt: new Date(now.getTime() - 1_000).toISOString(),
    keyId: "local-members",
  });
  const accepted = await acceptOrganizationInvitation(
    verified,
    acceptOrganizationInvitationCommandSchema.parse({
      invitationId: created.value.invitationId,
      displayName,
      correlationId: randomUUID(),
    }),
  );
  if (accepted.outcome !== "accepted" && accepted.outcome !== "already_accepted")
    throw unavailableError(
      `The invitation for ${email} was not accepted (${accepted.outcome}).`,
      `LOCAL_INVITATION_ACCEPT_${accepted.outcome.toUpperCase()}`,
    );
  return accepted.account.organizationAccountId;
};
