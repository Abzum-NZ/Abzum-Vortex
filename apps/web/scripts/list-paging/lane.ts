import { createRequire } from "node:module";
import { join } from "node:path";
import { findRepositoryRoot, loadCurrentSetupState } from "../development-setup/state";
import { loadLocalWebEnvironment } from "../demo-setup/local-environment";

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
  const runtimePort = new URL(process.env.VORTEX_RUNTIME_DATABASE_URL ?? "").port;
  if (Number(runtimePort) !== databasePort)
    throw new Error(
      `VORTEX_RUNTIME_DATABASE_URL uses port ${runtimePort}, not lane ${lane} (${databasePort}). Run lane.mjs env ${lane}.`,
    );
  const state = loadCurrentSetupState();
  if (!state.setupCompleted) throw new Error("Run pnpm demo:setup on this lane first.");
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

export const personaEmails = {
  owner: () => process.env.VORTEX_DEMO_OWNER_EMAIL ?? "",
  member: () => (process.env.VORTEX_DEMO_OWNER_EMAIL ?? "").replace("@", "-agent@"),
  viewer: () => (process.env.VORTEX_DEMO_OWNER_EMAIL ?? "").replace("@", "-viewer@"),
} as const;
