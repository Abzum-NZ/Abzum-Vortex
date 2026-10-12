# Canonical database-function sources

This directory holds one readable source file per database function, so a migration is never the
only place a live definition can be found:

```text
supabase/schemas/<schema>/<function>.sql
```

Each file is the complete current definition: the `create or replace function` statement with its
full dollar-quoted body, the function's `comment on function` and its `grant`/`revoke` on that
function, optionally one owner statement for that function, and nothing else. The owner statement
has this form:

```sql
alter function <schema>.<function>(<argument types>) owner to <role>;
```

It must name the function defined by the file. If it is absent, the recorded owner is `postgres`.
The schema directory names the function's schema and the file name is the function name, both
lowercase SQL identifiers, so one name has one file: do not overload a function name. The file
applies on its own and matches the live database exactly.

## Migration rule

- A migration that creates a function or changes its definition carries the complete body,
  identical to the canonical file changed in the same commit. No text patching.
- A new function owned by a role is created under `set local role <role>`. A later owner change uses
  `alter function ... owner to <role>`. The canonical owner statement and its migration change are
  committed together, and the checker verifies the recorded owner against the migration history.
- An owner-only or privilege-only migration does not repeat the function body. In the same commit,
  change only the canonical owner statement or the function's grant/revoke statements that record
  that migration.
- Never read a stored definition (`pg_get_functiondef`, `prosrc`, `routine_definition`) and never
  edit one with `replace()`. A migration states the code it installs in full, as a top-level
  `create or replace function <schema>.<function>(...)` statement.
- A signature change is an explicit `drop function` of the old signature, then a `create` for the
  new one. `create or replace` with a different argument list would add an overload instead.
- A canonical file is only changed together with the migration that installs the same definition,
  and is removed with the migration that drops its function.
- A later migration may change the function again; an earlier migration is never edited to match.

## Enforcement

There is no automated checker. Reviewers rely on these rules: a function's canonical file under
`supabase/schemas` must stay identical to the definition its latest migration installs, must record
the same owner, and must hold only its one definition, comment, optional owner statement and
privileges. Do not read a stored function definition or patch one with `replace()`; change an
argument list only after an explicit `drop function`. Functions installed by migrations before
`20260925000000` gain a canonical file when they are next changed.

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
