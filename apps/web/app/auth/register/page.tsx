import Link from "next/link";
import { Field } from "@vortex/ui/components/field";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { AuthShell } from "../_components/auth-shell";
import { StatusMessage } from "../_components/status-message";
import { SubmitButton } from "../_components/submit-button";
import { register } from "../actions";

type RegisterPageProps = Readonly<{ searchParams: Promise<{ status?: string }> }>;

export default async function RegisterPage({ searchParams }: RegisterPageProps) {
  const { status } = await searchParams;

  return (
    <AuthShell
      eyebrow="Create account"
      title="Start with your email"
      description="Use an email address you can verify. You will receive a confirmation link before you can sign in."
      footer={
        <p>
          Already have an account?{" "}
          <Link className="font-medium underline underline-offset-4" href="/auth/sign-in">
            Sign in
          </Link>
        </p>
      }
    >
      <StatusMessage status={status} />
      <form className="flex flex-col gap-5" action={register}>
        <Field>
          <Label htmlFor="email">Email address</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            pattern="(?=.*[A-Za-z])(?=.*\d).{8,1024}"
            required
          />
          <p className="text-sm text-muted-foreground">
            Use at least 8 characters, including a letter and a number.
          </p>
        </Field>
        <SubmitButton pendingLabel="Creating account…">Create account</SubmitButton>
      </form>
    </AuthShell>
  );
}
