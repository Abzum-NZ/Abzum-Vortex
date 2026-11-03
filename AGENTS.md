# Vortex: working instructions

Vortex builds business applications from versioned definitions (modules, record types, fields,
relationships, pages, permissions, actions, flows, connections, themes). Generic engines and a
Next.js application render and execute those definitions for many organisations, with access
enforced by the platform and the database.

## One way only

Vortex is a fresh project with no backward compatibility. Every concern has exactly one format, one contract and one code path. Replace contracts and formats in place, convert shipped definitions in the same change, and rebuild existing data with a forward migration. Do not add converters, upgraders, dual readers, compatibility branches, legacy mirrors, or a second way of doing something that already has one. When you find two ways, remove one.

## Layout

| Path                   | Contents                                                                       |
| ---------------------- | ------------------------------------------------------------------------------ |
| `apps/web`             | Next.js application and development setup                                      |
| `packages/platform`    | Domain schemas, server operations and database access                          |
| `packages/ui`          | Shared components and the designer                                             |
| `packages/definitions` | Shipped application and module definitions                                     |
| `supabase`             | Config, `schemas/` (canonical function files), `migrations/`, seed             |
| `workflows/kestra`     | Operational flows and scripts                                                  |
| `tooling`              | Guard checks, off-theme detector, tsconfigs                                    |
| `docs`                 | `specification/` (product), `architecture/` (binding architecture and designs) |

Running the product locally is described in [README.md](README.md). Static checks are `pnpm guard`
(rules in `tooling/guard/config.ts`).

## Rules

The [target architecture](docs/architecture/target-architecture.md) is binding: read it before
changing code. It holds the product rules (one renderer, no business
application names in engines, no absent-setting behaviour, one contract version, loud failures, no
process artefacts), the layout and dependency direction, the database roles, the record write path
and the error rules. In addition:

- No automated tests: do not add test files, test runners or test dependencies.
- The UI is definition-driven: frame, navigation, layout, pages and theme come from definitions.
  Engines only render. Do not hard-code a shell, navigation or theme in an engine.
- Migrations: add a new numbered file under `supabase/migrations`; never edit an applied one.
  When a database function changes, its canonical file in `supabase/schemas` and the migration
  must hold the identical definition.
- A migration that rewrites a stored release (its definition JSON) recomputes that release's `content_fingerprint` and `resolution_fingerprint` in the same migration and states why in its header comment. Prefer rewriting drafts and republishing: a published release stays as released unless a platform fault forces the rewrite.
- Tenant and organisation isolation, current permission checks, atomic writes, revision checks and
  safe errors are product requirements. Preserve them in every change.
- Keep secrets out of files, prompts and logs.
- **shadcn only:** Studio uses shadcn/ui components only, and they take all colour, radius, font,
  spacing and state from the theme (Vortex, organisation or application level) through the `cn-`
  style classes and tokens. Every interactive or structural element in `packages/ui/src/studio`,
  `apps/web/app/studio` and, where Studio uses it, `packages/ui/src/navigation` comes from
  `packages/ui/src/components`: no raw button/input/select/textarea/dialog/details/fieldset/label, no
  local component duplicating a name in `components/`, no class strings recreating a shadcn variant,
  no fixed colours, radii or fonts in Studio code, and no direct imports of a primitive library
  (`@base-ui`, `@radix-ui`, `cmdk`) outside `components/`. Empty states use `Empty`, loading uses
  `Spinner`, and messages use `Alert`. A missing shadcn component is added to `components/` with its
  `cn-` styles first. Exceptions (skip link, hidden or file inputs, the navigation tree) carry a
  comment `// shadcn-only: <reason>` on the line or the line above.
- Reads serve the visible page first. Studio preview may continue an idle background fill after the
  visible page's requested data is served; never prefetch speculatively before it.
- Behaviour changes are exercised in the running app.
