import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "../auth/actions";
import { AuthShell } from "../auth/_components/auth-shell";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { loadOrganizationLauncher } from "../_lib/organization-context";

export const dynamic = "force-dynamic";

export default async function SignedInPage() {
  const result = await resolveIdentitySession();
  if (result.kind === "temporarily_unavailable")
    return (
      <AuthShell
        eyebrow="Organisation access"
        title="Organisations are temporarily unavailable"
        description="Your sign-in is still active. Try loading your organisations again."
      >
        <Link href="/signed-in">Try again</Link>
      </AuthShell>
    );
  if (result.kind === "invalid_session_state" || result.kind === "expired_or_revoked")
    redirect("/auth/session-ended");
  if (result.kind !== "active") redirect("/auth/sign-in?status=session-ended");

  const launcher = await loadOrganizationLauncher(result.session);
  if (launcher.kind === "temporarily_unavailable")
    return (
      <AuthShell
        eyebrow="Organisation access"
        title="Organisations are temporarily unavailable"
        description="Your sign-in is still active. Try loading your organisations again."
      >
        <Link href="/signed-in">Try again</Link>
      </AuthShell>
    );
  if (launcher.kind !== "available") redirect("/auth/session-ended");
  if (launcher.entries.length === 1)
    redirect(`/organizations/${launcher.entries[0]?.organizationId}`);

  return (
    <AuthShell
      eyebrow="Organisation access"
      title={
        launcher.entries.length === 0 ? "No organisations available" : "Choose an organisation"
      }
      description={
        launcher.entries.length === 0
          ? "You are signed in, but you do not currently have an active organisation account."
          : "Each browser tab keeps its selected organisation in the page address."
      }
    >
      {launcher.entries.length > 0 ? (
        <nav aria-label="Available organisations">
          <ul>
            {launcher.entries.map((entry) => (
              <li key={entry.organizationId}>
                <Link href={`/organizations/${entry.organizationId}`}>
                  {entry.organizationDisplayName} · {entry.tenantDisplayName}
                  {entry.accountDisplayName ? ` · ${entry.accountDisplayName}` : ""}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <form action={signOut} className="auth-form">
        <button type="submit">Sign out</button>
      </form>
    </AuthShell>
  );
}
