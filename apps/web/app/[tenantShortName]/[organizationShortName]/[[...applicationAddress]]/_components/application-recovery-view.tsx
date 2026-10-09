"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@vortex/ui/components/button";
import type { ApplicationPageModel } from "../../../../_lib/application-page";

export function ApplicationRecoveryView({
  recovery,
}: Readonly<{ recovery: NonNullable<ApplicationPageModel["recovery"]> }>) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <section aria-labelledby="recovery-records-heading" className="mb-6 space-y-3">
      <h2 id="recovery-records-heading" className="text-lg font-semibold">
        Recoverable records
      </h2>
      {recovery.records.length === 0 ? (
        <p role="status">No records are currently available for recovery.</p>
      ) : (
        <ul className="space-y-2">
          {recovery.records.map((record) => {
            const selected =
              recovery.selected?.recordId.toLowerCase() === record.recordId.toLowerCase();
            return (
              <li key={record.recordId}>
                <Button
                  type="button"
                  variant={selected ? "default" : "secondary"}
                  aria-pressed={selected}
                  onClick={() => {
                    const parameters = new URLSearchParams(searchParams.toString());
                    parameters.set("record_id", record.recordId);
                    router.replace(`${pathname}?${parameters.toString()}`);
                  }}
                >
                  {record.recordId}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {recovery.selected === undefined ? (
        <p role="status">Choose a record before continuing.</p>
      ) : (
        <p role="status">Selected record revision {recovery.selected.revision}.</p>
      )}
    </section>
  );
}
