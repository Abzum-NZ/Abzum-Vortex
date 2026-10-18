# App Studio redesign spec

Owner request (19 Oct 2026): "The interface of the app studio needs to be redesigned to make it more readable. Use shadcn ui components / theme if needed. It should look ultra modern and elegant."

Author: Opus design architect, 19 Oct 2026. Baseline: `origin/main` 626737f5. The local checkout was 133 commits behind and was not used. Every file path below is on `origin/main`.

Binding: `A:/Apps/Abzum-Vortex/AGENTS.md`, `docs/build-plan/target-architecture.md`, and Studio decisions 1, 14, 17, 20 and 34 (vortex-studio-decisions). Also ui-fully-definition-driven and one way only. Studio's frame is platform code. The canvas keeps the app's own theme. All theming goes through a shadcn create selection, with no token-override editor. Old styling is replaced in place and deleted.

---

## 0. Diagnosis (why it reads badly today)

| Symptom (screenshots) | Root cause in code |
|---|---|
| Type is 11-13 px, controls are cramped, and every button looks alike | Studio paints with the **platform default selection**: `style: "nova"`, described as "Reduced padding and margins". Studio is in `PLATFORM_SEGMENTS` in `apps/web/app/_lib/document-theme.ts`. Nova's buttons are h-7 with xs text, and its inputs are h-8. |
| Low-contrast grey on near-black, and no brand colour | The neutral base and neutral theme have no accent. `primary` is near-white in dark mode, so Publish looks like every other button. |
| No hierarchy: everything is a bordered box | `StudioPanelShell` uses a `text-sm font-medium` title and an `text-xs` description. Rows are `<Button variant="outline">` pills. Section headers are `text-xs uppercase` everywhere. |
| Page-wide walls of red text | `StudioSaveProblem` renders a destructive `Alert` across the whole top bar for every refused save and every conflict. A second status line (`status`) also sits under the top bar. |
| Inspector is dense: a "Technical details" box on top and long helper paragraphs | `StudioInspector` puts `TechnicalDetails` first. `StudioField` hints are full paragraphs. Move up, Move down and Remove are a row of equal buttons. |
| Flow nodes are white boxes on a dotted void | `StudioFlowCanvas` uses `Card` with radius 0 (`--xy-node-border-radius-default: 0`) and no type icon. React Flow `colorMode` is not tied to appearance, so its own light defaults show through. The canvas is not framed. |
| Canvas is mostly empty, and the three columns are cramped | The inspector is fixed at `w-80`. The canvas has no page frame, and its placeholders are not empty states. |

The single biggest fix is **one Studio theme selection** (section B), which repairs size, density, contrast and button hierarchy everywhere at once through the component layer. The rest is layout and patterns.

---

## A. Design direction and principles

**Direction:** "Quiet workspace, loud content." Studio becomes a calm, precise tool in the spirit of Linear, Vercel and Figma. It uses neutral zinc surfaces, one indigo accent kept for the next action and the current selection, Geist type at a readable 14 px base, and hairline borders instead of boxes. The page being built is the brightest, most elevated object on screen.

Principles (each is a review check):
1. **One accent, one primary action per view.** Indigo (`primary`) appears only on the primary button, the current selection, focus and links. Everything else is neutral.
2. **Hierarchy by type and space, not borders.** Panels have no inner boxes. Groups are separated by spacing and a section header. Borders appear only at the edges of panes, on inputs, on cards (canvas frame, home cards, flow nodes) and on tables.
3. **Readable minimums.** Reading text is at least 14 px. 12 px is allowed only for counts, badges, rail labels and keyboard hints. Muted text is never placed on a muted fill.
4. **Calm feedback.** Saving is a chip. Successes and notices are toasts. Errors sit next to what caused them. Only states that block work (a conflict, an ended session) interrupt, and they do so as a dialog with one clear primary action.
5. **Short words, details on demand.** Labels use 1-3 words and help is one line. Longer help goes into a tooltip, and identifiers go into a closed "Details" disclosure at the bottom.
6. **Tokens only.** No literal colours, radii, font sizes or pixel paddings in Studio code. Use only Tailwind scale utilities on theme tokens, so the off-theme detector (`tooling/theme/off-theme-detector.js`) reports zero inside the frame.

---

## B. Tokens

### B1. The Studio theme selection (the one mechanism)

Studio gets its own **fixed shadcn create selection**. It is resolved through the same catalogue resolver as apps, so it uses no hand-written tokens and no CSS overrides:

```ts
// packages/platform/src/definition/application-composition/theme.ts, beside DEFAULT_APPLICATION_THEME_SELECTION
export const STUDIO_THEME_SELECTION = applicationThemeSelectionSchema.parse({
  style: "vega",          // classic shadcn density: h-9 controls, text-sm, 16-24 px card padding
  baseColor: "zinc",      // cool neutral, slightly blue-grey: reads "tool", not "document"
  theme: "indigo",        // the one accent
  chartColor: "indigo",
  radius: "medium",       // 0.625rem
  menuColor: "default",
  menuAccent: "subtle",
  iconLibrary: "lucide",
  bodyFont: "geist",
  headingFont: "inherit",
});
```

- The selection is resolved once, server-side, against `DEFAULT_PLATFORM_THEME_RELEASE`, using the existing resolver in `packages/platform/src/theme/selection.ts`. It is exported as `STUDIO_THEME_ROOT` (the theme variables plus `createVortexStyleRootProps`).
- `apps/web/app/_lib/document-theme.ts`: the `studio` segment stops falling into the platform default branch. `loadDocumentTheme()` returns the Studio root for `/studio/**`, so the first paint, `<html>`, and every portal (Dialog, Popover, Sonner, Tooltip) carry the Studio theme. This satisfies decision 14.
- New `apps/web/app/studio/layout.tsx` wraps all Studio routes in `<VortexStyleRoot documentTheme {...STUDIO_THEME_ROOT}>`. This keeps client-side navigation into and out of Studio correct through the existing `useDocumentTheme` mechanism. The canvas keeps nesting the app's own `VortexStyleRoot`. Nested roots reset variables, so the app theme is unaffected.
- The platform default selection (nova and neutral) is **not** changed: shipped app themes pin it.

### B2. Colour roles (shadcn CSS variables, resolved values)

The ratios below are WCAG 2.x, computed from the catalogue's resolved oklch values.

