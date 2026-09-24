# Canonical database-function sources

This directory holds one readable source file per database function, so a migration is never the
only place a live definition can be found:

```text
supabase/schemas/<schema>/<function>.sql
```

Each file is the complete current definition: the `create or replace function` statement with its
full body, followed by the function's `comment on function` and its exact `grant`/`revoke` on that
function. The schema directory names the function's schema and the file name is the function name,
both lowercase SQL identifiers. The file is written to be applied on its own and to match the live
database exactly.

## Migration rule

- A migration that creates or changes a function carries the complete body, identical to the
  canonical file changed in the same commit. No text patching.
- Never read a live definition with `pg_get_functiondef` and never edit one with `replace()`. A
  migration states the code it installs in full.
- A signature change is an explicit `drop function`, then a `create` for the new signature.
- A canonical file is only changed together with the migration that installs the same definition.

## Enforcement

`pnpm boundaries` runs `tooling/boundaries/sql-canonical.mjs`, which fails when:

- a migration timestamped `20260925000000` or later uses `pg_get_functiondef` or patches a
  definition with `replace()`;
- a governed migration defines a function that has no canonical file, or whose body differs from
  its canonical file;
- a governed migration changes a function's signature without an explicit `drop function`;
- a canonical file is not backed by a migration carrying the identical complete definition.

Migrations before `20260925000000` are historical and exempt from these checks.

## Example

`supabase/schemas/vortex_example/do_thing.sql`:

```sql
create or replace function vortex_example.do_thing(p_input text)
returns text
language sql
security definer
set search_path = ''
as $function$
  select p_input;
$function$;

revoke all on function vortex_example.do_thing(text)
  from public, anon, authenticated, service_role;
grant execute on function vortex_example.do_thing(text) to vortex_request;

comment on function vortex_example.do_thing(text) is
  'Returns the supplied input.';
```

The migration that installs the same change quotes the identical `create or replace function`
statement before its grants and comment.
