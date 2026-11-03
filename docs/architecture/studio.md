# App Studio

Studio is the App Studio interface. The frame, navigation and editing surfaces are platform code built on Puck and shadcn/ui; the canvas keeps the application's own theme. Layout, sizes and screens live in `packages/ui/src/studio` and `apps/web/app/studio`, not in this document.

## Direction

"Quiet workspace, loud content." Studio is a calm, precise tool: neutral surfaces, one accent kept for the next action and the current selection, a readable base size, and hairline borders instead of boxes. The page being built is the brightest, most elevated object on screen.

Principles (each is a review check):

1. **One accent, one primary action per view.** The accent (`primary`) appears only on the primary button, the current selection, focus and links. Everything else is neutral.
2. **Hierarchy by type and space, not borders.** Panels have no inner boxes. Borders appear only at the edges of panes, on inputs, on cards and on tables.
3. **Readable minimums.** Reading text is at least 14 px. 12 px is for counts, badges, rail labels and keyboard hints only. Muted text is never placed on a muted fill.
4. **Calm feedback.** Saving is a chip. Successes and notices are toasts. Errors sit next to what caused them. Only states that block work (a conflict, an ended session) interrupt, as a dialog with one clear primary action.
5. **Short words, details on demand.** Labels use one to three words and help is one line. Longer help goes into a tooltip, and identifiers go into a closed "Details" disclosure.
6. **Tokens only.** No literal colours, radii, font sizes or pixel paddings in Studio code. Use Tailwind scale utilities on theme tokens, so the off-theme detector (`tooling/theme/off-theme-detector.js`) reports zero inside the frame.

## Theme

Studio has its own fixed shadcn create selection, `STUDIO_THEME_SELECTION` in `packages/platform/src/definition/application-composition/theme.ts`. It is resolved once on the server (`packages/platform/src/theme/studio-theme.ts`) through the same catalogue resolver as applications, so Studio uses no hand-written tokens and no CSS overrides. The `studio` document-theme segment returns that root, so the first paint and every portal carry it, and the canvas nests the application's own theme root. The platform default selection is not changed.

The platform's solid outline is the only focus indicator at the root; Studio adds no ring override. Status tints use the `warning`, `destructive`, `success` and `info` roles at no more than 10% fill with text in the same role.

## Component rules

- **Buttons.** One `default` button per view (the next step). `outline` for secondary actions, `secondary` or `ghost` for quiet pane and toolbar actions, `link` for inline navigation. `destructive` appears only in confirmation dialogs; elsewhere a remove action is a destructive menu item or a ghost icon. A disabled button keeps its variant and explains why in a tooltip.
- **Icon buttons** carry a tooltip. Repeated headings and banners are removed; help lives in tooltips.
- **Badges.** `secondary` for counts and kinds, `outline` for states such as read-only, default and draft. Status colours only through the status roles. Never a primary-filled badge in a pane.
- **Empty states** use `Empty` with an icon, a title, one sentence and at most one button.
- **Save state** is one chip with `role="status"`: saved, saving, retrying (the platform did not confirm and is retrying), and not saved (refused or conflict). When not saved it opens a popover with the reason and an undo.
- **Alerts and dialogs.** Field-located refusals show at the field. Non-blocking failures are error toasts. An ended session or changed context is an `AlertDialog` offering sign-in and undo. A draft conflict is a non-dismissable `AlertDialog` naming who changed it and offering to load the latest draft. Inline `Alert` is for persistent, local conditions only, compact, inside the pane, never full width under the top bar.
- **Inspector fields.** A label, the control, and one line of help. Optional fields say "Optional"; required is not repeated. Fixed short enumerations use `NativeSelect`; references to things the builder authored use the one `StudioReferencePicker`; two-state settings use `Switch`; segmented modes use `ToggleGroup`. Identifiers sit in a closed "Details" disclosure at the bottom.
- **Tables** (access matrix, fields, release history) use shadcn `Table` in a bordered container, with a centred `Checkbox` per permission cell and an accessible name for each.
- **Lists fetch only what is on screen**: keyset paging, with aggregates computed on the server.
