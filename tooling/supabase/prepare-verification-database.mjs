import { spawnSync } from "node:child_process";

// The disposable verification database starts from the plain Supabase Postgres
// image, which creates the empty `auth` and `storage` schemas but none of their
// tables: the Auth and Storage services own those in the shared stack and apply
// their own migrations. The Vortex migrations read `storage.buckets`,
// `storage.objects`, `auth.jwt()` and `auth.sessions`, so without those
// definitions the replay fails before it reaches the change under review.
//
// Replaying each service's own migrations, from the images pinned by the
// `supabase` CLI version this workspace installs (`supabase` 2.117.0, see
// pnpm-workspace.yaml), gives the disposable database the real Supabase
// definitions rather than hand-written stubs. See docs/build-plan issue #1321.
export const verificationStorageImage = "public.ecr.aws/supabase/storage-api:v1.72.1";
export const verificationAuthImage = "public.ecr.aws/supabase/gotrue:v2.196.0";
export const verificationRealtimeImage = "public.ecr.aws/supabase/realtime:v2.130.0";

// Each one-shot service container shares the verification cluster's network
// namespace, so it reaches the cluster over loopback, where the cluster's
// `pg_hba.conf` trusts 127.0.0.1. That keeps the cluster's random password out
// of the service containers and needs no extra credentials.
const containerNetwork = (containerName) => `container:${containerName}`;

const serviceDatabaseUrl = (role) =>
  `postgresql://${role}@127.0.0.1:5432/postgres?sslmode=disable`;

const writeAndCheck = (result, label, stdout, stderr) => {
  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${label} failed to apply to the disposable verification database (exit ${result.status})`,
    );
};

const runStorageMigrations = ({ containerName, jwtSecret, spawn, stdout, stderr }) => {
  const result = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      containerNetwork(containerName),
      "--entrypoint",
      "node",
      "-e",
      `DATABASE_URL=${serviceDatabaseUrl("supabase_storage_admin")}`,
      "-e",
      `PGRST_JWT_SECRET=${jwtSecret}`,
      verificationStorageImage,
      "/app/dist/scripts/migrate-call.js",
    ],
    { encoding: "utf8" },
  );
  writeAndCheck(result, "Supabase Storage migrations", stdout, stderr);
};

const runAuthMigrations = ({ containerName, jwtSecret, spawn, stdout, stderr }) => {
  const result = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      containerNetwork(containerName),
      "--entrypoint",
      "auth",
      "-e",
      "API_EXTERNAL_URL=http://127.0.0.1",
      "-e",
      "GOTRUE_SITE_URL=http://127.0.0.1",
      "-e",
      "GOTRUE_DISABLE_SIGNUP=true",
      "-e",
      `GOTRUE_JWT_SECRET=${jwtSecret}`,
      "-e",
      "GOTRUE_JWT_EXP=3600",
      "-e",
      "GOTRUE_JWT_AUD=authenticated",
      "-e",
      "GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated",
      "-e",
      "GOTRUE_DB_DRIVER=postgres",
      "-e",
      `GOTRUE_DB_DATABASE_URL=${serviceDatabaseUrl("supabase_auth_admin")}`,
      "-e",
      "GOTRUE_DB_MIGRATIONS_PATH=/usr/local/etc/auth/migrations",
      verificationAuthImage,
      "migrate",
    ],
    { encoding: "utf8" },
  );
  writeAndCheck(result, "Supabase Auth migrations", stdout, stderr);
};

// Realtime applies this exact tenant schema dump on startup, so replaying the
// pinned dump gives the disposable database `realtime.messages`,
// `realtime.send`, `realtime.topic` and the rest of the Realtime schema. The
// dump is read from the pinned image and piped into the cluster's own `psql`
// (the Realtime image ships no client), so no file has to be written to disk.
const runRealtimeSchema = ({ containerName, postgresImage, spawn, stdout, stderr }) => {
  const dump = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      verificationRealtimeImage,
      "-c",
      "cat /app/lib/realtime-*/priv/repo/tenant_db_dump_17.sql",
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (dump.error) throw dump.error;
  if (dump.status !== 0)
    throw new Error(
      `Reading the pinned Supabase Realtime tenant schema dump failed (exit ${dump.status})`,
    );

  const apply = spawn(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--network",
      containerNetwork(containerName),
      "--entrypoint",
      "psql",
      postgresImage,
      "-h",
      "127.0.0.1",
      "-p",
      "5432",
      "-U",
      "supabase_admin",
      "-d",
      "postgres",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      "-",
    ],
    { encoding: "utf8", input: dump.stdout, maxBuffer: 32 * 1024 * 1024 },
  );
  writeAndCheck(apply, "Supabase Realtime schema", stdout, stderr);
};

/**
 * Prepares a freshly started disposable verification cluster with the Supabase
 * schemas the Vortex migrations depend on but the plain Postgres image lacks:
 * the Storage tables first (`storage.buckets`, `storage.objects` and their
 * functions), then the Auth tables and helpers (`auth.jwt()`, `auth.sessions`
 * and the rest of the pinned GoTrue migrations), then the Realtime schema
 * (`realtime.messages`, `realtime.send`, `realtime.topic`). Throws on the first
 * service migration error, so the replay never proceeds on a half-prepared
 * database.
 */
export const prepareVerificationDatabase = ({
  containerName,
  jwtSecret,
  postgresImage,
  spawn = spawnSync,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) => {
  if (!containerName)
    throw new Error("prepareVerificationDatabase needs the verification container name");
  if (!jwtSecret)
    throw new Error("prepareVerificationDatabase needs the verification cluster JWT secret");
  if (!postgresImage)
    throw new Error("prepareVerificationDatabase needs the pinned verification Postgres image");

  runStorageMigrations({ containerName, jwtSecret, spawn, stdout, stderr });
  runAuthMigrations({ containerName, jwtSecret, spawn, stdout, stderr });
  runRealtimeSchema({ containerName, postgresImage, spawn, stdout, stderr });
};