| Role (`--var`) | Light | Dark | Use | Contrast |
|---|---|---|---|---|
| `--background` | oklch(1 0 0) | oklch(0.141 0.005 286) | Canvas well, top bar, dialogs | `--foreground` on it: L 19.9, D 19.1 |
| `--sidebar` | oklch(0.985 0 0) | oklch(0.21 0.006 286) | Rail, navigator and inspector panes | `--muted-foreground` on it: L 4.62, D 6.74 |
| `--card` | oklch(1 0 0) | oklch(0.21 0.006 286) | Home cards, flow nodes, canvas frame | Separated by `--border` and shadow; never by fill alone (D 1.12) |
| `--muted` | oklch(0.967 0.001 286) | oklch(0.274 0.006 286) | Hover fills, table header row, code chips | **`--muted-foreground` on muted fails in light (4.39)**: text on muted uses `--foreground` |
| `--muted-foreground` | oklch(0.552 0.016 286) | oklch(0.705 0.015 286) | Help, meta, inactive rail labels | On background: L 4.83, D 7.56 |
| `--accent` / `--accent-foreground` | 0.967 / 0.21 | 0.274 / 0.985 | Selected row in a list or tree, active rail item | 15+ both modes |
| `--primary` / `--primary-foreground` | oklch(0.457 0.24 277) / 0.962 | oklch(0.497 0.195 277) / 0.962 | Primary button, selected node ring, current indicator, links | fg on primary: L 7.22, D 5.83. Primary on bg (as text or ring): L 8.07, D 3.05 (3:1 non-text OK; **never small text in dark**: use `--foreground` for dark link text with an underline) |
| `--destructive` | oklch(0.577 0.245 27) | oklch(0.704 0.191 22) | Remove, delete, error text, error chip | On bg: L 4.76, D 6.88; on card D 6.13 |
| `--warning` | #92400E | #FBBF24 | "Retrying" chip, unsaved warnings | On bg: L 7.09, D 11.9 |
| `--success` | #166534 | #4ADE80 | Published toast icon, check states | On bg: L 7.13, D 11.4 |
| `--info` | #1D4ED8 | #60A5FA | Informational inline alerts | On bg: L 6.70, D 7.82 |
| `--border` / `--input` | 0.92 | white at 10% / 15% | Pane edges, inputs, cards, tables | Decorative. Inputs are also identified by their label and focus ring |
| `--ring` | oklch(0.705 …) | oklch(0.552 …) | Focus | **Light ring is 2.63:1 and fails 1.4.11** (see below) |

Tinted status fills use `bg-warning/10`, `bg-destructive/10` and `bg-success/10` with text in the same role. Each stays at 4.5:1 or above because the tint is no more than 10% over the background. Chart colours are never used for status (decision 34).

**Focus ring defect (platform-wide, fix at the root):** zinc and neutral `ring` in light mode is 2.63:1 on white. Fix it in the catalogue's contrast gate. Add `ring ≥ 3:1 on background` to the same derivation that already corrects `primary` (`contrastDerivations`), so every selection, apps included, gets a compliant ring. This goes in slice 1 (S1) as its own commit. Studio code adds no ring override.

### B3. Typography (Geist via `bodyFont: "geist"`; Tailwind scale only)

| Token (utility) | Size / line height | Weight | Use |
|---|---|---|---|
| `text-3xl tracking-tight` | 30 / 36 | 600 | Studio home title |
| `text-xl tracking-tight` | 20 / 28 | 600 | Canvas header title for Data, Flows, Access and Releases editors; dialog titles |
| `text-base` | 16 / 24 | 600 | Pane titles (navigator, inspector); home card titles |
| `text-sm` | 14 / 20 | 500 | Section headers inside panes (sentence case, `text-foreground`) |
| `text-sm` | 14 / 20 | 400 | Body text, list rows, controls, table cells, field labels (500) |
| `text-sm text-muted-foreground` | 14 / 20 | 400 | One-line help, empty-state body |
| `text-xs` | 12 / 16 | 500 | Counts, badges, chips, rail labels, `Kbd`, table header (uppercase is **not** used) |
| `font-mono text-xs` | 12 / 16 | 400 | Identifiers inside the "Details" disclosure only |

Numbers in tables and counts use `tabular-nums`. The longest reading line is `max-w-prose` (about 65 characters) in canvas editors.

### B4. Spacing, radius, elevation, density

- **Spacing scale** (Tailwind 4 px base; only these steps in Studio code): 1 (4), 1.5 (6), 2 (8), 3 (12), 4 (16), 6 (24), 8 (32), 12 (48).
  - Pane padding: `px-4 py-3`.
  - Between sections in a pane: `gap-6`.
  - Between fields: `gap-4`.
  - Label to control: `gap-2` (vega `Field`).
  - Canvas editor gutters: `px-8 py-6`, content `max-w-4xl`.
- **Radius** (from `radius: medium`, `--radius` 0.625rem):
  - Controls and rows: `rounded-md` (8 px).
  - Cards, flow nodes, canvas frame, dialogs: `rounded-xl` (14 px).
  - Chips and badges: `rounded-full`.
  - Rail items: `rounded-lg`.
- **Elevation:**
  - Level 0: panes, flat, separated by a 1 px `border`.
  - Level 1: cards and flow nodes, `border` plus `shadow-xs`.
  - Level 2: the canvas page frame and the selected node, `shadow-lg` plus `ring-1 ring-border`.
  - Level 3: popovers, dialogs and toasts (the component default).
  - No shadow inside panes.
- **Density rules:**

  | Element | Height | Notes |
  |---|---|---|
  | Navigator row | `h-8` (32) | Two-line rows `min-h-12` |
  | Control | `h-9` (36) | vega default |
  | Top-bar button | `size="sm"` (32) | |
  | Icon button | `size="icon-sm"` (32) | |
  | Table row | 44 | |
  | Rail item | 56 × 52 | |

  - Minimum hit target: 24 × 24 (WCAG 2.5.8).
  - Never stack more than two text lines in a list row.

---

