import { AuthForm, AuthTextField } from "./auth-form";
import { SubmitButton } from "./submit-button";
import { confirmEmail } from "../actions";

export function ConfirmEmailForm() {
  return (
    <AuthForm action={confirmEmail}>
      <AuthTextField
        id="email"
        name="email"
        label="Email address"
        type="email"
        autoComplete="email"
        missing="Enter your email address."
        invalid="Enter an email address like name@example.com."
      />
      <AuthTextField
        id="token"
        name="token"
        label="Six-digit confirmation code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        missing="Enter the six-digit code."
        invalid="The code is six digits, with no spaces."
      />

      <SubmitButton pendingLabel="Confirming email…">Confirm email address</SubmitButton>
    </AuthForm>
  );
}
