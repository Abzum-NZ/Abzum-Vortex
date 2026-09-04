type StatusMessageProps = Readonly<{
  status?: string | undefined;
}>;

const messages: Readonly<Record<string, string>> = {
  invalid: "Check the details and try again.",
  invalid_credentials: "The email address or password was not accepted.",
  invalid_link: "This link is invalid or has expired. Request a new one and try again.",
  unavailable: "Sign-in is temporarily unavailable. Please try again shortly.",
};

export function StatusMessage({ status }: StatusMessageProps) {
  const message = status ? messages[status] : undefined;
  return message ? (
    <p className="auth-message" role="alert">
      {message}
    </p>
  ) : null;
}
