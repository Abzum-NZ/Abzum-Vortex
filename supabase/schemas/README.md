# Canonical database-function sources

This directory holds the editable source for every baseline function:

```text
supabase/schemas/<schema>/<function>.sql
```

Each file is the complete current definition: the `create function` or `create or replace function`
statement with its full dollar-quoted body, any `comment on function`, the function's
`grant`/`revoke` statements, optionally one owner statement for that function, and nothing else.
The owner statement has this form:

```sql
alter function <schema>.<function>(<argument types>) owner to <role>;
```

It must name the function defined by the file. If it is absent, the recorded owner is `postgres`.
The schema directory names the function's schema and the file name is the function name, both
lowercase SQL identifiers, so one name has one file: do not overload a function name. Keep each
canonical file synchronized with the migration that installs its function.

The 20261014 baseline has 705 functions, each with one canonical file. The 244 files added after
the initial squash copy their definition, owner, comment when present, and privileges from the
baseline without changing the function.

## Migration rule

- A migration that creates a function or changes its definition carries the complete body,
  identical to the canonical file changed in the same commit. No text patching.
- A new function owned by a role is created under `set local role <role>`. A later owner change uses
  `alter function ... owner to <role>`. Commit the canonical owner statement and migration change
  together; review their parity manually.
- An owner-only or privilege-only migration does not repeat the function body. In the same commit,
  change only the canonical owner statement or the function's grant/revoke statements that record
  that migration.
- After the generated baseline, never read a stored definition (`pg_get_functiondef`, `prosrc`,
  `routine_definition`) or edit one with `replace()`. A migration states the code it installs in
  full, as a top-level `create or replace function <schema>.<function>(...)` statement.
- A signature change is an explicit `drop function` of the old signature, then a `create` for the
  new one. `create or replace` with a different argument list would add an overload instead.
- A canonical file is only changed together with the migration that installs the same definition,
  and is removed with the migration that drops its function.
- A later migration may change the function again; an earlier migration is never edited to match.

## Enforcement

`pnpm guard` runs the check in [`tooling/guard/guard.ts`](../../tooling/guard/guard.ts): it compares
each canonical function definition with the latest matching definition found in the ordered
migrations, and rejects non-nil hard-coded UUIDs in new function bodies. The generated baseline's
legacy UUIDs are exempt only while the canonical definition matches that fixed baseline. The
comparison normalizes whitespace. It does not inspect the live database or verify the canonical
file's comment, grants, revokes, owner statement, filename, or one-function-per-file layout. Review
those details manually, including owner and privilege changes. Do not read a stored function
definition (`pg_get_functiondef`, `prosrc`, `routine_definition`) or patch one with `replace()`;
change an argument list only after an explicit `drop function`.

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
