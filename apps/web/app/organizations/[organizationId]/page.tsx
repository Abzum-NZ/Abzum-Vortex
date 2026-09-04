import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "../../auth/actions";
import { AuthShell } from "../../auth/_components/auth-shell";
import { resolveIdentitySession } from "../../auth/_lib/session-server";
import { loadSelectedOrganization } from "../../_lib/organization-context";

export const dynamic = "force-dynamic";

type OrganizationPageProps = Readonly<{
  params: Promise<{ organizationId: string }>;
}>;

export default async function OrganizationPage({ params }: OrganizationPageProps) {
  const identity = await resolveIdentitySession();
  if (identity.kind === "invalid_session_state" || identity.kind === "expired_or_revoked")
    redirect("/auth/session-ended");
  if (identity.kind === "missing" || identity.kind === "cluster_identity_inactive")
    redirect("/auth/sign-in?status=session-ended");
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

  return (
    <AuthShell
      eyebrow={selected.entry.tenantDisplayName}
      title={selected.entry.organizationDisplayName}
      description={
        selected.entry.accountDisplayName
          ? `Signed in as ${selected.entry.accountDisplayName}.`
          : "Your organisation context is active for this tab."
      }
    >
      <Link href="/signed-in">Switch organisation</Link>
      <form action={signOut} className="auth-form">
        <button type="submit">Sign out</button>
      </form>
    </AuthShell>
  );
}
