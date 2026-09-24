-- #839: restrict who may record and correct metered usage.
--
-- `vortex_access.record_metering_event` is granted to `vortex_request` and runs
-- under whatever request context the transaction established. Its scope check
-- only compared tenant, correlation and - when the caller supplied one - the
-- organisation, so any request context could:
--   * record a non-web source such as `system` or `federation`, and
--   * file an `increase`/`decrease` correction,
-- while passing `p_organization_id = null` dropped an organisation-scoped
-- event to tenant-only attribution.
--
-- The function has a single live definition (`20260923210000`) and no later
-- in-place rewrite, so its reviewed scope fragment is patched in place from
-- `pg_get_functiondef`: the fragment must occur exactly once or the migration
-- aborts rather than silently skipping. It is re-created under its own current
-- owner, so its OID, grants, comment, security and search_path stay put.
--
-- Two changes, with no new grant and no change to the event contents:
--   * Only a system context may record a non-web source or a correction, so
--     request code cannot fabricate system/federation usage or reduce recorded
--     usage.
--   * The event's organisation must equal the context organisation whenever the
--     context has one, so an organisation-scoped request cannot fall back to
--     tenant-only attribution.

begin;

do $migration$
declare
  scope_old constant text := $q$  if (established ->> 'tenantId')::uuid is distinct from p_tenant_id
    or (p_organization_id is not null
      and (established ->> 'organizationId')::uuid is distinct from p_organization_id)
    or (established ->> 'correlationId')::uuid is distinct from p_correlation_id then
    raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
  end if;
$q$;
  scope_new constant text := $q$  if (established ->> 'tenantId')::uuid is distinct from p_tenant_id
    or (established ->> 'organizationId')::uuid is distinct from p_organization_id
    or (established ->> 'correlationId')::uuid is distinct from p_correlation_id then
    raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
  end if;
  -- Corrections and non-web sources are system operations. A human, federated
  -- or public request context can never fabricate system/federation usage or
  -- reduce recorded usage.
  if (established ->> 'callerKind') is distinct from 'system'
    and (p_source <> 'web' or p_corrects_metering_event_id is not null) then
    raise exception using errcode = '42501',
      message = 'Metering event authority is unavailable';
  end if;
$q$;

  procedure_id constant pg_catalog.regprocedure :=
    'vortex_access.record_metering_event(uuid,uuid,text,uuid,text,numeric,text,text,jsonb,timestamptz,uuid,text,uuid,uuid,text)'::pg_catalog.regprocedure;
  definition text;
  occurrences integer;
  owner_name name;
begin
  definition := pg_catalog.pg_get_functiondef(procedure_id);
  if definition is null then
    raise exception using errcode = '55000',
      message = 'Metering event recorder is unavailable',
      detail = procedure_id::text;
  end if;
  occurrences := (
    pg_catalog.length(definition)
    - pg_catalog.length(pg_catalog.replace(definition, scope_old, ''))
  ) / pg_catalog.length(scope_old);
  if occurrences <> 1 then
    raise exception using errcode = '55000',
      message = 'Metering event authority patch does not match exactly once',
      detail = procedure_id::text;
  end if;
  definition := pg_catalog.replace(definition, scope_old, scope_new);

  -- Re-created under the function's own current owner so its grants, comment
  -- and OID stay put.
  select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
  from pg_catalog.pg_proc as procedure
  where procedure.oid = procedure_id;
  execute pg_catalog.format('set local role %I', owner_name);
  execute definition;
  reset role;
end
$migration$;

commit;
