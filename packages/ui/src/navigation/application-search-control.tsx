"use client";

import type { BlockPropertyValueContract } from "@vortex/platform/schema";
import type { ReactElement } from "react";
import { Button } from "../components/button";
import { Card, CardContent } from "../components/card";
import { Input } from "../components/input";
import { Label } from "../components/label";

export type ApplicationSearchRuntime =
  | Readonly<{ kind: "disabled" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "loading"; expression: string }>
  | Readonly<{ kind: "refused"; expression: string; reason: string }>
  | Readonly<{
      kind: "available";
      expression: string;
      results: readonly Readonly<{ href: string; title: string; subtitle?: string }>[];
      more: boolean;
      cursor?: string;
      showMore?: () => void;
      groups?: readonly Readonly<{
        key: string;
        title: string;
        results: readonly Readonly<{ href: string; title: string; subtitle?: string }>[];
        cursor?: string;
        showMore?: () => void;
      }>[];
    }>;

type Settings = Readonly<Record<string, BlockPropertyValueContract>>;

const textSetting = (settings: Settings, key: string): string => {
  const value = settings[key];
  if (value?.kind !== "text") throw new Error(`Application search requires the '${key}' setting`);
  return value.value;
};

/** Shared search controls for a definition-placed block or the application switcher. */
export function ApplicationSearchControl({
  placementId,
  settings,
  applicationSearch,
  applicationSearchPageSubject,
  onSearch,
}: Readonly<{
  placementId: string;
  settings: Settings;
  applicationSearch?: ApplicationSearchRuntime;
  applicationSearchPageSubject?: string;
  onSearch?: (expression: string) => void;
}>): ReactElement | null {
  if (applicationSearch === undefined || applicationSearch.kind === "disabled") return null;

  const placeholder = textSetting(settings, "placeholder");
  const submitLabel = textSetting(settings, "submit_label");
  return (
    <section aria-label="Application search" className="flex min-w-0 flex-col gap-3">
      <form
        method="get"
        role="search"
        className="flex max-w-xl items-center gap-2"
        onSubmit={
          onSearch === undefined
            ? undefined
            : (event) => {
                event.preventDefault();
                onSearch(String(new FormData(event.currentTarget).get("q") ?? ""));
              }
        }
      >
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
          className="min-w-0"
          maxLength={2_000}
          defaultValue={
            applicationSearch.kind === "available" ||
            applicationSearch.kind === "refused" ||
            applicationSearch.kind === "loading"
              ? applicationSearch.expression
              : ""
          }
          placeholder={placeholder}
        />
        <Button type="submit" variant="outline" className="shrink-0">
          {submitLabel}
        </Button>
      </form>
      {applicationSearch.kind === "unavailable" ? (
        <p role="status" className="text-sm text-muted-foreground">
          Search is unavailable. Try again.
        </p>
      ) : applicationSearch.kind === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          Searching…
        </p>
      ) : applicationSearch.kind === "refused" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {applicationSearch.reason}
        </p>
      ) : applicationSearch.expression === "" ? null : (
        <Card size="sm">
          <CardContent className="flex flex-col gap-2 text-sm">
            {applicationSearch.groups !== undefined ? (
              applicationSearch.groups.length === 0 ? (
                <p role="status">No results.</p>
              ) : (
                applicationSearch.groups.map((group) => (
                  <section key={group.key} className="flex flex-col gap-2">
                    <h2 className="font-semibold">{group.title}</h2>
                    <ul className="flex flex-col gap-2">
                      {group.results.map((result) => (
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
                    {group.cursor !== undefined && group.showMore !== undefined ? (
                      <Button type="button" variant="outline" onClick={group.showMore}>
                        Show more
                      </Button>
                    ) : null}
                  </section>
                ))
              )
            ) : applicationSearch.results.length === 0 && !applicationSearch.more ? (
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
            {applicationSearch.more && applicationSearch.showMore !== undefined ? (
              <Button type="button" variant="outline" onClick={applicationSearch.showMore}>
                Show more
              </Button>
            ) : null}
          </CardContent>
        </Card>
      )}
    </section>
  );
}
