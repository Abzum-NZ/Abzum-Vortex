"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { Icon } from "../icons/icon";
import { APPEARANCE_COOKIE, createAppearanceRootProps, parseThemeMode, type ThemeMode } from "../theme";

type AppearanceState = Readonly<{ mode: ThemeMode; choose: (mode: ThemeMode) => void }>;

const AppearanceContext = createContext<AppearanceState | null>(null);

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * The viewer's appearance, shared by every application. The server render of the document root
 * already carries `initial` (read from the cookie), so the first paint is correct; a choice updates
 * the root and the cookie in place, and the next server render reads the same cookie.
 */
export function AppearanceProvider({
  initial,
  children,
}: Readonly<{ initial: ThemeMode; children: ReactNode }>): ReactElement {
  const [mode, setMode] = useState<ThemeMode>(initial);
  const choose = useCallback((next: ThemeMode) => {
    const root = document.documentElement;
    const props = createAppearanceRootProps(next);
    root.style.colorScheme = String(props.style.colorScheme);
    root.setAttribute("data-vortex-theme-mode", props["data-vortex-theme-mode"]);
    document.cookie = `${APPEARANCE_COOKIE}=${next}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
    setMode(next);
  }, []);
  const value = useMemo(() => ({ mode, choose }), [mode, choose]);
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

const CHOICES: readonly Readonly<{ mode: ThemeMode; label: string }>[] = [
  { mode: "system", label: "System" },
  { mode: "light", label: "Light" },
  { mode: "dark", label: "Dark" },
];

/** The top bar's appearance menu, placed when the shell's `appearance_toggle` is true. */
export function AppearanceToggle(): ReactElement | null {
  const appearance = useContext(AppearanceContext);
  if (appearance === null) return null;
  const current = CHOICES.find((choice) => choice.mode === appearance.mode);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Appearance: ${current?.label ?? "System"}`}
        className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 max-sm:min-h-[44px] max-sm:min-w-[44px] max-sm:justify-center"
      >
        <span className="max-sm:sr-only">{current?.label}</span>
        <Icon name="chevron-down" aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuRadioGroup
          value={appearance.mode}
          onValueChange={(value) => appearance.choose(parseThemeMode(String(value)))}
        >
          {CHOICES.map((choice) => (
            <DropdownMenuRadioItem key={choice.mode} value={choice.mode}>
              {choice.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
