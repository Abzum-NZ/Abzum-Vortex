import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assignOrganizationAdministrationRoleAssignmentCommandSchema,
  describeFailure,
  organizationSelectionCandidateSchema,
} from "@vortex/platform/schema";
import {
  createOrganizationAccessAdministrationService,
  withRequestDatabaseLifetime,
} from "@vortex/platform/server";
import { nominatedOwnerSession } from "../development-setup/development-authority";
import { DevelopmentSetupRefusal } from "../development-setup/guards";
import { ensureLocalIdentity, inviteLocalMember } from "../demo-setup/local-members";
import { openLane, personaEmails, type LaneFacts } from "./lane";

/**
 * Gives a database lane two more organisation accounts next to the first owner, so the list-paging
 * baseline can measure an ordinary member and a restricted viewer. Everything goes through the
 * protected operations the application itself uses: an invitation from the owner, its acceptance by
 * the invited identity, and standing role assignments. A persona that already holds an account or
 * an assignment is left as it is, so the script can be re-run.
 *
 * This provisions measurement identities, not browser sign-in credentials.
 * Usage: pnpm --filter @vortex/web list:personas -- --lane 4
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

const step = async <Result>(name: string, operation: () => Promise<Result>): Promise<Result> => {
  log(`starting ${name}`);
  try {
    const result = await operation();
    log(`completed ${name}`);
    return result;
  } catch (error) {
    process.stderr.write(`[personas] ${name} failed: cause=${describeFailure(error)}\n`);
    throw error;
  }
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
    const roles = await step(
      `find role ${prefix}`,
      () => facts.administration`
      select role_id, live_revision, role_key from vortex_access.organization_roles
      where organization_id = ${facts.organizationId}
        and left(role_key, char_length(${prefix})) = ${prefix}`,
    );
    if (roles.length !== 1) {
      log(`role lookup failed: expected one role for ${prefix}, found ${roles.length}`);
      throw new Error("PERSONA_ROLE_NOT_UNIQUE");
    }
    const role = roles[0]!;
    const [held] = await step(
      `check assignment ${prefix}`,
      () => facts.administration`
      select 1 as held from vortex_access.organization_role_assignments
      where organization_id = ${facts.organizationId} and role_id = ${role.role_id}
        and organization_account_id = ${accountId}::uuid and state = 'live'`,
    );
    if (held !== undefined) {
      log(`retained existing assignment ${prefix}`);
      continue;
    }
    const assigned = await step(`assign role ${prefix}`, () =>
      administration.assignRoleAssignment(
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
      ),
    );
    if (assigned.kind !== "available" || !("assignment" in assigned.value)) {
      log(
        `role ${prefix} assignment refused: ${assigned.kind}${assigned.kind === "available" && "outcome" in assigned.value ? `/${assigned.value.outcome}` : ""}`,
      );
      throw new Error(`Role ${role.role_key} could not be assigned (${assigned.kind}).`);
    }
    log(`assigned ${role.role_key as string}`);
  }
};

const main = async (): Promise<void> => {
  const facts = openLane();
  try {
    log(
      `using completed local setup state for lane ${facts.lane}: ${facts.tenantShortName}/${facts.organizationShortName}, organisation ${facts.organizationId}`,
    );
    // Protected operations must own their runtime connections as well as the direct SQL client.
    await withRequestDatabaseLifetime(
      { signal: new AbortController().signal, deadline: Date.now() + 5 * 60_000 },
      async () => {
        for (const [index, persona] of personas().entries()) {
          const label = index === 0 ? "member" : "viewer";
          const displayName = persona.email.split("@")[0]!;
          const identityId = await step(`${label} identity`, () =>
            ensureLocalIdentity(persona.email, displayName),
          );
          const accountId =
            (await step(`${label} existing account`, () => accountOf(facts, identityId))) ??
            (await step(`${label} invitation and acceptance`, () =>
              inviteLocalMember(facts, identityId, persona.email, displayName),
            ));
          log(`${persona.email} is organisation account ${accountId}`);
          await step(`${label} roles`, () =>
            assignRoles(facts, accountId, persona.roleKeyPrefixes),
          );
          log(
            `${label} identity ${identityId}: measurement account ready; browser sign-in credential not provided or verified by this command`,
          );
        }
      },
    );
    log(
      "identities and roles ready; newly created identities have random unknown passwords. Browser sign-in readiness is not established.",
    );
  } finally {
    await step("close administration connection", () => facts.administration.end());
  }
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main()
    .catch((error: unknown) => {
      if (error instanceof DevelopmentSetupRefusal)
        process.stderr.write(`[personas] ${error.message}\n`);
      process.stderr.write(`[personas] failed: cause=${describeFailure(error)}\n`);
      process.exitCode = 1;
    })
    // All work and owned DB cleanup have settled. Flush diagnostics before the one-shot exit.
    .finally(() =>
      process.stdout.write("", () =>
        process.stderr.write("", () => process.exit(process.exitCode ?? 0)),
      ),
    );
