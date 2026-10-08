create or replace function vortex_access.refresh_system_record_execution_grant_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_flow_id uuid,
  p_system_actor_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  access_version bigint;
  principal vortex_access.flow_run_as_principals%rowtype;
  validated_manifest jsonb;
  has_live_manifest boolean := false;
  actor_registered boolean := false;
  current_grant vortex_access.system_actor_grants%rowtype;
  selected_scope_key text;
  changed_at_value timestamptz;
begin
  if p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_flow_id is null or not vortex_context.is_non_nil_uuid(p_flow_id::text)
    or p_system_actor_id is null or not vortex_context.is_non_nil_uuid(p_system_actor_id::text) then
    raise exception using errcode = '22023',
      message = 'System Record grant refresh scope is invalid';
  end if;

  select version.current_version into access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'System Record grant refresh scope is unavailable';
  end if;

  selected_scope_key := 'application:' || pg_catalog.lower(p_application_root_id::text);
  for principal in
    select stored.*
    from vortex_access.flow_run_as_principals as stored
    where stored.organization_id = p_organization_id
      and stored.application_root_id = p_application_root_id
      and stored.flow_id = p_flow_id
      and stored.actor_kind = 'system'
      and stored.actor_system_actor_id = p_system_actor_id
      and stored.is_current
      and stored.state = 'active'
      and (stored.expires_at is null or stored.expires_at > pg_catalog.clock_timestamp())
    order by stored.execution_binding_id
    for share
  loop
    validated_manifest := vortex_access.system_record_permission_registration_authority_internal(
      'cache_scan',
      pg_catalog.jsonb_build_object(
        'executionBindingId', principal.execution_binding_id,
        'organizationId', principal.organization_id,
        'applicationRootId', principal.application_root_id,
        'releaseVersion', principal.release_version,
        'flowId', principal.flow_id,
        'actorKind', principal.actor_kind,
        'actorId', principal.actor_system_actor_id,
        'organizationAccountId', null,
        'accessVersion', access_version,
        'correlationId', principal.recorded_correlation_id,
        'principalRevision', principal.revision
      ),
      principal.record_permissions,
      null
    );
    if pg_catalog.jsonb_typeof(validated_manifest) = 'array'
      and pg_catalog.jsonb_array_length(validated_manifest) > 0 then
      has_live_manifest := true;
      exit;
    end if;
  end loop;

  select exists (
    select 1
    from vortex_access.system_actor_grants as actor_grant
    where actor_grant.system_actor_id = p_system_actor_id
      and actor_grant.organization_id = p_organization_id
      and (actor_grant.flow_id is null or actor_grant.flow_id = p_flow_id)
      and actor_grant.state = 'active'
  ) into actor_registered;

  select actor_grant.* into current_grant
  from vortex_access.system_actor_grants as actor_grant
  where actor_grant.system_actor_id = p_system_actor_id
    and actor_grant.operation_key = 'record.apply_changes'
    and actor_grant.organization_id = p_organization_id
    and actor_grant.flow_id = p_flow_id
    and actor_grant.scope_key = selected_scope_key
  for update;
  changed_at_value := pg_catalog.statement_timestamp();

  if has_live_manifest and actor_registered then
    if found then
      update vortex_access.system_actor_grants as actor_grant
      set state = 'active', changed_at = changed_at_value
      where actor_grant.system_actor_grant_id = current_grant.system_actor_grant_id
        and (actor_grant.state <> 'active' or actor_grant.changed_at <> changed_at_value);
    else
      insert into vortex_access.system_actor_grants (
        system_actor_grant_id, system_actor_id, operation_key,
        organization_id, flow_id, scope_key, state, granted_at, changed_at
      ) values (
        pg_catalog.gen_random_uuid(), p_system_actor_id, 'record.apply_changes',
        p_organization_id, p_flow_id, selected_scope_key, 'active',
        changed_at_value, changed_at_value
      );
    end if;
  elsif found and current_grant.state <> 'revoked' then
    update vortex_access.system_actor_grants as actor_grant
    set state = 'revoked', changed_at = changed_at_value
    where actor_grant.system_actor_grant_id = current_grant.system_actor_grant_id;
  end if;
end
$function$;

alter function vortex_access.refresh_system_record_execution_grant_internal(
  uuid, uuid, uuid, uuid
) owner to postgres;

revoke all on function vortex_access.refresh_system_record_execution_grant_internal(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.refresh_system_record_execution_grant_internal(
  uuid, uuid, uuid, uuid
) is
  'Recomputes one exact System actor Record execution-purpose cache from all live source-valid principal manifests and never creates an actor or changes another grant tuple.';
