create or replace function vortex_access.resolve_search_index_scope(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns table (
  system_actor_id uuid,
  tenant_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  resolved_tenant_id uuid;
  resolved_access_version bigint;
  dispatcher jsonb;
begin
  if p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null
    or not vortex_context.is_non_nil_uuid(p_application_root_id::text) then
    raise exception using errcode = '22023', message = 'Search index scope selection is invalid';
  end if;

  -- The organisation and its access version are share-locked before the
  -- dispatcher grant is read, in the request resolver's Access-first order.
  select organization.tenant_id, version.current_version
  into resolved_tenant_id, resolved_access_version
  from vortex_identity.organizations as organization
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  join vortex_access.organization_access_versions as version
    on version.organization_id = organization.organization_id
  where organization.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of organization, tenant, version;

  if resolved_tenant_id is null
    or not exists (
      select 1
      from vortex_definition.roots as root
      where root.root_id = p_application_root_id
        and root.kind = 'application'
        and root.organization_id = p_organization_id
    ) then
    raise exception using errcode = '42501', message = 'Search index scope is unavailable';
  end if;

  -- Indexing runs inside event dispatch, so the actor is the dispatcher's own
  -- platform-wide system actor grant; nothing the caller supplies names it.
  dispatcher := vortex_access.resolve_event_dispatcher_actor();
  if dispatcher ->> 'outcome' is distinct from 'authorised' then
    raise exception using errcode = '42501', message = 'Search index scope is unavailable';
  end if;

  return query select (dispatcher ->> 'systemActorId')::uuid, resolved_tenant_id,
    resolved_access_version;
end
$function$;

revoke all on function vortex_access.resolve_search_index_scope(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.resolve_search_index_scope(uuid, uuid)
  to vortex_runtime;

comment on function vortex_access.resolve_search_index_scope(uuid, uuid) is
  'Resolves the tenant, access version and the event dispatcher''s system actor for one active organisation Application, so the search consumer can read a record under a system context. Refuses for an inactive organisation, a foreign Application or a missing or ambiguous dispatcher grant. Runtime-only.';

set local role vortex_module_owner;

grant execute on function vortex_module.read_active_installation_for_scope_internal(uuid, uuid)
  to vortex_record_adapter;

reset role;

set local role vortex_record_adapter;

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
    vortex_module.read_active_installation_for_scope_internal(
      context_organization_id, (context_value ->> 'applicationRootId')::uuid
    )
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

  -- A record type that is a system projection has no stored row to read; the
  -- caller still receives its definition to see that nothing is searchable.
  return pg_catalog.jsonb_build_object(
    'outcome', case when record_fact is null then 'record_unavailable' else 'loaded' end,
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

reset role;
