"use client";

import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { useState } from "react";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import type { StudioRecordPageCheck, StudioStructureResult } from "@vortex/ui/studio";

const actionLabel = (check: StudioRecordPageCheck): string | undefined => {
  if (check.kind === "missing_edit_page" || check.kind === "missing_row_edit") return "Add Edit";
  if (check.kind === "missing_form_cancel") return "Add Cancel";
  return undefined;
};

function CheckOffer({
  check,
  disabled,
  onFix,
}: Readonly<{
  check: StudioRecordPageCheck;
  disabled: boolean;
  onFix: (check: StudioRecordPageCheck) => StudioStructureResult;
}>) {
  const [problem, setProblem] = useState<string>();
  const label = actionLabel(check);
  const fix = () => {
    const result = onFix(check);
    setProblem(result.kind === "refused" ? result.message : undefined);
  };
  return (
    <li className="space-y-2 py-3">
      <p className="font-medium">{check.label}</p>
      {label === undefined ? (
        <p className="text-muted-foreground">
          Add content to the home page in Structure, or publish it as it is.
        </p>
      ) : (
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={fix}>
          <Icon name="plus" />
          {label}
        </Button>
      )}
      {problem === undefined ? null : (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
    </li>
  );
}

/** Publish's review of the record pages a saved draft still needs, with a one-click offer for each. */
export function StudioPageCheckReview({
  checks,
  disabled,
  onFix,
}: Readonly<{
  checks: readonly StudioRecordPageCheck[];
  disabled: boolean;
  onFix: (check: StudioRecordPageCheck) => StudioStructureResult;
}>) {
  if (checks.length === 0) return null;
  return (
    <section aria-label="Record pages that need attention" className="space-y-2 text-sm">
      <h3 className="flex items-center gap-2 font-semibold">
        <Icon name="info" className="size-4" />
        Record pages that need attention
      </h3>
      <p className="text-muted-foreground">
        These pages are published as they are. Add what is missing here, or publish anyway.
      </p>
      <ul className="space-y-2">
        {checks.map((check) => (
          <CheckOffer
            key={`${check.kind}:${"recordType" in check ? check.recordType : check.pageAlias}`}
            check={check}
            disabled={disabled}
            onFix={onFix}
          />
        ))}
      </ul>
    </section>
  );
}
