"use client";

import type { ReactElement } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { Button } from "../components/button";
import { Icon } from "../icons/icon";
import type { VortexIconName } from "../icons/icon-names";
import { parseThemeMode, type ThemeMode } from "../theme/appearance";
import { useAppearance } from "./appearance-provider";

const CHOICES: readonly Readonly<{ mode: ThemeMode; label: string; icon: VortexIconName }>[] = [
  { mode: "system", label: "System", icon: "monitor" },
  { mode: "light", label: "Light", icon: "sun" },
  { mode: "dark", label: "Dark", icon: "moon" },
];

/** The top bar's appearance menu, placed when the shell's `appearance_toggle` is true. */
export function AppearanceToggle(): ReactElement | null {
  const appearance = useAppearance();
  if (appearance === null) return null;
  const current = CHOICES.find((choice) => choice.mode === appearance.mode);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Appearance: ${current?.label ?? "System"}`}
        render={<Button variant="ghost" size="sm" className="max-sm:min-h-11 max-sm:min-w-11" />}
      >
        <Icon name={current?.icon ?? "monitor"} aria-hidden="true" className="sm:hidden" />
        <span className="max-sm:sr-only">{current?.label}</span>
        <Icon
          name="chevron-down"
          aria-hidden="true"
          data-icon="inline-end"
          className="text-muted-foreground max-sm:hidden"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuRadioGroup
          value={appearance.mode}
          onValueChange={(value) => appearance.choose(parseThemeMode(String(value)))}
        >
          {CHOICES.map((choice) => (
            <DropdownMenuRadioItem key={choice.mode} value={choice.mode} closeOnClick>
              {choice.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
