import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "../../auth/_components/auth-shell";
import { continueSessionOrEnd } from "../../auth/_lib/session-redirect";
import { resolveIdentitySession } from "../../auth/_lib/session-server";
import { loadSelectedOrganization } from "../../_lib/organization-context";

export const dynamic = "force-dynamic";

type OrganizationPageProps = Readonly<{
  params: Promise<{ organizationId: string }>;
}>;

export default async function OrganizationPage({ params }: OrganizationPageProps) {
  const identity = await continueSessionOrEnd(await resolveIdentitySession());
  if (identity.kind === "temporarily_unavailable")
    return (
      <AuthShell
        eyebrow="Organisation access"
        title="This organisation is temporarily unavailable"
        description="Your sign-in is still active. Try loading this page again."
      >
        <Link href="/signed-in">Choose an organisation</Link>
      </AuthShell>
    );

  const { organizationId } = await params;
  const selected = await loadSelectedOrganization(identity.session, organizationId);
  if (selected.kind === "temporarily_unavailable")
    return (
      <AuthShell
        eyebrow="Organisation access"
        title="This organisation is temporarily unavailable"
        description="Your sign-in is still active. Try loading this page again."
      >
        <Link href={`/organizations/${organizationId}`}>Try again</Link>
        <Link href="/signed-in">Choose an organisation</Link>
      </AuthShell>
    );
  if (selected.kind === "unavailable")
    return (
      <AuthShell
        eyebrow="Organisation access"
        title="Organisation unavailable"
        description="This organisation cannot be opened from your current sign-in."
      >
        <Link href="/signed-in">Choose an organisation</Link>
      </AuthShell>
    );
  if (selected.kind === "suspended_super_administrator_account")
    return (
      <AuthShell
        eyebrow="Organisation access"
        title="Your organisation account is suspended"
        description="This account needs explicit reactivation before it can be used. Signing in will not reactivate it."
      >
        <Link href="/signed-in">Choose another organisation</Link>
      </AuthShell>
    );

  redirect(
    `/${encodeURIComponent(selected.entry.tenantShortName)}/${encodeURIComponent(selected.entry.organizationShortName)}`,
  );
}
