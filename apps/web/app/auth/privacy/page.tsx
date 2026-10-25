import Link from "next/link";
import { readPrivacyNotice } from "@vortex/platform/server";
import { identityIdSchema } from "@vortex/platform/schema";
import { AuthShell } from "../_components/auth-shell";

export default async function PrivacyPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ version?: string }>;
}>) {
  const { version } = await searchParams;
  const parsed = identityIdSchema.safeParse(version);
  const notice =
    version !== undefined && !parsed.success
      ? undefined
      : await readPrivacyNotice(parsed.success ? parsed.data : undefined).catch(() => undefined);
  return (
    <AuthShell
      eyebrow="Privacy"
      title={notice?.content.title ?? "Privacy Policy unavailable"}
      description={notice?.versionLabel ?? "Please try again shortly."}
      footer={
        <Link className="underline" href="/auth/register">
          Back to create account
        </Link>
      }
    >
      {notice?.content.paragraphs.map((paragraph, index) => (
        <p key={index} className="text-sm text-muted-foreground">
          {paragraph}
        </p>
      ))}
    </AuthShell>
  );
}
