# Canonical database-function sources

This directory holds one readable source file per database function, so a migration is never the
only place a live definition can be found:

```text
supabase/schemas/<schema>/<function>.sql
```

Each file is the complete current definition: the `create or replace function` statement with its
full dollar-quoted body, followed by the function's `comment on function` and its `grant`/`revoke`
on that function, and nothing else. The schema directory names the function's schema and the file
name is the function name, both lowercase SQL identifiers, so one name has one file: do not overload
a function name. The file applies on its own and matches the live database exactly.

## Migration rule

- A migration that creates or changes a function carries the complete body, identical to the
  canonical file changed in the same commit. No text patching.
- Never read a stored definition (`pg_get_functiondef`, `prosrc`, `routine_definition`) and never
  edit one with `replace()`. A migration states the code it installs in full, as a top-level
  `create or replace function <schema>.<function>(...)` statement.
- A signature change is an explicit `drop function` of the old signature, then a `create` for the
  new one. `create or replace` with a different argument list would add an overload instead.
- A canonical file is only changed together with the migration that installs the same definition,
  and is removed with the migration that drops its function.
- A later migration may change the function again; an earlier migration is never edited to match.

## Enforcement

`pnpm boundaries` runs `tooling/boundaries/sql-canonical.mjs`. It replays every migration in
timestamp order to learn each function's live signatures and the definition it was last installed
with. For migrations timestamped `20260925000000` or later it fails when a migration:

- reads a stored function definition or patches one with `replace()`;
- creates a function inside another statement (for example dynamic SQL in a `do` block), or without
  a lowercase schema-qualified name or a dollar-quoted body;
- changes a function's argument list without an explicit `drop function` earlier in the replay.

It also fails when:

- a function last installed by such a migration has no canonical file;
- a canonical file differs from the definition its function was last installed with, has no
  installing migration, or describes a function a later migration drops;
- a canonical file holds anything other than its one definition, comment and privileges.

Migrations before `20260925000000` are historical: they are read but never reported. Functions they
installed gain a canonical file when they are next changed or rebaselined. Session helpers in
`pg_temp` do not persist and have no canonical file.

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
