import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(import.meta.dirname, "../..");
const localKeyPath = path.join(workspaceRoot, "supabase", ".temp", "signing-keys.json");
const cliPath = path.join(workspaceRoot, "node_modules", "supabase", "dist", "supabase.js");

const parseKey = (source) => {
  let key;
  try {
    key = JSON.parse(source);
  } catch {
    throw new Error("The Local Supabase signing-key file is not valid JSON");
  }

  if (
    typeof key !== "object" ||
    key === null ||
    key.alg !== "ES256" ||
    key.kty !== "EC" ||
    key.crv !== "P-256" ||
    typeof key.kid !== "string" ||
    key.kid.length === 0 ||
    typeof key.d !== "string" ||
    key.d.length === 0
  )
    throw new Error("The Local Supabase signing key must be one private P-256 ES256 JWK");
  return key;
};

const validateKeySet = (source) => {
  let keys;
  try {
    keys = JSON.parse(source);
  } catch {
    throw new Error("The Local Supabase signing-key file is not valid JSON");
  }
  if (!Array.isArray(keys) || keys.length !== 1)
    throw new Error("The Local Supabase signing-key file must contain one JWK");
  parseKey(JSON.stringify(keys[0]));
};

const readValidKeySet = async (candidatePath) => {
  try {
    await access(candidatePath, constants.R_OK);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  const source = await readFile(candidatePath, "utf8");
  validateKeySet(source);
  return source;
};

const generateKey = () => {
  const generated = spawnSync(
    process.execPath,
    [cliPath, "gen", "signing-key", "--algorithm", "ES256"],
    {
      cwd: os.tmpdir(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (generated.status !== 0 || typeof generated.stdout !== "string")
    throw new Error("The pinned Supabase CLI could not generate the Local ES256 signing key");
  const key = parseKey(generated.stdout);
  return `${JSON.stringify([key], null, 2)}\n`;
};

/**
 * Resolves the one signing-key file shared by every worktree of this Git checkout. The Local
 * Supabase stack is shared across worktrees, so every worktree must start Auth with the same key
 * id; the canonical copy lives in the main checkout's ignored `supabase/.temp` directory. Returns
 * `undefined` when this is the main checkout itself, or when Git is unavailable, so the caller
 * falls back to the worktree-local file.
 */
const resolveSharedKeyPath = () => {
  const result = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  const commonDirectory = result.stdout.trim();
  if (commonDirectory.length === 0) return undefined;
  const mainCheckout = path.dirname(path.resolve(commonDirectory));
  if (path.resolve(mainCheckout) === workspaceRoot) return undefined;
  return path.join(mainCheckout, "supabase", ".temp", "signing-keys.json");
};

/**
 * Ensures the canonical file holds a valid key set. An existing valid file always wins, so a key
 * another worktree created first is adopted instead of rotated; otherwise the candidate is written
 * with an exclusive create so concurrent worktrees cannot both write. The key set actually stored
 * is returned.
 */
const ensureSharedKeySet = async (canonicalPath, candidate) => {
  await mkdir(path.dirname(canonicalPath), { recursive: true });
  const existing = await readValidKeySet(canonicalPath);
  if (existing !== undefined) return existing;
  try {
    await writeFile(canonicalPath, candidate, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stored = await readValidKeySet(canonicalPath);
  if (stored === undefined)
    throw new Error("The shared Local Supabase signing-key file could not be created");
  return stored;
};

/**
 * Prepares the Local Supabase ES256 signing key so it is generated once and reused across
 * worktrees and database resets. The shared copy is resolved from the main checkout and copied into
 * this worktree's `supabase/.temp` file that `supabase/config.toml` reads, so a reset in any
 * worktree keeps the same key id. The key is never committed.
 */
export const ensureLocalSigningKey = async () => {
  const sharedKeyPath = resolveSharedKeyPath();
  const localKeySet = await readValidKeySet(localKeyPath);
  const sharedKeySet =
    sharedKeyPath === undefined ? undefined : await readValidKeySet(sharedKeyPath);

  let keySet = sharedKeySet ?? localKeySet;
  if (keySet === undefined) keySet = generateKey();

  if (sharedKeyPath !== undefined)
    keySet = await ensureSharedKeySet(sharedKeyPath, keySet);

  if (localKeySet !== keySet) {
    await mkdir(path.dirname(localKeyPath), { recursive: true });
    await writeFile(localKeyPath, keySet, { encoding: "utf8", mode: 0o600 });
  }
  validateKeySet(await readFile(localKeyPath, "utf8"));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await ensureLocalSigningKey();
  process.stdout.write(
    "Local Supabase ES256 signing key is ready and shared across this checkout's worktrees in the ignored .temp directory.\n",
  );
}
