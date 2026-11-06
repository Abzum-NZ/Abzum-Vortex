create or replace function vortex_record.module_query_is_readable_internal(
  p_module_root_id uuid,
  p_query jsonb,
  p_application_root_id uuid
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  -- The one exposure rule of a Module query, applied once the query is found, before anything that
  -- depends on the installation, the record type or its storage, so a refusal never tells a private
  -- query from a missing one: an Application reads a query of a Module it only uses when that
  -- Module exposes it (the rule the Studio picker, the draft compile and publication apply). A
  -- record type's own listing carries its record type's identity and follows record access
  -- instead. It answers true or false, never null: a query without an exposure is private.
  select coalesce(
      pg_catalog.lower(p_query ->> 'queryId') = pg_catalog.lower(p_query #>> '{recordType,recordTypeId}'),
      false
    )
    or p_query ->> 'exposure' is not distinct from 'exposed'
    or exists (
      select 1
      from vortex_definition.roots as root
      where root.root_id = p_module_root_id
        and root.kind = 'module'
        and root.owner_application_root_id = p_application_root_id
    );
$function$;

alter function vortex_record.module_query_is_readable_internal(uuid,jsonb,uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.module_query_is_readable_internal(uuid,jsonb,uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.module_query_is_readable_internal(uuid,jsonb,uuid)
  to vortex_owner;

comment on function vortex_record.module_query_is_readable_internal(uuid,jsonb,uuid) is
  'Private: whether the Application may read one query of a Module (true or false, never null): a record type''s own listing, a query its Module exposes, or any query of a Module the Application owns. The one exposure rule: the installed and preview query resolvers and the grid views'' query lookup apply it.';