## C. Layout

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ◆ Org / App ▾ / Page      ● Saved          ↶ ↷ │ Back to app   Preview   [Publish]   ◐   │  top bar h-14
├──────┬───────────────────┬┬──────────────────────────────────────────┬┬──────────────────┤
│ rail │ navigator pane     ││ canvas header (title · view as · device) ││ inspector pane   │
│ 72px │ title + action     ││ ──────────────────────────────────────── ││ title + kind     │
│ icon │ search             ││                                          ││ grouped sections │
│ +lbl │ sections / tree    ││        ┌─────── page frame ───────┐      ││ (Collapsible)    │
│      │                    ││        │   app theme, shadow-lg    │      ││                  │
│ ──── │                    ││        └───────────────────────────┘      ││ Details ▸        │
│ Rel. │                    ││                                          ││                  │
└──────┴───────────────────┴┴──────────────────────────────────────────┴┴──────────────────┘
```

**Top bar** (`StudioTopBar`, `h-14 px-3`, `bg-background border-b`):
- **Left:**
  - Vortex mark (icon button linking to `/studio`, `aria-label="All applications"`).
  - `Breadcrumb`: organisation › application, where the application is a `DropdownMenu` trigger listing that organisation's apps to switch quickly › current item.
  - Then the **save-state chip** (D5).
- **Right:**
  - Undo and Redo: ghost `icon-sm` buttons, each with a `Tooltip` showing `Kbd` (Ctrl Z, Ctrl Shift Z).
  - `Separator orientation="vertical"`.
  - "Back to app": ghost `sm`.
  - "Preview": outline `sm`, eye icon.
  - "Publish": **default (primary)** `sm`. The label is "Publish", not "Publish…".
  - `AppearanceToggle`, unchanged shared component.
- The status line and status-link row under the top bar are removed. Their content moves to toasts (D9).

**Rail** (`StudioRail`, `w-18` = 72 px, `bg-sidebar border-r`):
- Icon (`size-5`) over a label (`text-xs font-medium`).
- Groups are separated by `gap-1` and a `Separator` between groups:
  - Build: Structure, Outline, Blocks, Menu.
  - Logic: Data, Flows.
  - Look and access: Theme, Access.
  - Releases is pinned to the bottom (`mt-auto`).
- Inactive items: `text-muted-foreground`. Hover: `bg-sidebar-accent/60 text-foreground`.
- Active item: `bg-sidebar-accent text-sidebar-accent-foreground`, plus a 3 px `bg-primary` indicator bar at the item's left edge (`before:` pseudo, `rounded-full`).
- Tablist semantics and arrow-key handling stay exactly as they are.

**Navigator pane** (the rail panel, `bg-sidebar`):
- Resizable with the existing `PanelResizer`, now a hairline: a 1 px `bg-border` line with an 8 px invisible hit area, which shows `bg-primary` on hover and focus.
- Clamp 15-32 rem. Per-tab stored widths stay.
- Default widths: structure, outline, flows, access and releases 17; blocks and data 18; menu 20; theme 22.

**Canvas** (`bg-background`):
- Canvas header row `h-12 px-4 border-b`.
- The page canvas draws the app page in a **page frame**: `rounded-xl shadow-lg ring-1 ring-border`, centred, `my-8`, at the chosen device width. The well around it is `bg-muted/40`.
- Non-page tabs (Data, Flows, Access, Releases) draw a full-width editor with `px-8 py-6` and `max-w-4xl` content. Flows is full-bleed.

**Inspector pane** (`bg-sidebar border-l`):
- Collapsible with the canvas-header toggle and with Ctrl+. (period).
- **Resizable** with the same `PanelResizer` on its left edge (storage key `inspector`), clamp 18-30 rem.
- Defaults: 20 rem at 1280-1439, 22 rem at 1440-1919, 24 rem at 1920 and wider.
- "Focus canvas" (Ctrl+\\) collapses both side panes. It is also a canvas-header icon button.

**Widths at each breakpoint:**

| Viewport | Rail | Navigator | Inspector | Canvas | Behaviour |
|---|---|---|---|---|---|
| 1920 | 72 | 288 (18 rem) | 384 (24 rem) | about 1176 | Everything open |
| 1440 | 72 | 272 (17 rem) | 352 (22 rem) | about 744 | Everything open |
| 1280 | 72 | 256 (16 rem) | 320 (20 rem) | about 632 | Everything open. The page frame zooms to fit when the device width exceeds the canvas (zoom chip shows "Fit") |
| 1024-1279 | 72 | 256 | overlay | about 696 | Inspector opens as an overlay `Sheet` from the right on selection |
| < 1024 | Existing narrow mode | | | | Navigator and inspector in sheets. Kept, not a design target |

---

## D. Component patterns (exact shadcn components)

New shadcn components are added to `packages/ui/src/components/` from the base registry pinned at shadcn 4.21.0: **`tooltip.tsx`, `toggle.tsx`, `toggle-group.tsx`, `kbd.tsx`**. They use `@base-ui/react`, which is already a dependency, so no npm packages are added. The `.cn-tooltip`, `.cn-toggle-group` and `.cn-kbd` rules already exist in `style-variants.css` and `shared-components.css`.

Already present and to be used: `Item`, `Empty`, `Badge`, `Button`, `Collapsible`, `Field`, `InputGroup`, `NativeSelect`, `Combobox`, `Dialog`, `AlertDialog`, `DropdownMenu`, `Popover`, `Sonner`, `Table`, `Tabs`, `Separator`, `Skeleton`, `Spinner`, `Sheet`, `Breadcrumb`, `Card`, `Switch`, `Checkbox`.

**D1. Pane header** (`StudioPanelShell`, rewritten in place):
- Row: `px-4 pt-4 pb-3`, title `text-base font-semibold`, primary pane action on the right (`Button size="sm" variant="secondary"` with a plus icon, for example "+ Page" or "+ Record type").
- The description is gone from the header. It becomes the pane's **empty state** body, or a `Tooltip` on an info icon next to the title when it is a definition.
- The search field (`StudioSearchBox`, `InputGroup`) sits right under the header and is sticky.

**D2. Section header** (new `StudioSection`, in `studio-frame.tsx`):
- `text-sm font-medium` on the left, optional count `Badge variant="secondary"` and optional ghost `icon-xs` action on the right. `mt-6` before every section except the first.
- Collapsible sections use `Collapsible` with a chevron trigger, and the open state is remembered per section in `localStorage` (inside a `try`).
- Replaces every `h3.text-xs.uppercase.text-muted-foreground`.

**D3. Navigator row and tree** (new `StudioNavItem` and `StudioNavTree`, built on shadcn **`Item`** with `size="sm"`, rendered as `button`):
- Row: `h-8 rounded-md px-2 gap-2`, leading icon `size-4 text-muted-foreground` (page, layout, record type, flow, role), label `text-sm truncate`, trailing meta `text-xs text-muted-foreground tabular-nums` (for example "20 fields"), and a trailing `DropdownMenu` "More" (ghost `icon-xs`) shown on hover and focus.
- Selected row: `bg-accent text-accent-foreground font-medium` with `aria-current="true"`.
- Tree: chevron `size-4` toggles with `aria-expanded`. Children are indented by 16 px (`pl-4`) with **no guide lines**. The tree has `role="tree"`, rows have `treeitem`, and arrow keys use roving focus (same code shape as the rail).
- Two-line rows (releases tools, roles): `min-h-12`, with the second line `text-xs text-muted-foreground line-clamp-1`.
- Read-only groups (for example "System Directory, read-only"): a `Badge variant="outline"` with a lock icon on the group row. The owner note moves to a `Tooltip`.

**D4. Inspector form** (rewrite of `StudioInspector`, `StudioField`, and `StudioSettingFields` in `packages/ui/src/studio/studio-setting-controls.tsx`):
- Header: kind icon plus `text-base font-semibold` title, with the kind under it as `text-xs text-muted-foreground` (for example "Flow step"). Right side: a `DropdownMenu` "More" (Move up, Move down, Duplicate, separator, **Remove** as the destructive item with an `AlertDialog` confirmation).
- Body: groups as **`Collapsible`** sections. Header is a `text-sm font-medium` trigger with a chevron, open by default. Groups are "General", then "Settings" from the property metadata, then "Behaviour", then "Used in". `gap-4` between fields.
- **`StudioField`**: `FieldLabel` (`text-sm font-medium`), then the control, then one-line `FieldDescription` (`text-sm text-muted-foreground`, at most about 80 characters).
  - Longer help moves to a `Tooltip` on an info icon (`size-3.5`) after the label. The tooltip is also the description's `aria-describedby` target, so screen readers still read it.
  - "(required)" is dropped from labels. Optional fields show `Optional` as `text-xs text-muted-foreground` after the label.
  - Errors: `FieldError` (`text-sm text-destructive`) with `aria-invalid`. This behaviour already exists.
- **Choice controls:**
  - Fixed short enumerations (no more than 8 options, for example "Record to change") use `NativeSelect` at full width. It is fast, native-keyboard and already used 207 times, so it stays as the one fixed-choice control.
  - References to things the builder authored (record types, fields, pages, queries, roles, earlier steps, value sources) use the **one `StudioReferencePicker`** built on `Combobox`, with search, grouping by module or step, and secondary text.
  - Two-state settings use `Switch`. Segmented modes (2-4 options) use `ToggleGroup`.
- **Repeating entries** ("Inputs of the action it runs", "Field values"): a bordered `rounded-lg` list of rows, each row with a remove `icon-xs` ghost button, plus a ghost "+ Add input" at the end.
- **Details** (replaces `TechnicalDetails` at the top): a closed `Collapsible` "Details" at the **bottom** of the inspector, holding a `dl` with kind, alias and source path in `font-mono text-xs` and a copy `icon-xs` button.
- Empty inspector: `Empty` with a cursor icon, the title "Nothing selected" and the body "Select a page, block, field or step to change it."

**D5. Save-state chip** (in `StudioTopBar`; one chip per decision 20):
- `Badge`, `rounded-full h-6 px-2 text-xs font-medium gap-1.5`, `role="status" aria-live="polite"`.

  | State | Look | Content |
  |---|---|---|
  | Saved | `variant="ghost"`, check icon, muted | "Saved". Tooltip: "All changes saved" plus relative time |
  | Saving / updating canvas | `Spinner size-3` | "Saving…" or "Updating canvas…" |
  | Failed (platform did not confirm; retrying by itself) | `bg-warning/10 text-warning`, rotate icon | "Retrying…" |
  | Refused / conflict | `bg-destructive/10 text-destructive`, alert-circle icon | "Not saved" |

- The chip is a `Popover` trigger when not saved. The popover shows the reason (one paragraph), plus "Undo my change" (outline) and, for a refusal, "Try again" (default).

**D6. Buttons hierarchy** (`Button` variants; the rule is one `default` per view):

| Role | Variant / size | Examples |
|---|---|---|
| Primary (the next step) | `default` | Publish, Add role, Create application, Load the latest draft, Replace the draft |
| Secondary | `outline` | Preview, Check the file, Preview as role |
| Pane / quiet actions | `secondary` (create) or `ghost` (toolbar, row actions) | + Page, zoom, undo |
| Destructive | `destructive` (only in confirmation dialogs) | Remove role, Remove step. In panes a remove action is a `DropdownMenu` destructive item or a ghost icon with a destructive hover, never a red button inline |
| Inline link actions | `link` | "Open in Data" |

- Disabled buttons keep their variant and get a `Tooltip` saying why, through a wrapper `span` because disabled buttons do not fire events.

**D7. Badges and status chips:**
- `Badge variant="secondary"` for counts and kinds.
- `outline` for "Read-only", "Default member role", "Draft" and "Published v3".
- Status colours only through `bg-{success|warning|destructive|info}/10 text-{role}`.
- Never use `default` (primary-filled) badges in panes.

**D8. Empty states** (`Empty` component everywhere a "Choose …" sentence sits today):
- `EmptyMedia variant="icon"` (lucide), `EmptyTitle` (`text-base`), `EmptyDescription` (one sentence), and optional `EmptyContent` with one `default` or `outline` button.
- Canvas placeholders are centred vertically. Examples:
  - "No page open": "Choose a page in Structure, or add one." with "+ Page".
  - "No record type selected": "Pick a record type to see its fields and records." with "+ Record type".

**D9. Alerts, toasts and dialogs** (replace the page-wide red banners):
- **Sonner** `Toaster`: mounted once in `apps/web/app/studio/layout.tsx`, `position="bottom-right"`, `visibleToasts={3}`, `closeButton`. Its font and colours come from the theme (the `[data-sonner-toaster]` font rule already exists).
  - `toast.success` for "Published version 4" (action "Open App Store"), "Restored version 2 into the draft" and "Imported. Your draft is the imported file now."
  - `toast` for "Preview is starting…" (with promise state).
  - `toast.error` for non-blocking failures that are not tied to a field (persistent until dismissed, `description` holds the reason).
- **Field-located refusals** (for example `alias_conflict` with a location): `FieldError` at the field, and the chip shows "Not saved". No banner.
- **Session ended or context changed** (`session_ended`, `context_changed`, `recent_authentication_required`): `AlertDialog`.
  - Title: "Sign in to keep working".
  - Body: "Your session ended, so your last change wasn't saved."
  - Primary: "Sign in again", which opens sign-in in a new tab and then waits for focus to come back and retries.
  - Secondary: "Undo my change".
- **Conflict** (`draft_changed` or `alias_conflict` without a location): `AlertDialog`, not dismissable.
  - Title: "This draft was changed elsewhere".
  - Body: who and when (`FormattedTime`), then a `rounded-lg border divide-y` list of at most 6 changes ("+ N more").
  - Primary: "Load the latest draft".
  - Footnote: `text-sm text-muted-foreground` "Your unsaved change will be discarded."
- **Inline `Alert`** stays for persistent, local conditions only, and is compact (`variant="warning|info|destructive"`, title of 1 line, description of 2 lines or fewer, inside the pane or editor, **never full-width under the top bar**). Examples: "This draft does not compile" on the canvas (details in a `Collapsible`), and "Read-only: owned by Organisation Administration" in Data.

**D10. Tables** (Access matrix, fields, release history; shadcn `Table`):
- The container is `rounded-xl border overflow-hidden`.
- Header row `bg-muted/50`, `text-xs font-medium text-foreground`, sentence case. Rows are 44 px with `hover:bg-muted/40`. Numeric and checkbox columns are centred with `w-20`.
- Sticky first column and sticky header in long matrices.
- **Access matrix:** one row per record type, columns Read, Create, Update, Delete, then Fields (a `link` button that opens the field sheet).
  - Each cell is a centred `Checkbox` with a full accessible name ("Members can update Devices").
  - Extra permissions ("Restore device", "Export device") go in an expandable sub-row (chevron on the record-type cell) as `Checkbox` items, instead of the current "Also:" line.
  - Variant reads ("Read device (Borrower)") show as a `ToggleGroup` inside the Read cell's `Popover`.
- Pages matrix: page, then "Opens with" (muted), then a "Can open" `Switch`.

**D11. Flow canvas nodes** (`StudioFlowNode`, replaces `CanvasNode`):
- `Card`, `w-64 rounded-xl border bg-card shadow-xs px-3 py-2.5`.
- Row 1: type icon in a `size-7 rounded-md` tile, then title `text-sm font-medium truncate`.
- Row 2: summary `text-xs text-muted-foreground line-clamp-2`.
- Type icons and tile tones are neutral (`bg-muted text-foreground`) except:
  - Start: `bg-primary/10 text-primary`, play icon.
  - End: `bg-muted`, flag icon.
  - Decisions (If, Switch): branch icon.
  - Stop: `bg-destructive/10 text-destructive`, octagon icon.
- Selected: `ring-2 ring-primary shadow-lg`. Hover: `border-foreground/20`.
- Handles: `size-2 rounded-full bg-border border-background`, invisible until hover. Edges are `--muted-foreground` at 1.5 px, smoothstep. Branch labels are `Badge variant="secondary"` pills ("Then", "Else", "on failure").
- Pane: React Flow `colorMode` follows the resolved appearance, background `variant="dots" gap={20} size={1}` in `--border`, and `Controls` restyled as a vertical `ButtonGroup`-like stack of ghost `icon-sm` buttons in a `rounded-lg border bg-card shadow-xs` container at bottom-left.
- "+" add-step affordance: a ghost `icon-xs` circle on each edge midpoint on hover. It opens the same "Add a step" `Combobox` the inspector uses (one code path).

---

## E. Screen-by-screen

**E1. Studio home** (`/studio` and `/studio/[org]`):
- One `StudioHome` component. `/studio/[org]` is the same view filtered to one organisation.
- Header: `text-3xl` "Applications", a one-line description, and on the right `Button default` "+ New application".
- One section per organisation (`text-base font-semibold` plus tenant `text-sm muted`).
- Apps are shown as a **card grid** (`grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-4`). Each `Card`, which is a link to the workspace, holds:
  - a `size-10 rounded-lg` app-icon tile (the app's icon, or its initials on `bg-primary/10 text-primary`);
  - the name (`text-base font-semibold`) and description (`text-sm muted line-clamp-2`);
  - a footer of "Edited 2 h ago by Vijay" (`text-xs muted`, `FormattedTime`) and a `Badge outline` "Published v3" or "Draft only";
  - a `DropdownMenu` "More" with "Published versions", which opens `?tab=releases&section=history`.
- The empty state uses `Empty` with "+ New application".
- "Show more" becomes keyset `Pagination` per the list paging rule (default 40).
- `/studio/[org]/new`: a centred `Card max-w-lg` with Name and Description (decision 21) and primary "Create application".

**E2. Structure** (navigator):
- Header "Structure" with "+ Add" `DropdownMenu`: Page, Page for a record type, Layout. This replaces three stacked buttons.
- Search, then the sections "Pages" (tree, home page marked with a `Badge secondary` "Home") and "Layouts".
- Selecting a page opens it on the canvas. The inspector shows Page: name, address, layout and visibility in Collapsible groups.

**E3. Outline** (navigator):
- A tree of the open page's blocks (D3) with block-type icons. Drag handles appear on hover (`grip-vertical`, Puck's drag).
- An empty state appears when no page is open.

**E4. Blocks** (navigator, `studio-block-palette.tsx`):
- The "Add to" target `NativeSelect` sits at the top.
- Then the groups (D2 sections). Each block is a 2-column grid tile (`rounded-lg border bg-card p-3`, icon `size-5`, name `text-sm font-medium`, one-line purpose `text-xs muted line-clamp-2`), draggable, with an "Add" on click and Enter.
- Search filters the tiles.

**E5. Canvas** (page tabs):
- Header: page title (`text-sm font-semibold`), then on the right:
  - "View as" `Select`-styled `NativeSelect` (`size="sm"`);
  - device `ToggleGroup` (desktop, tablet, phone icons);
  - preview appearance `ToggleGroup` (sun, moon);
  - zoom (–, 100% or "Fit", +);
  - focus-canvas icon;
  - inspector toggle icon (`panel-right`).
- The page frame is described in section C. Puck's own outline and highlight colours are pointed at `--primary` through Puck's CSS variables on the canvas wrapper. Studio maps them; the app theme is not touched.

**E6. Data:**
- Navigator:
  - Header "Data" with "+ Record type".
  - Section "This application" holds the module's record types (rows with a database icon and "20 fields" meta).
  - Section "From other applications" holds one collapsible group per source app with a read-only badge.
  - The "Search" footer becomes a row "Search settings" that opens in the canvas.
- Canvas (`studio-data-centre`):
  - Header: record type name (`text-xl`) plus `Tabs`: Fields, Records, Rules, Pipelines, Search.
  - **Fields** tab: a `Table` of name, type (icon plus label), required, used in (count link), with "+ Field" primary. Clicking a row selects it, and the inspector shows the **field editor** in Collapsible groups (General: label, type, required; Choices or Format by type; Access note; Used in).
  - **Records** tab: real-data `Table` (decision 2) with keyset paging.
  - Relationships show as their own section in Fields with link icons.

**E7. Flows:**
- Navigator: "Flows" with "+ Flow" (opens the existing new-flow dialog), sections per owner ("This application", then each module), rows with a workflow icon and trigger meta ("On button", "Before save").
- Canvas: full-bleed flow canvas (D11) with a floating top-left `Card` breadcrumb chip that names the flow and its trigger.
- Inspector:
  - For a step: kind icon and title, "More" menu (Move up, Move down, Remove); groups Settings, Inputs, Description, "Add a step after this one" (`StudioReferencePicker` plus Add), Used in.
  - For the flow (pane click): name, trigger editor, owner.

**E8. Access:**
- Navigator:
  - "Access" with a "+ Role" `Popover` holding an inline name `Input` and Add. This replaces the always-visible "New role" field.
  - Section "Roles": rows with a shield icon, name, and meta "19 permissions"; the default member role shows a `Badge outline` "Default".
  - Section "Across the application": Pages and menu, Permissions.
- Canvas (role editor, `max-w-4xl`):
  - Header: role name (`text-xl`, inline-editable `Input` on click), with outline "Preview as Members" and a "More" menu (Make default, Remove role) on the right.
  - "Starts on" field.
  - Then `Card`-less sections with `text-base` headings: "Records" (matrix, D10), "Pages" (matrix), "Menu".
  - The default-member explanation becomes an `Alert variant="info"` only on the default role, one line.

**E9. Theme:**
- Navigator (22 rem): the shadcn create dimensions as compact groups.
  - Style: a 2-column grid of tiles (`rounded-lg border p-2`, mini preview, name, selected `ring-2 ring-primary`).
  - Base and Theme colour: swatch `RadioGroup` (size-7 circles, 2 px ring on selected, `aria-label` with the colour name).
  - Radius: `ToggleGroup`.
  - Fonts: `NativeSelect`.
  - Menu: `ToggleGroup`.
  - One-line hints and the preset code in a bottom "Preset code" `Collapsible` with a copy button and a paste `InputGroup`.
- The canvas shows the live page in the selected theme (unchanged mechanism).

**E10. Releases:**
- Navigator: two-line rows (D3): Published versions, Page adoption, Import from source (an "Advanced" `Badge outline`). The footer shows the draft state chip instead of a sentence.
- Canvas **Published versions**: a timeline list (`rounded-xl border divide-y`) with version badge, date, author and summary; a "More" menu with "Restore into draft" (AlertDialog confirm). The empty state is "No versions yet. Publish to create version 1."
- **Publish dialog** (`studio-publish-dialog.tsx`, `Dialog max-w-xl`):
  - Title "Publish version N".
  - A summary of what changed (`publication-summary.tsx` as grouped `rounded-lg border divide-y` rows with +/~/– icons in success, info and destructive tones), then the release note `Textarea`.
  - Footer: Cancel (ghost) and **Publish** (default).
  - Success becomes a toast with "Open App Store".
- **Import:**
  - A `Card` with a dashed-border drop zone (`border-2 border-dashed rounded-xl p-8`, upload icon, "Drop an application file or browse", `text-xs muted` "Up to 2 MiB, same application").
  - "Or paste contents" sits in a `Collapsible` holding a `Textarea font-mono`.
  - Actions: "Check the file" (outline), then a diff summary, then "Replace the draft" (default, enabled only after a successful check) and "Clear" (ghost).
  - The result becomes a toast.
- **Page adoption:** a per-page table with a `ToggleGroup` "Keep mine" or "Use standard".

**E11. Preview:**
- "Preview" (outline, top bar) saves and then opens the preview in a new tab (decision 4).
- While starting, the button shows a `Spinner` with "Starting…" and a promise toast resolves to "Preview ready" with an "Open" action if the pop-up was blocked.
- The canvas "View as" plus the appearance toggles are the in-place preview. There is no second preview mode.

---

## F. Implementation plan (8 slices, one PR each)

Each PR is walked in the running app on a freshly reset lane (db2-db5, never :3000). Each PR attaches **before and after screenshots at 1440 × 900 in light and dark** for the listed scenarios, and runs `tooling/theme/off-theme-detector.js` on the Studio frame with zero findings in both modes. `pnpm verify` and `pnpm guard` must pass. No tests are added (owner rule).

**Open PRs that touch Studio files** (checked 19 Oct with `gh pr list`):
- #2975 (forms, workflows, titles): `module-fields-editor`, `studio-data-tab`, `studio-flows-panel`, `studio-new-flow-dialog`, `studio-placement-workflows`, plus ui/studio command files.
- #2974: `actions.ts`.
- #2952: `application-record-pages`, `field-placement`.
- #2943 (boards): `application-draft-agent-tools`, `studio-block-setup-dialog`, `use-studio-canvas-tab`, `studio-setting-controls`, `contextual-palette`, `index.ts`.
- #2941 (query filters): `module-fields-editor`, `studio-flow-value-control`, `studio-query-editor`, `condition-controls`, `condition-literal-editor`, `studio-setting-controls`.
- #2939: `studio-setting-controls`.
- None touches `studio-frame`, `studio-top-bar`, `studio-save-problem`, `document-theme`, `packages/ui/src/components`, the flow canvas, Access, Theme or Releases.

| Slice | Can start | Waits for |
|---|---|---|
| S1 Tokens + shell | Now | Nothing |
| S2 Navigator + home | After S1 | #2975 (`studio-flows-panel`) |
| S3 Inspector forms | After S1 | #2939, #2941, #2943 |
| S4 Flow canvas | After S1, parallel with S2/S5/S6/S7 | Nothing |
| S5 Data tab | After S2 (uses `StudioNavItem` / `StudioSection`) | #2975, #2941 |
| S6 Access + Theme | After S2 | Nothing |
| S7 Releases + Publish + Import | After S2 | Nothing |
| S8 Canvas, Blocks, toolbar, Preview | After S1 | #2943 (`use-studio-canvas-tab`) |

Running in parallel without shared files:
- **S4 alongside any other slice.**
- **S6 alongside S7.**
- **S3 alongside S6 and S7** (S3 owns `studio-inspector`, `studio-field`, `studio-setting-controls` and `studio-flow-*` forms; S6 and S7 do not touch them).
- S2 and S8 share nothing except `studio-frame.tsx`, which belongs to S1 and S2 only. S8 must not edit it.

### S1: Studio theme, tokens and shell
- **Files:**
  - `packages/platform/src/definition/application-composition/theme.ts`: `STUDIO_THEME_SELECTION`.
  - `packages/platform/src/theme/index.ts` (plus server export): `STUDIO_THEME_ROOT` resolved once.
  - The catalogue contrast gate for `ring` (`packages/platform/src/theme/contrast.ts` plus a regenerated `shadcn-create-theme-catalogue.json` with derivations): a separate commit.
  - `apps/web/app/_lib/document-theme.ts`.
  - New `apps/web/app/studio/layout.tsx` (`VortexStyleRoot documentTheme`, `Toaster`, `Tooltip` provider).
  - New `packages/ui/src/components/{tooltip,toggle,toggle-group,kbd}.tsx` plus `package.json` exports if they are listed.
  - `apps/web/app/studio/_components/studio-frame.tsx` (rail groups and indicator, hairline resizer, resizable inspector, focus-canvas, breakpoint widths).
  - `studio-rail-tabs.ts` (groups, widths).
  - `studio-top-bar.tsx` (layout, chip, tooltips, Publish primary, app switcher).
  - New `studio-save-state.tsx` (chip, popover, the two `AlertDialog`s, toast helpers).
  - `application-draft-workspace.tsx` (wire `StudioSaveState`, remove the `status` and `statusLink` props in favour of `toast`).
- **Done when:**
  - `<html>` on `/studio/**` has `data-vortex-style="vega"` and Geist computed on body text.
  - Dialogs and toasts are themed (computed style check).
  - No page-wide banner exists; conflict and session-ended show the dialogs.
  - Chip states all render.
  - The inspector resizes and remembers its width.
  - The 1280, 1440 and 1920 layouts match section C.
  - The app canvas is unchanged: theme, radius and font are computed from the app's selection.
  - The ring is at least 3:1 in light.
- **Walk:**
  1. Open the CRM-like app at 1440, light then dark: Structure tab.
  2. Force a conflict (edit the same draft in two tabs): the dialog appears, then "Load the latest draft".
  3. Sign out in another tab, then edit: the session dialog appears; sign in again and the change retries.
  4. Publish: dialog, then toast.
  5. Resize both panes, reload, and confirm the widths are kept.
  6. Repeat at 1280 and 1920.
- **Delete:** see G-S1.

### S2: Navigator patterns and Studio home
- **Files:**
  - `studio-frame.tsx` (`StudioPanelShell` rewrite, new `StudioSection`).
  - New `studio-nav-tree.tsx` (`StudioNavItem`, `StudioNavTree` on `Item`, with roving-focus tree).
  - `studio-structure-editor.tsx`, `studio-outline.tsx`, `studio-outline-panels.tsx`, `studio-data-panel.tsx`, `studio-flows-panel.tsx`, `studio-releases-panel.tsx`, `studio-menu-panel.tsx`, `use-studio-structure-tab.tsx`.
  - Access navigator portion of `studio-access-tab.tsx`: **only the navigator list**. S6 owns the canvas editor files.
  - `apps/web/app/studio/page.tsx`, `apps/web/app/studio/[organizationId]/page.tsx`, `[organizationId]/new/page.tsx`.
  - New `apps/web/app/studio/_components/studio-home.tsx`.
- **Done when:**
  - Every navigator uses `StudioPanelShell`, `StudioSection` and `StudioNavItem`.
  - Trees work with arrow keys.
  - Selected rows use the accent role.
  - Home shows the card grid with icon, description, edited time and published badge, and pages with keyset paging (40).
- **Walk:**
  1. Home, light and dark.
  2. Structure: add a page through "+ Add", select it, then keyboard-walk the tree.
  3. Data navigator with a read-only group.
  4. Flows navigator.
  5. Releases navigator.
  6. Access roles list.

### S3: Inspector forms
- **Files:**
  - `studio-inspector.tsx`, `studio-field.tsx`.
  - `packages/ui/src/studio/studio-setting-controls.tsx`.
  - New `packages/ui/src/studio/studio-reference-picker.tsx` (`Combobox`).
  - `studio-flow-inspector.tsx`, `studio-flow-step-form.tsx`, `studio-flow-start-editor.tsx`, `studio-flow-value-control.tsx`, `studio-flow-calculation.tsx`, `studio-calculation-editor.tsx`, `studio-formula-condition.tsx`, `studio-used-in.tsx`, `studio-link-section.tsx`.
  - `packages/ui/src/studio/condition-controls.tsx`, `condition-literal-editor.tsx`.
  - `packages/ui/src/components/technical-details.tsx`: deleted if Studio was its only user; otherwise Studio stops using it.
- **Done when:**
  - The inspector has a header with a "More" menu, Collapsible groups, one-line help with tooltips, no "(required)", `Optional` marks, and reference pickers searchable.
  - "Details" is at the bottom.
  - Long help (more than 80 characters) does not appear inline anywhere in the inspector (grep check on hint strings).
- **Walk:**
  1. Select an app, a page, a block, a flow step (Save record) and a flow start.
  2. Change a reference through the picker.
  3. Trigger a located refusal (duplicate alias): `FieldError` at the field, chip "Not saved".
  4. Do all of it with the keyboard only.

### S4: Flow canvas
- **Files:**
  - `packages/ui/src/studio/studio-flow-canvas.tsx` (new `StudioFlowNode`, edges, handles, controls, `colorMode`, add-on-edge).
  - `apps/web/app/studio/_components/use-studio-flows-tab.tsx` (pass the appearance and the add-step handler).
- **Done when:**
  - Nodes match D11 in light and dark, with no white nodes in dark.
  - The selected ring is primary.
  - Branch labels are pills.
  - Edge "+" opens the add-step picker and adds the step.
- **Walk:**
  1. Open "New opportunity": select Start, If, Stop and Save record.
  2. Add a step from an edge.
  3. Zoom controls.
  4. Light and dark.

### S5: Data tab
- **Files:** `studio-data-centre.tsx`, `studio-data-tab.tsx`, `module-fields-editor.tsx`, `studio-record-type-dialog.tsx`, `studio-relationships-section.tsx`, `studio-record-rules.tsx`, `studio-record-pipelines.tsx`, `studio-query-editor.tsx`, `studio-search-settings.tsx`, `studio-total-editor.tsx`, `studio-module-actions.tsx`.
- **Done when:**
  - The record-type header has `Tabs`.
  - The fields `Table` matches D10.
  - The field editor is in the inspector groups.
  - Records use keyset paging.
  - The empty states match D8.
- **Walk:**
  1. Create a record type.
  2. Add three fields (text, choice, link).
  3. Edit a field.
  4. View records.
  5. Open a read-only System Directory type.
  6. Search settings.
  7. Light and dark.

### S6: Access and Theme
- **Files:** `studio-access-role.tsx`, `studio-access-gates.tsx` (and the canvas part of `studio-access-tab.tsx` after S2), `studio-theme-panel.tsx`, `use-studio-menu-theme-tabs.tsx`.
- **Done when:**
  - The access matrices match D10, with the expandable extra-permissions sub-row and full checkbox names.
  - The role header has "More".
  - Theme style tiles, swatches, `ToggleGroup`s and the preset code are collapsible.
  - Zero off-theme elements on the canvas after switching a preset (decision 13).
- **Walk:**
  1. Add a role.
  2. Grant Update on a record type.
  3. Set field access.
  4. Preview as a role.
  5. Switch style, theme colour and radius.
  6. Check the canvas computed styles.
  7. Light and dark.

### S7: Releases, Publish and Import
- **Files:** `use-studio-releases-tab.tsx`, `studio-history-tab.tsx`, `application-release-history.tsx`, `studio-publish-dialog.tsx`, `publication-summary.tsx`, `application-source-import.tsx`, `standard-page-adoption.tsx`.
  - **Delete** the standalone routes `apps/web/app/studio/[organizationId]/[applicationRootId]/history/{page,actions}.ts(x)` and `page-adoption/{page,actions}.ts(x)`, after moving any server action they own into the Releases tab's actions.
  - Repoint every link (home, App Store, emails) to `?tab=releases&section=…`. `git grep "/history"` and `git grep "page-adoption"` must return zero Studio route links.
- **Done when:**
  - The timeline list, Publish dialog with change summary, drop-zone import and toasts all work.
  - The standalone routes are gone and return 404.
- **Walk:**
  1. Publish v1 and v2.
  2. Restore v1.
  3. Import a file: check, diff, replace.
  4. Page adoption choice.
  5. Light and dark.

### S8: Canvas, Blocks, toolbar and Preview
- **Files:**
  - `packages/ui/src/studio/application-page-puck-editor.tsx` (page frame, well, Puck variables mapped to `--primary`, compile-failure inline `Alert`, empty states).
  - `packages/ui/src/studio/studio-block-palette.tsx` (tile grid).
  - `apps/web/app/studio/_components/studio-canvas-toolbar.tsx` (`ToggleGroup`s, Fit zoom, focus-canvas).
  - `use-studio-canvas-tab.tsx` (after #2943).
  - The `studio-block-setup-dialog.tsx` restyle (after #2943).
- **Done when:**
  - The page frame and well match section C.
  - Fit zoom at 1280.
  - Block tiles drag and add.
  - The toolbar uses `ToggleGroup`s with `aria-pressed`.
  - Preview shows a spinner and a promise toast.
  - Zero off-theme elements on the app canvas in light and dark.
- **Walk:**
  1. Open a page at 1280, 1440 and 1920.
  2. Drag a block in.
  3. Switch device, appearance and zoom.
  4. Change View as.
  5. Preview.
  6. Produce a compile error.

---

## G. What to delete (one way only), per slice

- **S1:**
  - The `studio` segment's use of the platform default style in `document-theme.ts` (the platform branch no longer serves `/studio`).
  - `StudioSaveProblem` (`studio-save-problem.tsx`), the whole file.
  - The top bar's inline chip `span` classes, the `status` `<p>` line, the `statusLink` row and their props through `application-draft-workspace.tsx`.
  - The "Publish…" ellipsis label.
  - The `w-1.5 bg-border` resizer bar styling.
  - The fixed `w-80` inspector.
  - The `bg-muted/30` canvas section background (the well moves to S8's frame).
  - The duplicate `h2` pane titles that `StudioPanelShell` will own.
  - Any Studio use of `TechnicalDetails` at the top of the inspector is moved in S3 rather than deleted here.
- **S2:**
  - Every ad hoc pane header and description pair.
  - All `h3.text-xs.font-semibold.uppercase` section headers in Studio.
  - The "button as row" hacks (`h-auto justify-start whitespace-normal` outline buttons) in the Structure, Data, Releases and Access navigators.
  - Tree guide lines (`border-l pl-2/pl-3`).
  - `RootList` and `RootTable` (two app-list renderings), replaced by one `StudioHome`.
  - The "Create an application" underline links.
  - The `size` "Show more" query parameter, replaced by keyset paging.
  - The always-visible "New role" input row (moves to a popover in S2's Access navigator).
- **S3:**
  - `TechnicalDetails` at the top of the inspector, and the component itself if no other user remains (`git grep TechnicalDetails`).
  - The "(required)" and "(optional)" label suffixes.
  - Inline hint paragraphs longer than one line (moved to tooltips).
  - The Move up, Move down and Remove button row, replaced by the "More" menu.
  - Per-editor bespoke reference `NativeSelect`s for authored items, replaced by the one `StudioReferencePicker`.
  - Duplicated label markup (`label.block.space-y-1 > span.text-sm`) in `StudioInspector`'s `LabelsForm`, which moves to `StudioField`.
- **S4:**
  - `CanvasNode` and its `Card size="sm"` markup.
  - `--xy-node-border-radius-default: 0` and the related `themed` overrides that the new node makes obsolete.
  - The default React Flow `Controls` styling (replaced by the custom control stack).
  - The `border border-border` wrapper around the canvas.
- **S5:**
  - The "Choose a record type in the Data panel…" sentences, replaced by `Empty`.
  - Bespoke field-list markup in `module-fields-editor.tsx`, replaced by `Table`.
  - The "Search" footer section in the Data navigator, replaced by the row that opens canvas search settings.
- **S6:**
  - The "Also:" permission line markup.
  - The bordered default-member `div` (`rounded-md border p-3`), replaced by an info `Alert` on the default role only.
  - Theme panel `p.text-xs` per-dimension hint lines beyond one line.
  - The always-open preset code form, which moves to a `Collapsible`.
- **S7:**
  - The standalone history and page-adoption routes and their actions.
  - The plain file `input` plus `Textarea` import layout.
  - The "Imported. Your draft is…" inline status `p`, replaced by a toast.
  - The "Draft: Not saved. Publish a new version with Publish… at the top." sentence in the Releases navigator.
- **S8:**
  - The `overflow-x-auto border border-border bg-muted/30 p-2` canvas wrapper.
  - The plain `p.text-sm.text-muted-foreground` canvas placeholders.
  - The "Light"/"Dark" text button pair and the device button group, replaced by `ToggleGroup`s.
  - Block palette `ul > li` rows, replaced by tiles.

After S8 is merged, run one closing check:
- `git grep -nE "text-\[|rounded-\[|p-\[|#[0-9a-fA-F]{3,6}" apps/web/app/studio packages/ui/src/studio` returns nothing.
- `git grep -n "uppercase" apps/web/app/studio packages/ui/src/studio` returns nothing.
- `pnpm knip` reports no unused Studio exports.
