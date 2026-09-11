import { resolve } from "node:path";
import { cleanVerificationDatabases } from "./local-verification-database.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");

if (import.meta.main) {
  try {
    cleanVerificationDatabases({ root: workspaceRoot });
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
