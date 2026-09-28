create or replace function vortex_access.read_flow_run_as_principal_for_run(
  p_execution_binding_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_release_version text,
  p_flow_id uuid
)
returns table (
  outcome text,
  result jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  current_principal vortex_access.flow_run_as_principals%rowtype;
  actor_state text;
begin
  if p_execution_binding_id is null or not vortex_context.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_release_version is null
    or p_release_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or p_flow_id is null or not vortex_context.is_non_nil_uuid(p_flow_id::text) then
    raise exception using errcode = '22023', message = 'Flow run-as principal read command is invalid';
  end if;

  -- Share-lock the exact current revision. A concurrent replace or revoke either commits first
  -- and becomes the row this statement sees, or waits until this run has established its actor.
  for attempt in 1..2 loop
    select principal.* into current_principal
    from vortex_access.flow_run_as_principals as principal
    where principal.execution_binding_id = p_execution_binding_id
      and principal.organization_id = p_organization_id
      and principal.application_root_id = p_application_root_id
      and principal.release_version = p_release_version
      and principal.flow_id = p_flow_id
      and principal.is_current
    for share;
    exit when found;
  end loop;

  if current_principal.execution_binding_id is null
    or current_principal.state <> 'active'
    or (current_principal.expires_at is not null
      and current_principal.expires_at <= pg_catalog.clock_timestamp()) then
    return query select 'unavailable'::text, null::jsonb;
    return;
  end if;

  -- Keep lifecycle changes ordered with a concurrent account suspension or closure.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = current_principal.organization_id
  for share of version;
  if not found then
    return query select 'unavailable'::text, null::jsonb;
    return;
  end if;

  if current_principal.actor_kind = 'specified_account' then
    select account.state into actor_state
    from vortex_identity.organization_accounts as account
    where account.organization_account_id = current_principal.actor_organization_account_id
      and account.organization_id = current_principal.organization_id
    for share of account;
    if actor_state is distinct from 'active' then
      return query select 'unavailable'::text, null::jsonb;
      return;
    end if;
  else
    select actor_grant.state into actor_state
    from vortex_access.system_actor_grants as actor_grant
    where actor_grant.system_actor_id = current_principal.actor_system_actor_id
      and actor_grant.organization_id = current_principal.organization_id
      and (actor_grant.flow_id is null or actor_grant.flow_id = current_principal.flow_id)
      and actor_grant.state = 'active'
    order by (actor_grant.flow_id = current_principal.flow_id) desc
    limit 1
    for share of actor_grant;
    if actor_state is distinct from 'active' then
      return query select 'unavailable'::text, null::jsonb;
      return;
    end if;
  end if;

  if not exists (
    select 1 from vortex_identity.organizations as organization
    where organization.organization_id = current_principal.organization_id
      and organization.state = 'active'
  ) then
    return query select 'unavailable'::text, null::jsonb;
    return;
  end if;

  if current_principal.expires_at is not null
    and current_principal.expires_at <= pg_catalog.clock_timestamp() then
    return query select 'unavailable'::text, null::jsonb;
    return;
  end if;

  return query select 'available'::text,
    vortex_access.flow_run_as_principal_to_json_internal(current_principal);
end
$function$;

revoke all on function vortex_access.read_flow_run_as_principal_for_run(
  uuid, uuid, uuid, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_access.read_flow_run_as_principal_for_run(
  uuid, uuid, uuid, text, uuid
) to vortex_runtime;

comment on function vortex_access.read_flow_run_as_principal_for_run(
  uuid, uuid, uuid, text, uuid
) is
  'Runtime-only, exact-scope read of an active flow run-as principal; revoked, expired, inactive or unregistered actors return unavailable.';
