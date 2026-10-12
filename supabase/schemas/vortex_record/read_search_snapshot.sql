create or replace function vortex_record.read_search_snapshot(
  p_record_type_id uuid,
  p_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_organization_id uuid;
  plan jsonb;
  target_meta jsonb;
  release_content jsonb;
  record_type_definition jsonb;
  record_fact jsonb;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid then
    raise exception using errcode = '22023', message = 'Search snapshot selector is invalid';
  end if;

  -- Only the system context of one Application reads a record for indexing,
  -- so a human or public request can never reach this function's result.
  context_value := vortex_context.current_context();
  if context_value ->> 'callerKind' is distinct from 'system'
    or not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Search snapshot requires a system application context';
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;

  plan := vortex_record.resolve_installation_access_plan_internal(
    vortex_module.read_current_system_installation()
  );
  if (plan ->> 'organizationId')::uuid is distinct from context_organization_id
    or (plan ->> 'applicationRootId')::uuid
      is distinct from (context_value ->> 'applicationRootId')::uuid then
    raise exception using errcode = '42501',
      message = 'Search snapshot requires a system application context';
  end if;

  target_meta := plan -> 'recordTypes' -> pg_catalog.lower(p_record_type_id::text);
  if target_meta is null then
    return pg_catalog.jsonb_build_object('outcome', 'record_type_unavailable');
  end if;

  select release.compilation_output #> '{canonical,content}'
  into strict release_content
  from vortex_definition.releases as release
  where release.root_id = (target_meta ->> 'moduleRootId')::uuid
    and release.release_revision = (target_meta ->> 'releaseRevision')::bigint;

  select item.value
  into strict record_type_definition
  from pg_catalog.jsonb_array_elements(release_content -> 'recordTypes') as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);

  -- The row is read whatever its lifecycle state, so a soft-deleted record
  -- yields the state its deletion marker is stored under.
  execute pg_catalog.format(
    'select pg_catalog.jsonb_build_object(
       ''lifecycleState'', stored.lifecycle_state,
       ''concurrencyNumber'', stored.concurrency_number,
       ''ownerOrganizationId'', stored.organisation_id,
       ''applicationRootId'', stored.application_root_id,
       ''fieldValues'', pg_catalog.jsonb_build_object(%s)
     )
     from record_data.%I as stored
     where stored.organisation_id = $1 and stored.record_id = $2',
    target_meta ->> 'valueExpression', target_meta ->> 'table'
  )
  into record_fact
  using context_organization_id, p_record_id;

  if record_fact is null then
    return pg_catalog.jsonb_build_object('outcome', 'record_unavailable');
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'loaded',
    'recordType', record_type_definition,
    'record', record_fact
  );
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

alter function vortex_record.read_search_snapshot(uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.read_search_snapshot(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_search_snapshot(uuid, uuid) to vortex_request;

comment on function vortex_record.read_search_snapshot(uuid, uuid) is
  'System-only search index read: returns the installed record type definition and the stored state of one record of the context organisation, including a soft-deleted record, under the system context of one active Application. Refuses any other caller kind.';
