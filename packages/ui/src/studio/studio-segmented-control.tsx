"use client";
import type { ReactElement, ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "../components/toggle-group";

/** A choice among two to four modes, all in view: one pressed segment, optionally with an icon. */
export function StudioSegmentedControl<T extends string>({
  id,
  "aria-describedby": describedBy,
  label,
  value,
  options,
  disabled = false,
  onChange,
}: Readonly<{
  id?: string | undefined;
  "aria-describedby"?: string | undefined;
  label: string;
  value: T;
  options: readonly Readonly<{ value: T; label: string; icon?: ReactNode; disabled?: boolean }>[];
  disabled?: boolean;
  onChange: (value: T) => void;
}>): ReactElement {
  return (
    <ToggleGroup
      id={id}
      aria-label={label}
      aria-describedby={describedBy}
      variant="outline"
      size="sm"
      className="w-full"
      value={[value]}
      disabled={disabled}
      onValueChange={(next) => {
        const chosen = options.find((option) => option.value === next[0]);
        if (chosen !== undefined) onChange(chosen.value);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          // Segments share the line by their labels' width and never clip one: the toggle's padding is
          // narrowed so four labels fit a narrow inspector; the longer explanation is the field's hint.
          className="min-w-fit flex-auto px-2"
        >
          {option.icon}
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
