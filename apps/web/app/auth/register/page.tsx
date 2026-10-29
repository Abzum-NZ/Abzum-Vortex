import Link from "next/link";
import { newPasswordPolicy, readPrivacyNotice } from "@vortex/platform/server";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Field, FieldDescription } from "@vortex/ui/components/field";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { AuthShell } from "../_components/auth-shell";
import { StatusMessage } from "../_components/status-message";
import { SubmitButton } from "../_components/submit-button";
import { register } from "../actions";

type RegisterPageProps = Readonly<{ searchParams: Promise<{ status?: string }> }>;

export default async function RegisterPage({ searchParams }: RegisterPageProps) {
  const { status } = await searchParams;
  // No notice in effect means registration is not open; any other failure reaches the error page.
  const notice = await readPrivacyNotice();

  return (
    <AuthShell
      eyebrow="Create account"
      title="Start with your email"
      description="Use an email address you can verify. You will receive a one-time confirmation code before you can sign in."
      footer={
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            className="font-medium text-foreground underline underline-offset-4 hover:text-primary transition-colors"
            href="/auth/sign-in"
          >
            Sign in
          </Link>
        </p>
      }
    >
      <StatusMessage status={notice === undefined ? "registration_closed" : status} />
      {notice !== undefined && (
        <form className="flex flex-col gap-5" action={register}>
          <p className="text-sm text-muted-foreground">
            {notice.content.collectionNotice}{" "}
            <Link className="underline underline-offset-4" href={notice.locator}>
              Privacy Policy
            </Link>
          </p>
          <input type="hidden" name="notice_version_id" value={notice.id} />
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
              minLength={newPasswordPolicy.minimumLength}
              pattern={newPasswordPolicy.pattern}
              required
            />
            <FieldDescription>{newPasswordPolicy.description}</FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="privacy-notice" name="privacy_notice_acknowledged" required />
            <Label htmlFor="privacy-notice">I acknowledge the Privacy Policy.</Label>
          </Field>
          <SubmitButton pendingLabel="Creating account…">Create account</SubmitButton>
        </form>
      )}
    </AuthShell>
  );
}
