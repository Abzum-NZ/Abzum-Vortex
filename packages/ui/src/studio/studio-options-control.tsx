"use client";

import { useState } from "react";
import type { JsonValue } from "@vortex/platform/schema";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { Input } from "../components/input";

/** Labelled choice values, preserving removed selections until the author removes them. */
export function StudioOptionsControl({
  id,
  value,
  options,
  onChange,
  "aria-label": label,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: Readonly<{
  id: string;
  value: readonly JsonValue[];
  options: readonly Readonly<{ value: string; label: string }>[];
  onChange: (value: JsonValue[]) => void;
  "aria-label": string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}>) {
  const [search, setSearch] = useState("");
  const searchable = options.length > 12;
  const selected = options.filter((option) => value.includes(option.value));
  const unknown = value.filter((entry) => !options.some((option) => option.value === entry));
  const visible = options.filter(
    (option) =>
      !searchable || option.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const commit = (keys: readonly string[], removedIndex?: number) =>
    onChange([
      ...options.filter((option) => keys.includes(option.value)).map((option) => option.value),
      ...unknown.filter((_, index) => index !== removedIndex),
    ]);

  return (
    <div
      id={id}
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      aria-invalid={invalid}
      className="min-w-0 space-y-3"
    >
      {(selected.length > 0 || unknown.length > 0) && (
        <div className="flex min-w-0 flex-wrap gap-2" aria-label="Selected options">
          {selected.map((option) => (
            <Badge
              key={option.value}
              variant="secondary"
              className="max-w-full whitespace-normal break-words"
            >
              {option.label}
            </Badge>
          ))}
          {unknown.map((_, index) => (
            <div key={index} className="flex min-w-0 flex-wrap items-center gap-1">
              <Badge variant="destructive" className="max-w-full whitespace-normal">
                Unknown option (removed)
              </Badge>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Remove unknown option"
                onClick={() =>
                  commit(
                    selected.map((option) => option.value),
                    index,
                  )
                }
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
      {searchable && (
        <Input
          aria-label="Search options"
          placeholder="Search options…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      )}
      <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
        {visible.map((option) => (
          <label
            key={option.value}
            className="flex min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-accent"
          >
            <Checkbox
              checked={value.includes(option.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onCheckedChange={(checked) =>
                commit(
                  checked
                    ? [...selected.map((entry) => entry.value), option.value]
                    : selected
                        .filter((entry) => entry.value !== option.value)
                        .map((entry) => entry.value),
                )
              }
            />
            <span className="min-w-0 break-words">{option.label}</span>
          </label>
        ))}
        {visible.length === 0 && (
          <p className="p-2 text-sm text-muted-foreground">No matching options.</p>
        )}
      </div>
    </div>
  );
}
