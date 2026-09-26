"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@vortex/ui/components/button";
import { Spinner } from "@vortex/ui/components/spinner";

type SubmitButtonProps = Readonly<{
  children: string;
  pendingLabel: string;
}>;

export function SubmitButton({ children, pendingLabel }: SubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" className="w-full" disabled={pending} aria-disabled={pending}>
      {pending ? <Spinner aria-hidden="true" /> : null}
      <span>{pending ? pendingLabel : children}</span>
    </Button>
  );
}
