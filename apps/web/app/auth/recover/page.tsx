import Link from "next/link";
import { Field } from "@vortex/ui/components/field";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { AuthShell } from "../_components/auth-shell";
import { StatusMessage } from "../_components/status-message";
import { SubmitButton } from "../_components/submit-button";
import { requestRecovery } from "../actions";

type RecoverPageProps = Readonly<{ searchParams: Promise<{ status?: string }> }>;

export default async function RecoverPage({ searchParams }: RecoverPageProps) {
  const { status } = await searchParams;

  return (
    <AuthShell
      eyebrow="Password recovery"
      title="Reset your password"
      description="Enter your email address. If it is connected to an account, a recovery link will be sent."
      footer={
        <Link className="font-medium underline underline-offset-4" href="/auth/sign-in">
          Return to sign in
        </Link>
      }
    >
      <StatusMessage status={status} />
      <form className="flex flex-col gap-5" action={requestRecovery}>
        <Field>
          <Label htmlFor="email">Email address</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <SubmitButton pendingLabel="Requesting link…">Send recovery link</SubmitButton>
      </form>
    </AuthShell>
  );
}
