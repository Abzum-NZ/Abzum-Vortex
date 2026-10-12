"use client";

import type { BlockPropertyValueV2Contract } from "@vortex/platform/schema";
import type { ReactElement } from "react";
import { Button } from "../components/button";
import { Card, CardContent } from "../components/card";
import { Input } from "../components/input";
import { Label } from "../components/label";

export type ApplicationSearchRuntime =
  | Readonly<{ kind: "disabled" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "available";
      expression: string;
      results: readonly Readonly<{ href: string; title: string; subtitle?: string }>[];
      more: boolean;
    }>;

type Settings = Readonly<Record<string, BlockPropertyValueV2Contract>>;

const textSetting = (settings: Settings, key: string): string => {
  const value = settings[key];
  if (value?.kind !== "text") throw new Error(`Application search requires the '${key}' setting`);
  return value.value;
};

/** Renders the definition-placed application search using the page runtime's protected result. */
export function ApplicationSearchBlock({
  placementId,
  settings,
  applicationSearch,
  applicationSearchPageSubject,
}: Readonly<{
  placementId: string;
  settings: Settings;
  applicationSearch?: ApplicationSearchRuntime;
  applicationSearchPageSubject?: string;
}>): ReactElement | null {
  if (applicationSearch === undefined || applicationSearch.kind === "disabled") return null;

  const placeholder = textSetting(settings, "placeholder");
  const submitLabel = textSetting(settings, "submit_label");
  return (
    <section aria-label="Application search" className="flex min-w-0 flex-col gap-3">
      <form method="get" role="search" className="flex max-w-xl items-center gap-2">
        {applicationSearchPageSubject === undefined ? null : (
          <input type="hidden" name="record_id" value={applicationSearchPageSubject} />
        )}
        <Label htmlFor={`${placementId}-query`} className="sr-only">
          Search
        </Label>
        <Input
          id={`${placementId}-query`}
          name="q"
          type="search"
          maxLength={2_000}
          defaultValue={applicationSearch.kind === "available" ? applicationSearch.expression : ""}
          placeholder={placeholder}
        />
        <Button type="submit" variant="outline">
          {submitLabel}
        </Button>
      </form>
      {applicationSearch.kind === "unavailable" ? (
        <p role="status" className="text-sm text-muted-foreground">
          Search is unavailable. Try again.
        </p>
      ) : applicationSearch.expression === "" ? null : (
        <Card size="sm">
          <CardContent className="flex flex-col gap-2 text-sm">
            {applicationSearch.results.length === 0 ? (
              <p role="status" className="text-muted-foreground">
                No results.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {applicationSearch.results.map((result) => (
                  <li key={result.href}>
                    <a
                      href={result.href}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {result.title}
                    </a>
                    {result.subtitle === undefined ? null : (
                      <p className="text-muted-foreground">{result.subtitle}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {applicationSearch.more ? (
              <p className="text-muted-foreground">
                More results are available. Refine your search.
              </p>
            ) : null}
          </CardContent>
        </Card>
      )}
    </section>
  );
}
