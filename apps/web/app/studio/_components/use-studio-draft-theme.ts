"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { canonicalJson, type ApplicationContent, type ApplicationSourceDocument } from "@vortex/platform/schema";
import { resolveStudioApplicationTheme } from "../actions";
import type { StudioThemeResolution } from "../_lib/studio-theme-options";

type SourceTheme = ApplicationSourceDocument["body"]["theme"];
type Theme = ApplicationContent["theme"];

/**
 * The theme the canvas draws: the draft's own theme as it is edited (including Undo and Redo), not
 * only the theme of the last compile. Each distinct draft theme is resolved once on the server with
 * the producer publication uses and kept for this visit; until it answers, the canvas keeps the
 * last theme it drew. A theme that is refused is never drawn, and the refusal is reported.
 */
export function useStudioDraftTheme({ organizationId, rootId, theme, compiledTheme, compiledSourceTheme }: Readonly<{
  organizationId: string;
  rootId: string;
  theme: SourceTheme;
  compiledTheme: Theme | undefined;
  compiledSourceTheme: SourceTheme;
}>) {
  const resolved = useRef(new Map<string, Theme>());
  const [shown, setShown] = useState<Theme | undefined>(compiledTheme);
  const [problem, setProblem] = useState("");
  const key = canonicalJson(theme);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const compiledKey = canonicalJson(compiledSourceTheme);
  if (compiledTheme !== undefined) resolved.current.set(compiledKey, compiledTheme);

  /** Resolves one candidate theme; a valid one is remembered so the canvas draws it without asking again. */
  const resolve = useCallback(async (candidate: SourceTheme): Promise<StudioThemeResolution> => {
    const known = resolved.current.get(canonicalJson(candidate));
    if (known !== undefined) return { kind: "available", valid: true, theme: known };
    const result = await resolveStudioApplicationTheme(organizationId, { rootId, theme: candidate });
    if (result.kind === "available" && result.valid) resolved.current.set(canonicalJson(candidate), result.theme);
    return result;
  }, [organizationId, rootId]);

  useEffect(() => {
    let current = true;
    const known = resolved.current.get(key);
    if (known !== undefined) { setShown(known); setProblem(""); return; }
    void resolve(themeRef.current).then((result) => {
      if (!current) return;
      if (result.kind === "available" && result.valid) { setShown(result.theme); setProblem(""); return; }
      console.error(`[studio] the canvas could not draw the draft theme: STUDIO_CANVAS_THEME_${result.kind === "available" ? "REFUSED" : result.kind.toUpperCase()}`);
      setProblem(result.kind === "available"
        ? "The draft's theme is refused by the readability checks, so the canvas shows the last theme that passed."
        : "The draft's theme could not be resolved, so the canvas shows the last theme it drew.");
    }).catch((error: unknown) => {
      console.error("[studio] resolving the draft theme for the canvas failed", error);
      if (current) setProblem("The draft's theme could not be resolved, so the canvas shows the last theme it drew.");
    });
    return () => { current = false; };
  }, [key, resolve]);

  return { theme: shown, problem, resolve };
}
