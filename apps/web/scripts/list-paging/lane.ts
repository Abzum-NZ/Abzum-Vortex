import { spawnSync } from "node:child_process";
import { isLoopbackHostname } from "@vortex/platform/schema";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { findRepositoryRoot, loadCurrentSetupState } from "../development-setup/state";
import { loadLocalWebEnvironment } from "../demo-setup/local-environment";
import { DevelopmentSetupRefusal, isLocalSupabaseApiUrl } from "../development-setup/guards";

/**
 * What the list-paging scripts share: a guarded connection to one database lane and the facts of
 * the organisation that local setup created there. They never reach the main stack (port 54322).
 */

const requireFromPlatform = createRequire(
  join(findRepositoryRoot(), "packages", "platform", "package.json"),
);
type Row = Readonly<Record<string, unknown>>;
/** The part of the postgres.js client these scripts use; the package is a dependency of platform only. */
export interface Sql {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<Row[]>;
  begin<Result>(operation: (transaction: Sql) => Promise<Result>): Promise<Result>;
  unsafe(query: string): Promise<Row[]>;
  end(): Promise<void>;
}
export type OpenSql = (
  url: string,
  options: { max: number; onnotice: (notice: { message?: string }) => void },
) => Sql;
export const postgres = requireFromPlatform("postgres") as OpenSql;

export type LaneFacts = Readonly<{
  lane: number;
  databasePort: number;
  administration: Sql;
  organizationId: string;
  tenantShortName: string;
  organizationShortName: string;
  stewardIdentityId: string;
  identityAuthorityId: string;
}>;

export const argumentValue = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};

export const openLane = (): LaneFacts => {
  loadLocalWebEnvironment();
  const lane = Number(argumentValue("lane"));
  if (![2, 3, 4, 5, 7, 8, 9].includes(lane))
    throw new Error("Pass --lane 2, 3, 4, 5, 7, 8 or 9. The main stack is never used.");
  const databasePort = 54322 + 1000 * (lane - 1);
  const runtime = new URL(process.env.VORTEX_RUNTIME_DATABASE_URL ?? "");
  if (runtime.protocol !== "postgresql:" || !isLoopbackHostname(runtime.hostname))
    throw new Error("The lane database must use PostgreSQL on loopback.");
  const runtimePort = runtime.port;
  if (Number(runtimePort) !== databasePort)
    throw new Error(
      `VORTEX_RUNTIME_DATABASE_URL uses port ${runtimePort}, not lane ${lane} (${databasePort}). Run lane.mjs env ${lane}.`,
    );
  validateLaneAuth(lane);
  const state = loadCurrentSetupState();
  if (!state.setupCompleted)
    throw new DevelopmentSetupRefusal(
      "No completed local setup state. Verify lane ownership and retained-data disposition with the coordinator; use non-reset provisioning (pnpm demo:owner, then pnpm setup:local -- --local-development --first-owner-identity-id <uuid>, without --seed-demo). Never reset or run demo:setup to repair this state.",
    );
  const identityAuthorityId = process.env.VORTEX_IDENTITY_AUTHORITY_ID;
  if (identityAuthorityId === undefined)
    throw new Error("VORTEX_IDENTITY_AUTHORITY_ID is not set.");
  return {
    lane,
    databasePort,
    administration: postgres(`postgresql://postgres:postgres@127.0.0.1:${databasePort}/postgres`, {
      max: 2,
      onnotice: () => {},
    }),
    organizationId: state.organizationId,
    tenantShortName: state.metadata.tenantShortName,
    organizationShortName: state.metadata.organizationShortName,
    stewardIdentityId: state.metadata.stewardIdentityId,
    identityAuthorityId,
  };
};

/**
 * The lane's own Supabase API endpoint for admin Auth calls: VORTEX_SUPABASE_URL must be the
 * loopback API port of the selected lane, so a stale value for the main stack or another lane is
 * refused before any account is touched.
 */
export const laneAuthEndpoint = (lane: number): string => {
  const configured = process.env.VORTEX_SUPABASE_URL;
  if (configured === undefined)
    throw new Error(`VORTEX_SUPABASE_URL is not set. Run lane.mjs env ${lane}.`);
  const apiPort = 54321 + 1000 * (lane - 1);
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("VORTEX_SUPABASE_URL is not a valid URL.");
  }
  if (!isLocalSupabaseApiUrl(url) || Number(url.port) !== apiPort)
    throw new Error(
      `VORTEX_SUPABASE_URL uses ${url.host}, not lane ${lane} (127.0.0.1:${apiPort}). Run lane.mjs env ${lane}.`,
    );
  return configured;
};

/** Compare credentials to the selected running stack without printing any secret. */
const validateLaneAuth = (lane: number): void => {
  const endpoint = new URL(laneAuthEndpoint(lane));
  const key = process.env.VORTEX_DEV_SERVICE_ROLE_KEY;
  if (key === undefined || key.length === 0)
    throw new Error(`The lane service key is missing. Run lane.mjs env ${lane}.`);
  const workdir = resolve(process.env.VORTEX_LANES_ROOT ?? "A:/Apps/vortex-lanes", `db${lane}`);
  const result = spawnSync(
    process.execPath,
    [
      join(findRepositoryRoot(), "node_modules", "supabase", "dist", "supabase.js"),
      "status",
      "--output",
      "json",
      "--workdir",
      workdir,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0)
    throw new Error(`Cannot inspect lane ${lane}. Start the selected lane before provisioning.`);
  let status: Record<string, unknown>;
  try {
    status = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`Lane ${lane} status is not valid JSON.`);
  }
  if (typeof status.API_URL !== "string" || typeof status.SECRET_KEY !== "string")
    throw new Error(`Lane ${lane} status has no API URL or service key.`);
  const actual = new URL(status.API_URL);
  if (!isLocalSupabaseApiUrl(actual) || actual.port !== endpoint.port || key !== status.SECRET_KEY)
    throw new Error(
      `The Supabase API or service key does not match lane ${lane}. Run lane.mjs env ${lane}.`,
    );
};

export const personaEmails = {
  owner: () => process.env.VORTEX_DEMO_OWNER_EMAIL ?? "",
  member: () => (process.env.VORTEX_DEMO_OWNER_EMAIL ?? "").replace("@", "-agent@"),
  viewer: () => (process.env.VORTEX_DEMO_OWNER_EMAIL ?? "").replace("@", "-viewer@"),
} as const;
