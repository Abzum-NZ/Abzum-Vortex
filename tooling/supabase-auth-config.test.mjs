import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { describe, expect, test } from "vitest";

const configPath = new URL("../supabase/config.toml", import.meta.url);

function assignments(source) {
  const values = new Map();
  let section = "";

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line) continue;

    const sectionMatch = /^\[([^\]]+)]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }

    const assignmentMatch = /^([a-zA-Z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (assignmentMatch) values.set(`${section}.${assignmentMatch[1]}`, assignmentMatch[2].trim());
  }

  return values;
}

describe("Local Supabase Auth configuration", () => {
  test("keeps the first-release identity methods explicit and fail closed", async () => {
    const values = assignments(await readFile(configPath, "utf8"));

    expect(values.get("auth.enabled")).toBe("true");
    expect(values.get("auth.site_url")).toBe('"http://127.0.0.1:3000"');
    expect(values.get("auth.additional_redirect_urls")).toBe('["http://127.0.0.1:3000"]');
    expect(values.get("auth.jwt_expiry")).toBe("3600");
    expect(values.get("auth.signing_keys_path")).toBe('"./.temp/signing-keys.json"');
    expect(values.get("auth.enable_refresh_token_rotation")).toBe("true");
    expect(values.get("auth.enable_anonymous_sign_ins")).toBe("false");
    expect(values.get("auth.enable_manual_linking")).toBe("false");
    expect(values.get("auth.passkey.enabled")).toBe("false");
    expect(values.get("auth.email.enable_signup")).toBe("true");
    expect(values.get("auth.email.enable_confirmations")).toBe("true");
    expect(values.get("auth.email.double_confirm_changes")).toBe("true");
    expect(values.get("auth.sms.enable_signup")).toBe("false");
    expect(values.get("auth.sms.enable_confirmations")).toBe("false");
    expect(values.get("auth.web3.solana.enabled")).toBe("false");
    expect(values.get("auth.oauth_server.enabled")).toBe("false");
    expect(values.get("auth.mfa.totp.enroll_enabled")).toBe("false");
    expect(values.get("auth.mfa.totp.verify_enabled")).toBe("false");
    expect(values.get("auth.mfa.phone.enroll_enabled")).toBe("false");
    expect(values.get("auth.mfa.phone.verify_enabled")).toBe("false");

    const enabledExternalProviders = [...values.entries()].filter(
      ([key, value]) =>
        key.startsWith("auth.external.") && key.endsWith(".enabled") && value === "true",
    );
    const enabledThirdPartyProviders = [...values.entries()].filter(
      ([key, value]) =>
        key.startsWith("auth.third_party.") && key.endsWith(".enabled") && value === "true",
    );
    const enabledCustomAccessTokenHook = [...values.entries()].filter(
      ([key, value]) => key === "auth.hook.custom_access_token.enabled" && value === "true",
    );

    expect(enabledExternalProviders).toEqual([]);
    expect(enabledThirdPartyProviders).toEqual([]);
    expect(enabledCustomAccessTokenHook).toEqual([]);
  });

  test("captures Local identity email without an external sender", async () => {
    const values = assignments(await readFile(configPath, "utf8"));

    expect(values.get("local_smtp.enabled")).toBe("true");
    expect(values.get("local_smtp.port")).toBe("54324");
    expect(values.get("local_smtp.admin_email")).toBe('"local-auth@example.invalid"');
    expect(values.get("local_smtp.sender_name")).toBe('"Vortex Local"');
    expect(values.get("auth.email.smtp.enabled")).not.toBe("true");
  });
});
