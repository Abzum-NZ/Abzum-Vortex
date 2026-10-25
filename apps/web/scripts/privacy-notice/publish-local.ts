import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { signupPrivacyNoticeSetting } from "@vortex/definitions";
import { identityIdSchema } from "@vortex/platform/schema";

// This development-only command never chooses a lane or connects to a hosted project.
const lane = process.argv[2];
const publisher = identityIdSchema.parse(process.argv[3]);
if (lane === undefined || !/^(3|4|5|7|8)$/u.test(lane))
  throw new Error(
    "Pass the explicitly granted local lane and an active super-administrator identity.",
  );
const setting = signupPrivacyNoticeSetting;
const content = JSON.stringify(setting.content);
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sql = `select vortex_identity.publish_privacy_notice_version(
  ${quote(publisher)}::uuid, ${quote(setting.versionLabel)},
  ${quote(setting.effectiveAt)}::timestamptz, ${quote(content)}::jsonb,
  ${quote(createHash("sha256").update(content).digest("hex"))}
);`;
const result = spawnSync(
  "docker",
  [
    "exec",
    "-i",
    `supabase_db_vortex-db${lane}`,
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
  ],
  {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  },
);
if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
