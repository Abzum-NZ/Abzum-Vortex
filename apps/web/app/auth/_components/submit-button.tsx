"use client";

import { useFormStatus } from "react-dom";

type SubmitButtonProps = Readonly<{
  children: string;
  pendingLabel: string;
}>;

export function SubmitButton({ children, pendingLabel }: SubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <button className="auth-submit" type="submit" aria-disabled={pending} disabled={pending}>
      <span>{pending ? pendingLabel : children}</span>
      <span aria-hidden="true">→</span>
    </button>
  );
}
