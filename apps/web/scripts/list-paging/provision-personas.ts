import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assignOrganizationAdministrationRoleAssignmentCommandSchema,
  organizationSelectionCandidateSchema,
} from "@vortex/platform/schema";
import { createOrganizationAccessAdministrationService } from "@vortex/platform/server";
import { nominatedOwnerSession } from "../development-setup/development-authority";
import { ensureLocalIdentity, inviteLocalMember } from "../demo-setup/local-members";
import { openLane, personaEmails, type LaneFacts } from "./lane";

/**
 * Gives a database lane two more organisation accounts next to the first owner, so the list-paging
 * baseline can measure an ordinary member and a restricted viewer. Everything goes through the
 * protected operations the application itself uses: an invitation from the owner, its acceptance by
 * the invited identity, and standing role assignments. A persona that already holds an account or
 * an assignment is left as it is, so the script can be re-run.
 *
 * Usage: pnpm --filter @vortex/web list:personas -- --lane 2
 */

type Persona = Readonly<{ email: string; roleKeyPrefixes: readonly string[] }>;

// The member can use both applications; the viewer holds no role of its own in the organisation
// beyond sign-in, so every record it sees must come from sharing or ownership grants.
const personas = (): readonly Persona[] => [
  {
    email: personaEmails.member(),
    roleKeyPrefixes: ["local_crm_contributor_", "local_service_agent_"],
  },
  { email: personaEmails.viewer(), roleKeyPrefixes: [] },
];

const log = (message: string): void => {
  process.stdout.write(`[personas] ${message}\n`);
};

const accountOf = async (facts: LaneFacts, identityId: string): Promise<string | undefined> => {
  const [row] = await facts.administration`
    select organization_account_id from vortex_identity.organization_accounts
    where organization_id = ${facts.organizationId} and identity_id = ${identityId}::uuid`;
  return row?.organization_account_id as string | undefined;
};

const assignRoles = async (
  facts: LaneFacts,
  accountId: string,
  prefixes: readonly string[],
): Promise<void> => {
  const administration = createOrganizationAccessAdministrationService({
    identityAuthorityId: facts.identityAuthorityId as never,
  });
  const owner = nominatedOwnerSession(facts.stewardIdentityId);
  const selection = organizationSelectionCandidateSchema.parse({
    organizationId: facts.organizationId,
  });
  for (const prefix of prefixes) {
    const [role] = await facts.administration`
      select role_id, live_revision, role_key from vortex_access.organization_roles
      where organization_id = ${facts.organizationId} and role_key like ${`${prefix}%`}`;
    if (role === undefined) throw new Error(`No accepted role starts with ${prefix}.`);
    const [held] = await facts.administration`
      select 1 as held from vortex_access.organization_role_assignments
      where organization_id = ${facts.organizationId} and role_id = ${role.role_id}
        and organization_account_id = ${accountId}::uuid and state = 'live'`;
    if (held !== undefined) continue;
    const assigned = await administration.assignRoleAssignment(
      owner,
      selection,
      assignOrganizationAdministrationRoleAssignmentCommandSchema.parse({
        roleId: role.role_id,
        expectedRoleRevision: Number(role.live_revision),
        assigneeKind: "organization_account",
        organizationAccountId: accountId,
        assignmentKind: "standing",
        startsAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    );
    if (assigned.kind !== "available")
      throw new Error(`Role ${role.role_key} could not be assigned (${assigned.kind}).`);
    log(`assigned ${role.role_key as string}`);
  }
};

const main = async (): Promise<void> => {
  const facts = openLane();
  try {
    for (const persona of personas()) {
      const displayName = persona.email.split("@")[0]!;
      const identityId = await ensureLocalIdentity(persona.email, displayName);
      const accountId =
        (await accountOf(facts, identityId)) ??
        (await inviteLocalMember(facts, identityId, persona.email, displayName));
      log(`${persona.email} is organisation account ${accountId}`);
      await assignRoles(facts, accountId, persona.roleKeyPrefixes);
    }
  } finally {
    await facts.administration.end();
  }
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error: unknown) => {
    process.stderr.write(
      `[personas] failed: ${error instanceof Error ? error.message : "unexpected error"}\n`,
    );
    process.exitCode = 1;
  });
