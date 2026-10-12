"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@vortex/ui/components/button";
import { Spinner } from "@vortex/ui/components/spinner";

type SubmitButtonProps = Readonly<{
  children: string;
  pendingLabel: string;
  variant?: "default" | "outline" | "secondary" | "ghost";
  className?: string;
}>;

export function SubmitButton({
  children,
  pendingLabel,
  variant = "default",
  className = "w-full",
}: SubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      variant={variant}
      className={className}
      disabled={pending}
      aria-disabled={pending}
    >
      {pending ? <Spinner aria-hidden="true" /> : null}
      <span>{pending ? pendingLabel : children}</span>
    </Button>
  );
}
