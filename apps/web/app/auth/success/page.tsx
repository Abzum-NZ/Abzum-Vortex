import Link from "next/link";
import { Icon } from "@vortex/ui/icons";
import { AuthShell } from "../_components/auth-shell";

type SuccessPageProps = Readonly<{ searchParams: Promise<{ state?: string }> }>;

export default async function SuccessPage({ searchParams }: SuccessPageProps) {
  const { state } = await searchParams;
  const passwordUpdated = state === "password-updated";

  return (
    <AuthShell
      eyebrow="Complete"
      title={passwordUpdated ? "Password updated" : "Email confirmed"}
      description={
        passwordUpdated
          ? "Your new password is ready to use."
          : "Your email address has been confirmed. You can now sign in."
      }
      footer={
        <div className="text-center text-sm">
          <Link
            className="font-medium text-foreground underline underline-offset-4 hover:text-primary transition-colors"
            href="/auth/sign-in"
          >
            Continue to sign in
          </Link>
        </div>
      }
    >
      <div className="flex flex-col items-center justify-center py-2">
        <div
          className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary"
          aria-hidden="true"
        >
          <Icon name="check" className="size-7" />
        </div>
      </div>
    </AuthShell>
  );
}
