"use client";
import { applicationSourceDocumentSchema, type ApplicationSourceDocument } from "@vortex/platform/schema";
import { applyStudioMenuCommand, type StudioMenuCommand, type StudioMenuResult } from "@vortex/ui/studio";
import type { StudioThemeOptions } from "../_lib/studio-theme-options";
import { StudioMenuPanel } from "./studio-menu-panel";
import { StudioThemePanel, type StudioThemeChangeOutcome } from "./studio-theme-panel";
import type { StudioDraft } from "./use-studio-draft";
import type { useStudioDraftTheme } from "./use-studio-draft-theme";

/**
 * The Menu and Theme tabs: the application's navigation tree, and its shadcn create theme. Both edit the whole application, through the draft's envelope; the
 * canvas shows the home page (or the selected entry's page) so their changes are seen in the frame.
 */
export function useStudioMenuThemeTabs({ draft, menuHidden, themeHidden, themeOptions, theme, openAccessPages }: Readonly<{
  draft: StudioDraft;
  menuHidden: boolean;
  themeHidden: boolean;
  /** What the Theme tab offers, from the checked-in shadcn catalogue. */
  themeOptions: StudioThemeOptions;
  theme: ReturnType<typeof useStudioDraftTheme>;
  /** Opens Access on its Pages and menu view, where who can see an entry is set. */
  openAccessPages: () => void;
}>) {
  const { source, selected } = draft;
  const commandMenu = (command: StudioMenuCommand, merge?: string): StudioMenuResult => {
    const after: { select?: string | null | undefined } = {};
    const outcome = draft.run<StudioMenuResult>((current) => {
      const result = applyStudioMenuCommand(current, command);
      if (result.kind !== "applied") return { kind: "keep", result };
      after.select = result.select;
      return { kind: "edit", source: result.source, result };
    }, { merge });
    if (outcome.kind === "blocked") return { kind: "refused", message: outcome.message };
    if (after.select !== undefined) draft.select(after.select === null ? null : { kind: "navigation", navigationItemAlias: after.select });
    return outcome.result;
  };

  // A Theme tab change: resolved with publication's checks first, then one edit of the draft's theme selection.
  const changeThemeSelection = async (next: ApplicationSourceDocument["body"]["theme"]["selection"], what: string):
    Promise<StudioThemeChangeOutcome & Readonly<{ problems?: readonly string[] }>> => {
    const blocked = draft.blockedReason();
    if (blocked !== undefined) return { kind: "refused", message: blocked };
    const before = draft.history.getState().source;
    const candidate = applicationSourceDocumentSchema.parse(structuredClone(before));
    candidate.body.theme.selection = next;
    const result = await theme.resolve(candidate.body.theme);
    if (result.kind !== "available")
      return { kind: "refused", message: result.kind === "refused"
        ? "The theme could not be checked for this draft with your access, so nothing was changed."
        : "The theme could not be checked just now, so nothing was changed. Try again." };
    if (!result.valid) return { kind: "refused", message: `${what}: refused, so nothing was changed.`, problems: result.problems };
    // The check is asynchronous: the change applies only to the draft it was checked against.
    const outcome = draft.run(() => ({ kind: "edit", source: candidate, result: true }), { expected: before });
    return outcome.kind === "blocked" ? { kind: "refused", message: outcome.message }
      : { kind: "applied", message: `${what}. The canvas shows it.` };
  };

  const menuPanel = <StudioMenuPanel source={source} hidden={menuHidden}
    selectedAlias={selected?.kind === "navigation" ? selected.navigationItemAlias : null}
    onSelect={(alias) => { draft.select(alias === null ? null : { kind: "navigation", navigationItemAlias: alias }); }}
    onCommand={commandMenu} onOpenAccess={openAccessPages} disabled={draft.locked} />;
  const themePanel = <StudioThemePanel hidden={themeHidden} selection={source.body.theme.selection} options={themeOptions}
    disabled={draft.locked} onChange={changeThemeSelection} />;
  return { menuPanel, themePanel };
}
