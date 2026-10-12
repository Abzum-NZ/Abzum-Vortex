import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { identityIdSchema } from "@vortex/platform/schema";
import { findRepositoryRoot } from "../development-setup/state";
import { loadLocalWebEnvironment } from "./local-environment";

type LocalSupabaseStatus = Readonly<{ API_URL: string; SECRET_KEY: string }>;

const localSupabaseStatus = (): LocalSupabaseStatus => {
  const root = findRepositoryRoot();
  const cli = join(root, "node_modules", "supabase", "dist", "supabase.js");
  const result = spawnSync(process.execPath, [cli, "status", "--output", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    cwd: root,
  });
  try {
    const status = JSON.parse(result.stdout) as Record<string, unknown>;
    if (
      result.status === 0 &&
      typeof status.API_URL === "string" &&
      typeof status.SECRET_KEY === "string"
    )
      return { API_URL: status.API_URL, SECRET_KEY: status.SECRET_KEY };
  } catch {
    // Report one safe setup error below without echoing Supabase's environment output.
  }
  throw new Error("The local Supabase stack is not running (pnpm db:start).");
};

export const validateDemoOwnerConfiguration = (): Readonly<{ email: string; password: string }> => {
  const email = process.env.VORTEX_DEMO_OWNER_EMAIL?.trim().toLowerCase();
  const password = process.env.VORTEX_DEMO_OWNER_PASSWORD;
  if (email === undefined || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Set VORTEX_DEMO_OWNER_EMAIL to the local demo account email.");
  if (
    password === undefined ||
    password.length < 12 ||
    password.length > 1_024 ||
    !/[A-Za-z]/u.test(password) ||
    !/\d/u.test(password)
  )
    throw new Error(
      "Set VORTEX_DEMO_OWNER_PASSWORD to a local-only password with at least 12 characters, including a letter and a number.",
    );
  return { email, password };
};

/** Ensures a confirmed password account exists, without changing an existing account. */
export const ensureLocalDemoOwner = async (): Promise<string> => {
  const { email, password } = validateDemoOwnerConfiguration();
  const status = localSupabaseStatus();
  const apiUrl = new URL(status.API_URL);
  if (apiUrl.protocol !== "http:" || apiUrl.hostname !== "127.0.0.1" || apiUrl.port !== "54321")
    throw new Error("The local Supabase Auth endpoint must be http://127.0.0.1:54321.");
  const admin = createClient(status.API_URL, status.SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const findExistingIdentity = async (): Promise<string | undefined> => {
    for (let page = 1; page <= 50; page += 1) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error !== null)
        throw new Error(`Local Auth user lookup failed (${error.status ?? "unknown"}).`);
      const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
      if (user !== undefined) return identityIdSchema.parse(user.id);
      if (data.users.length < 200) return undefined;
    }
    throw new Error("Local Auth user lookup exceeded its page limit.");
  };
  const existing = await findExistingIdentity();
  if (existing !== undefined) return existing;

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Local Demo Owner" },
  });
  if (error === null && data.user !== null) return identityIdSchema.parse(data.user.id);
  if (error?.code === "email_exists") {
    const createdByAnotherRun = await findExistingIdentity();
    if (createdByAnotherRun !== undefined) return createdByAnotherRun;
  }
  throw new Error(`Local demo account creation failed (${error?.code ?? "unknown"}).`);
};

const main = async (): Promise<void> => {
  try {
    loadLocalWebEnvironment();
    const identityId = await ensureLocalDemoOwner();
    process.stdout.write(`[demo owner] local account is ready (${identityId}).\n`);
  } catch (error) {
    process.stderr.write(
      `[demo owner] failed: ${error instanceof Error ? error.message : "unexpected error"}\n`,
    );
    process.exitCode = 1;
  }
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void main();
