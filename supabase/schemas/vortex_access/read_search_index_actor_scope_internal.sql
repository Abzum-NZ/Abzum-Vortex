create or replace function vortex_access.read_search_index_actor_scope_internal(p_occurrence_id uuid, p_claim_cursor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  selected jsonb;
  locked_claim jsonb;
  identity_scope jsonb;
  selected_organization_id uuid;
  selected_application_root_id uuid;
  selected_access_version bigint;
  registration_rows uuid[];
  granted_actor_ids uuid[];
  observed_at timestamptz;
begin
  selected := vortex_event.read_search_index_occurrence_internal(p_occurrence_id,p_claim_cursor);
  selected_organization_id := (selected ->> 'sourceOrganizationId')::uuid;
  selected_application_root_id := (selected ->> 'sequenceApplicationRootId')::uuid;
  -- Access version is first; no mutable Event progress lock is taken by the initial read.
  select version.current_version into selected_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = selected_organization_id
  for share of version;
  if selected_access_version is null then
    raise exception using errcode = '42501', message = 'Search source authority is unavailable';
  end if;
  identity_scope := vortex_identity.read_search_index_organization_scope_internal(
    p_occurrence_id,p_claim_cursor);
  if identity_scope ->> 'organizationId' is distinct from selected_organization_id::text
    or identity_scope ->> 'applicationRootId' is distinct from selected_application_root_id::text then
    raise exception using errcode = '42501', message = 'Search source authority is unavailable';
  end if;
  select pg_catalog.array_agg(matched.registration_owner_id) into registration_rows
  from (select registration.registration_owner_id
    from vortex_access.permission_registrations as registration
    where registration.organization_id = selected_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = selected_application_root_id
      and registration.state = 'active'
    for share of registration) as matched;
  if registration_rows is null or pg_catalog.cardinality(registration_rows) <> 1 then
    raise exception using errcode = '42501', message = 'Search source authority is unavailable';
  end if;
  select pg_catalog.array_agg(matched.system_actor_id) into granted_actor_ids
  from (select actor_grant.system_actor_id
    from vortex_access.system_actor_grants as actor_grant
    where actor_grant.operation_key = 'index_search_documents'
      and actor_grant.organization_id = selected_organization_id
      and actor_grant.flow_id is null
      and actor_grant.scope_key = 'application:' || selected_application_root_id::text
      and actor_grant.state = 'active'
    for share of actor_grant) as matched;
  if granted_actor_ids is null or pg_catalog.cardinality(granted_actor_ids) <> 1 then
    raise exception using errcode = '42501', message = 'Search source authority is unavailable';
  end if;
  locked_claim := vortex_event.validate_search_index_claim_internal(p_occurrence_id,p_claim_cursor);
  observed_at := pg_catalog.clock_timestamp();
  if (locked_claim - 'leaseExpiresAt') is distinct from (selected - 'leaseExpiresAt')
    or (locked_claim ->> 'leaseExpiresAt')::timestamptz <= observed_at then
    raise exception using errcode = '42501', message = 'Search claim is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'systemActorId',granted_actor_ids[1], 'tenantId',identity_scope ->> 'tenantId',
    'organizationId',selected_organization_id,'applicationRootId',selected_application_root_id,
    'accessVersion',selected_access_version,'occurrence',selected -> 'occurrence',
    'storageScope',selected ->> 'storageScope','storageContractId',selected ->> 'storageContractId',
    'sequenceApplicationRootId',selected_application_root_id,
    'observedAt',pg_catalog.to_char(pg_catalog.timezone('UTC',observed_at),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'leaseExpiresAt',locked_claim ->> 'leaseExpiresAt');
end
$function$;
alter function vortex_access.read_search_index_actor_scope_internal(uuid,uuid) owner to vortex_access_owner;
revoke all on function vortex_access.read_search_index_actor_scope_internal(uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner, vortex_event_owner, vortex_search_owner, vortex_access_owner, vortex_identity_owner;
grant execute on function vortex_access.read_search_index_actor_scope_internal(uuid,uuid) to vortex_access_owner;
comment on function vortex_access.read_search_index_actor_scope_internal(uuid,uuid) is 'Private fixed-purpose Search grant and current tenant/organization/Application/version resolver, locked before live Event progress; no registry mutation or fallback actor.';
