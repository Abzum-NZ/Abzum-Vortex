import { Alert, AlertDescription } from "@vortex/ui/components/alert";

type StatusMessageProps = Readonly<{
  status?: string | undefined;
}>;

const messages: Readonly<Record<string, string>> = {
  invalid: "Check the details and try again.",
  invalid_credentials: "The email address or password was not accepted.",
  invalid_link: "This link is invalid or has expired. Request a new one and try again.",
  unavailable: "Sign-in is temporarily unavailable. Please try again shortly.",
  "signed-out": "This browser session has ended.",
  "session-ended": "Your session has ended. Sign in again to continue.",
};

export function StatusMessage({ status }: StatusMessageProps) {
  const message = status && Object.hasOwn(messages, status) ? messages[status] : undefined;
  return message ? (
    <Alert variant="destructive" className="flex items-start gap-3">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-4 shrink-0 mt-0.5"
        aria-hidden="true"
      >
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  ) : null;
}
