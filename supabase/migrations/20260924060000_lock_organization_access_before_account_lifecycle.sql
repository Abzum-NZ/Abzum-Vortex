-- #841: account lifecycle wrappers take the organisation access lock first.
--
-- Invitation acceptance (vortex_access.accept_organization_invitation) locks the
-- organisation's `organization_access_versions` row, then the account row.
-- The administration wrappers that suspend, close, reactivate and begin closing
-- an account locked the account row first and only reached the access version
-- row later, inside `change_organization_account_state` (suspend, close,
-- reactivate) or an explicit later lock (begin closing). An acceptance and a
-- lifecycle change on the same account therefore waited on each other and
-- PostgreSQL aborted one with 40P01.
--
-- Each wrapper now locks the access version row immediately before it locks the
-- account row, so both paths acquire access version, then account. Nothing else
-- about the lifecycle changes: the same rows are locked, the same checks run in
-- the same order and the same errors are raised.
--
-- The four functions are patched in place from their live definitions with an
-- exactly-once guard, so ownership, grants and comments are untouched and drift
-- fails the migration instead of silently editing an unexpected body.
do $migration$
declare
  account_select constant text := $q$  select account.state, account.revision into target
  from vortex_identity.organization_accounts as account
  where account.organization_id = scope.organization_id
    and account.organization_account_id = p_organization_account_id
  for update;$q$;
  version_lock constant text := $q$  -- Lock order: organization access version, then the account row, the same
  -- order invitation acceptance uses.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id
  for update;
$q$;
  late_version_lock constant text := $q$  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id
  for update;

$q$;
  procedure_id pg_catalog.regprocedure;
  definition text;
  patched text;
  replaced_late_lock boolean;
begin
  foreach procedure_id in array array[
    'vortex_access.suspend_organization_account_for_administration(uuid,uuid,bigint)'::pg_catalog.regprocedure,
    'vortex_access.close_organization_account_for_administration(uuid,uuid,bigint)'::pg_catalog.regprocedure,
    'vortex_access.reactivate_organization_account_for_administration(uuid,uuid,bigint)'::pg_catalog.regprocedure,
    'vortex_access.begin_organization_account_closing_for_administration(uuid,bigint)'::pg_catalog.regprocedure
  ]
  loop
    definition := pg_catalog.pg_get_functiondef(procedure_id);
    replaced_late_lock := procedure_id =
      'vortex_access.begin_organization_account_closing_for_administration(uuid,bigint)'::pg_catalog.regprocedure;

    if (pg_catalog.length(definition)
        - pg_catalog.length(pg_catalog.replace(definition, account_select, '')))
        <> pg_catalog.length(account_select)
      or pg_catalog.strpos(definition, version_lock) <> 0 then
      raise exception using errcode = '55000',
        message = 'Account lifecycle lock order patch does not match exactly once',
        detail = procedure_id::text;
    end if;
    patched := pg_catalog.replace(definition, account_select, version_lock || account_select);

    if replaced_late_lock then
      -- begin_organization_account_closing_for_administration already locked
      -- the access version row, but after the account row. Move it, do not
      -- take it twice.
      if (pg_catalog.length(patched)
          - pg_catalog.length(pg_catalog.replace(patched, late_version_lock, '')))
          <> pg_catalog.length(late_version_lock) then
        raise exception using errcode = '55000',
          message = 'Account lifecycle lock order patch does not match exactly once',
          detail = procedure_id::text;
      end if;
      patched := pg_catalog.replace(patched, late_version_lock, '');
    end if;

    execute patched;
  end loop;
end
$migration$;
