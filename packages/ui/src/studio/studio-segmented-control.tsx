"use client";
import type { ReactElement, ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "../components/toggle-group";

/** A choice among two to four modes, all in view: one pressed segment, optionally with an icon. */
export function StudioSegmentedControl<T extends string>({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: Readonly<{
  label: string;
  value: T;
  options: readonly Readonly<{ value: T; label: string; icon?: ReactNode; disabled?: boolean }>[];
  disabled?: boolean;
  onChange: (value: T) => void;
}>): ReactElement {
  return (
    <ToggleGroup
      aria-label={label}
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
          className="flex-1"
        >
          {option.icon}
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
