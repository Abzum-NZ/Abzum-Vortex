import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(import.meta.dirname, "../..");
const keyPath = path.join(workspaceRoot, "supabase", ".temp", "signing-keys.json");
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

export const ensureLocalSigningKey = async () => {
  await mkdir(path.dirname(keyPath), { recursive: true });

  try {
    await access(keyPath, constants.R_OK);
    validateKeySet(await readFile(keyPath, "utf8"));
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const generated = generateKey();
  try {
    await writeFile(keyPath, generated, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  validateKeySet(await readFile(keyPath, "utf8"));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await ensureLocalSigningKey();
  process.stdout.write(
    "Local Supabase ES256 signing key is ready in the ignored .temp directory.\n",
  );
}
