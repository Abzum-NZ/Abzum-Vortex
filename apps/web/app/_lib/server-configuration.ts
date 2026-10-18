import "server-only";

import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  resolveFileStorageDestination,
  type FileStorageDestination,
} from "@vortex/platform/server";

export const optionalEnvironmentValue = (name: string): string | undefined => process.env[name];

export const requiredEnvironmentValue = (name: string): string => {
  const value = optionalEnvironmentValue(name);
  if (!value || value.trim().length === 0)
    throw new Error(`Missing required server configuration: ${name}`);
  return value;
};

/** The one hosted Storage destination and signing configuration for file and component reads. */
export const hostedStorageSigningConfiguration = (supabaseUrl: string, service: string) => {
  const destination = new URL(supabaseUrl);
  if (
    destination.protocol !== "https:" ||
    destination.username !== "" ||
    destination.password !== "" ||
    destination.port !== "" ||
    destination.pathname !== "/" ||
    destination.search !== "" ||
    destination.hash !== ""
  )
    throw new Error(`${service} requires an HTTPS hosted Supabase root origin`);
  const match = /^([a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?)\.supabase\.co$/.exec(
    destination.hostname,
  );
  if (match === null || match[1] === undefined)
    throw new Error(`${service} requires a hosted Supabase destination project`);
  const destinationProject = match[1];
  return {
    destinationProject,
    issuer: `https://${destinationProject}.supabase.co/auth/v1`,
    keyId: requiredEnvironmentValue("VORTEX_FILE_STORAGE_SIGNING_KEY_ID"),
    privateKey: requiredEnvironmentValue("VORTEX_FILE_STORAGE_SIGNING_KEY").replace(/\\n/g, "\n"),
  };
};

/** Files use the lane's existing ES256 key only in the explicitly local environment. */
export const fileStorageSigningConfiguration = (supabaseUrl: string) => {
  const environment = requiredEnvironmentValue("VORTEX_ENVIRONMENT");
  if (environment !== "local" && environment !== "testing" && environment !== "production")
    throw new Error("FILE_STORAGE_ENVIRONMENT_INVALID");
  const destination: FileStorageDestination = { environment, supabaseUrl };
  resolveFileStorageDestination(destination);
  if (environment !== "local") {
    const hosted = hostedStorageSigningConfiguration(supabaseUrl, "File Storage");
    return { destination, keyId: hosted.keyId, privateKey: hosted.privateKey };
  }
  const workdir = requiredEnvironmentValue("VORTEX_SUPABASE_WORKDIR");
  let keys: unknown;
  const source = readFileSync(path.join(workdir, "supabase/.temp/signing-keys.json"), "utf8");
  try {
    keys = JSON.parse(source);
  } catch {
    // JSON parse messages can contain fragments of the private key file.
    throw new Error("FILE_STORAGE_LOCAL_SIGNING_KEYS_INVALID_JSON");
  }
  if (!Array.isArray(keys) || keys.length !== 1)
    throw new Error("FILE_STORAGE_LOCAL_SIGNING_KEYS_INVALID");
  const key = keys[0] as Record<string, unknown>;
  if (
    key?.alg !== "ES256" ||
    key.kty !== "EC" ||
    key.crv !== "P-256" ||
    typeof key.kid !== "string" ||
    typeof key.d !== "string"
  )
    throw new Error("FILE_STORAGE_LOCAL_SIGNING_KEY_INVALID");
  return {
    destination,
    keyId: key.kid,
    privateKey: createPrivateKey({ key, format: "jwk" })
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
  };
};
