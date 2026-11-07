// Runs after a successful `supabase db reset` on the main checkout: the reset database no longer
// holds the organisations the recorded setup state points at, so the state goes with it. Database
// lanes clear their own state in `lane.mjs reset`.
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

await rm(path.join(workspaceRoot, "supabase", ".temp", "development-setup-state.json"), {
  force: true,
});
