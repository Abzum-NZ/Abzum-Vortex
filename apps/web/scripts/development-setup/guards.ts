import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  identityAuthorityIdSchema,
  identityIdSchema,
  isLoopbackHostname,
  type IdentityAuthorityId,
} from "@vortex/contracts";
import { createClient } from "@supabase/supabase-js";
import { findRepositoryRoot } from "./state";

/**
 * Everything that decides whether the development setup may run at all, and for whom. The setup
 * is a local-development tool: it refuses a production process, a hosted database and a missing
 * explicit flag before it opens a single connection, and it takes the one nominated account from
 * the command line, never from a browser.
 */

export const localRuntimeDatabaseUrl =
  "postgresql://vortex_runtime:vortex-runtime-local-only@127.0.0.1:54322/postgres";
const localDatabasePort = "54322";

export class DevelopmentSetupRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevelopmentSetupRefusal";
  }
}

export type FirstOwnerNomination =
  Readonly<{ kind: "identity"; identityId: string }> | Readonly<{ kind: "email"; email: string }>;

export type DevelopmentSetupArguments = Readonly<{ firstOwner: FirstOwnerNomination }>;

const usage =
  "Usage: pnpm setup:local -- --local-development (--first-owner-email <email> | --first-owner-identity-id <uuid>)";

/** Parses exactly the supported flags; anything else is refused. */
export const parseSetupArguments = (argv: readonly string[]): DevelopmentSetupArguments => {
  let localDevelopment = false;
  let email: string | undefined;
  let identityId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") continue;
    if (flag === "--local-development") {
      localDevelopment = true;
      continue;
    }
    if (flag === "--first-owner-email" || flag === "--first-owner-identity-id") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new DevelopmentSetupRefusal(`${flag} needs a value. ${usage}`);
      index += 1;
      if (flag === "--first-owner-email") email = value;
      else identityId = value;
      continue;
    }
    throw new DevelopmentSetupRefusal(`Unsupported argument ${String(flag)}. ${usage}`);
  }
  if (!localDevelopment)
    throw new DevelopmentSetupRefusal(
      `The explicit --local-development flag is required. ${usage}`,
    );
  if ((email === undefined) === (identityId === undefined))
    throw new DevelopmentSetupRefusal(
      `Nominate exactly one first owner, by email or by identity id. ${usage}`,
    );
  if (identityId !== undefined) {
    const parsed = identityIdSchema.safeParse(identityId);
    if (!parsed.success)
      throw new DevelopmentSetupRefusal("--first-owner-identity-id must be a UUID");
    return { firstOwner: { kind: "identity", identityId: parsed.data } };
  }
  const trimmed = email!.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(trimmed))
    throw new DevelopmentSetupRefusal("--first-owner-email must be an email address");
  return { firstOwner: { kind: "email", email: trimmed } };
};

/**
 * Refuses unless this is a local, non-production process bound to the Supabase CLI database on
 * loopback. Where the runtime database variables are unset it applies the documented local
 * defaults; any value that is set must already be local.
 */
export const requireLocalDevelopmentEnvironment = (
  environment: NodeJS.ProcessEnv,
): IdentityAuthorityId => {
  if (environment.NODE_ENV === "production")
    throw new DevelopmentSetupRefusal("The development setup never runs with NODE_ENV=production.");
  if (environment.VERCEL !== undefined || environment.CI === "true")
    throw new DevelopmentSetupRefusal("The development setup runs only on a developer machine.");
  if (environment.VORTEX_ENVIRONMENT !== undefined && environment.VORTEX_ENVIRONMENT !== "local")
    throw new DevelopmentSetupRefusal("VORTEX_ENVIRONMENT must be local.");
  environment.VORTEX_ENVIRONMENT = "local";
  environment.VORTEX_RUNTIME_DATABASE_URL ??= localRuntimeDatabaseUrl;

  let url: URL;
  try {
    url = new URL(environment.VORTEX_RUNTIME_DATABASE_URL);
  } catch {
    throw new DevelopmentSetupRefusal("VORTEX_RUNTIME_DATABASE_URL is not a valid URL.");
  }
  if (
    url.protocol !== "postgresql:" ||
    !isLoopbackHostname(url.hostname) ||
    url.port !== localDatabasePort
  )
    throw new DevelopmentSetupRefusal(
      `The database must be the Supabase CLI database on loopback port ${localDatabasePort}.`,
    );

  const authority = identityAuthorityIdSchema.safeParse(environment.VORTEX_IDENTITY_AUTHORITY_ID);
  if (!authority.success)
    throw new DevelopmentSetupRefusal(
      "VORTEX_IDENTITY_AUTHORITY_ID must be set to the same value the local web application uses.",
    );
  return authority.data;
};

type LocalSupabaseStatus = Readonly<{ API_URL: string; SECRET_KEY: string }>;

const readLocalSupabaseStatus = (): LocalSupabaseStatus => {
  const root = findRepositoryRoot();
  const binary = join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "supabase.cmd" : "supabase",
  );
  const result = spawnSync(`"${binary}" status --output json`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    cwd: root,
    shell: true,
  });
  try {
    const status = JSON.parse(result.stdout) as Record<string, unknown>;
    if (typeof status.API_URL === "string" && typeof status.SECRET_KEY === "string")
      return { API_URL: status.API_URL, SECRET_KEY: status.SECRET_KEY };
  } catch {
    // Reported below.
  }
  throw new DevelopmentSetupRefusal("The local Supabase stack is not running (pnpm db:start).");
};

/**
 * Resolves the one nominated account to its identity. An email is looked up once in the local
 * Supabase Auth user list; the account must already have signed up locally. The result is the
 * Supabase user id, the same identity the web application derives from a signed-in session.
 */
export const resolveFirstOwnerIdentity = async (
  nomination: FirstOwnerNomination,
): Promise<string> => {
  if (nomination.kind === "identity") return nomination.identityId;
  const status = readLocalSupabaseStatus();
  if (!isLoopbackHostname(new URL(status.API_URL).hostname))
    throw new DevelopmentSetupRefusal("The Supabase API is not on loopback.");
  const admin = createClient(status.API_URL, status.SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error !== null)
      throw new DevelopmentSetupRefusal("The local Auth user list is unavailable.");
    const match = data.users.find((user) => user.email?.toLowerCase() === nomination.email);
    if (match !== undefined) return identityIdSchema.parse(match.id);
    if (data.users.length < 200) break;
  }
  throw new DevelopmentSetupRefusal(
    "No local account has that email. Sign up in the local web application first, then re-run.",
  );
};
