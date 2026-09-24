-- #853: remove verified-unused database surfaces.
--
-- 1. The organisation invitation access-intent table, its immutability trigger
--    and the four intent-only functions had no caller: only the live no-intent
--    acceptance path remained. Wired as written, that intent surface would let
--    any member invite someone straight into an admin role, so it is removed
--    rather than left to drift. The live
--    `vortex_access.accept_organization_invitation` keeps its grants and is
--    patched in place first, so it no longer reads the dropped table.
-- 2. `vortex_record.is_lifecycle_destination` still carried a URL/SQL clause
--    that can never match: the identifier pattern on the same predicate
--    already rejects every value containing a colon, a slash or a space. The
--    unreachable clause is removed in place.
-- 3. pgTAP is installed by a normal migration in every environment, so its
--    functions carried the default PUBLIC execute privilege. That grant is
--    revoked.

-- 1. Patch the live acceptance function before its table disappears.
--
-- The function body is read from its live definition and the intent-existence
-- check is removed exactly once, so ownership, grants and comments are
-- untouched and drift fails the migration instead of silently editing an
-- unexpected body.
do $migration$
declare
  intent_clause constant text := $q$    or (
      invitation.accepted_at is null
      and exists (
        select 1
        from vortex_access.organization_invitation_access_intents as intent
        where intent.organization_id = invitation.organization_id
          and intent.invitation_id = invitation.invitation_id
      )
    )
$q$;
  procedure_id constant pg_catalog.regprocedure :=
    'vortex_access.accept_organization_invitation(text,uuid,text,text,uuid)'::pg_catalog.regprocedure;
  definition text;
  patched text;
begin
  definition := pg_catalog.pg_get_functiondef(procedure_id);
  if (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, intent_clause, '')))
    <> pg_catalog.length(intent_clause) then
    raise exception using errcode = '55000',
      message = 'Invitation acceptance intent check does not match exactly once',
      detail = procedure_id::text;
  end if;
  patched := pg_catalog.replace(definition, intent_clause, '');
  execute patched;
end
$migration$;

-- 2. Patch the live destination predicate in place.
do $migration$
declare
  unreachable_clause constant text := $q$    and p_value !~* '^https?://|postgres://|select |insert ',
$q$;
  procedure_id constant pg_catalog.regprocedure :=
    'vortex_record.is_lifecycle_destination(text)'::pg_catalog.regprocedure;
  definition text;
  patched text;
begin
  definition := pg_catalog.pg_get_functiondef(procedure_id);
  if (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, unreachable_clause, '')))
    <> pg_catalog.length(unreachable_clause) then
    raise exception using errcode = '55000',
      message = 'Unreachable destination clause does not match exactly once',
      detail = procedure_id::text;
  end if;
  patched := pg_catalog.replace(definition, unreachable_clause, '');
  execute patched;
end
$migration$;

-- 3. Drop the intent surface. The trigger goes first so the function it calls
-- can be dropped without CASCADE.
drop trigger if exists organization_invitation_access_intents_protect
  on vortex_access.organization_invitation_access_intents;

drop function if exists vortex_access.normalize_organization_invitation_access_intent(jsonb);
drop function if exists vortex_access.protect_organization_invitation_access_intent();
drop function if exists vortex_access.coordinate_organization_invitation_with_access_intent(
  text, text, timestamptz, jsonb
);
drop function if exists vortex_access.coordinate_organization_invitation_access_acceptance(
  text, uuid, text, text, uuid
);

drop table if exists vortex_access.organization_invitation_access_intents;

-- 4. PostgreSQL grants EXECUTE on every new function to PUBLIC by default;
-- pgTAP's assertion helpers never needed that grant.
do $migration$
declare
  function_signature pg_catalog.regprocedure;
begin
  for function_signature in
    select proc.oid::pg_catalog.regprocedure
    from pg_catalog.pg_depend as dependency
    join pg_catalog.pg_extension as extension
      on extension.oid = dependency.refobjid
    join pg_catalog.pg_proc as proc
      on proc.oid = dependency.objid
    where extension.extname = 'pgtap'
      and dependency.deptype = 'e'
      and proc.prokind = 'f'
  loop
    execute pg_catalog.format(
      'revoke execute on function %s from public', function_signature
    );
  end loop;
end
$migration$;
