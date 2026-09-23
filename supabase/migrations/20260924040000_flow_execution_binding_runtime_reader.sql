-- #838: runtime-only, share-locked reader for one flow execution binding.
-- #686 re-verifies the effective actor of a delegated flow node inside the fresh
-- short transaction it opens for that node. That check needs the binding's
-- current stored state without the administrator's access-assignment read
-- permission (an ordinary flow invoker has none) and must be ordered against a
-- concurrent revoke or replace. This adds one Access-owned reader for the
-- vortex_runtime role only: it selects the exact current binding FOR SHARE, so a
-- register/replace/revoke (which lock the current row FOR UPDATE) either commits
-- first and is seen here or waits until this transaction ends, and it shares the
-- organisation access version and then the effective person's organisation
-- account row (main's Access-first order) so a concurrent suspension or closure
-- is ordered the same way. It performs no administration, returns no
-- write path and leaves read_flow_execution_binding and #687 untouched.

begin;

create function vortex_access.read_flow_execution_binding_for_run(
  p_execution_binding_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_release_version text,
  p_flow_id uuid,
  p_node_id uuid,
  p_operation_owner_kind text,
  p_operation_owner_id uuid,
  p_operation_id uuid,
  p_actor_kind text,
  p_actor_account_id uuid,
  p_actor_system_actor_id uuid
)
returns table (
  outcome text,
  effective_state text,
  actor_state text,
  result jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  current_binding vortex_access.flow_execution_bindings%rowtype;
  account_state text;
begin
  if p_execution_binding_id is null or not vortex_context.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_release_version is null
    or p_release_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or p_flow_id is null or not vortex_context.is_non_nil_uuid(p_flow_id::text)
    or p_node_id is null or not vortex_context.is_non_nil_uuid(p_node_id::text)
    or p_operation_owner_kind is null
    or p_operation_owner_kind not in ('application', 'module', 'platform_service')
    or p_operation_owner_id is null or not vortex_context.is_non_nil_uuid(p_operation_owner_id::text)
    or p_operation_id is null or not vortex_context.is_non_nil_uuid(p_operation_id::text)
    or p_actor_kind is null or p_actor_kind not in ('specified_user', 'system')
    or (p_actor_kind = 'specified_user' and (
      p_actor_account_id is null or not vortex_context.is_non_nil_uuid(p_actor_account_id::text)
      or p_actor_system_actor_id is not null))
    or (p_actor_kind = 'system' and (
      p_actor_system_actor_id is null or not vortex_context.is_non_nil_uuid(p_actor_system_actor_id::text)
      or p_actor_account_id is not null)) then
    raise exception using errcode = '22023', message = 'Flow execution binding run read command is invalid';
  end if;

  -- Share-lock the current revision. A writer that is mid-replace or mid-revoke
  -- holds the row FOR UPDATE, so this waits for it. Once that writer commits the
  -- row is no longer current for this statement's re-check and is skipped; the
  -- next statement takes a fresh snapshot and finds the new current revision.
  for attempt in 1..2 loop
    select binding.* into current_binding
    from vortex_access.flow_execution_bindings as binding
    where binding.execution_binding_id = p_execution_binding_id
      and binding.organization_id = p_organization_id
      and binding.is_current
      and binding.application_root_id = p_application_root_id
      and binding.release_version = p_release_version
      and binding.flow_id = p_flow_id
      and binding.node_id = p_node_id
      and binding.operation_owner_kind = p_operation_owner_kind
      and binding.operation_owner_id = p_operation_owner_id
      and binding.operation_id = p_operation_id
      and binding.actor_kind = p_actor_kind
      and binding.actor_organization_account_id is not distinct from p_actor_account_id
      and binding.actor_system_actor_id is not distinct from p_actor_system_actor_id
    for share;
    exit when found;
  end loop;

  -- A completed FOR loop overwrites FOUND, so test the selected row itself.
  if current_binding.execution_binding_id is null then
    return query select 'unavailable'::text, null::text, null::text, null::jsonb;
    return;
  end if;

  if current_binding.actor_kind = 'specified_user' then
    -- Ordered against a concurrent suspension or closure of the effective person,
    -- in main's Access-first order: the organisation access-version row before the
    -- Identity account row, as the request resolver and account lifecycle writers
    -- take them. Binding writers lock the binding before the access version, so
    -- taking the binding first above keeps this path consistent with them too.
    perform 1
    from vortex_access.organization_access_versions as version
    where version.organization_id = current_binding.organization_id
    for share of version;

    select account.state into account_state
    from vortex_identity.organization_accounts as account
    where account.organization_account_id = current_binding.actor_organization_account_id
      and account.organization_id = current_binding.organization_id
    for share of account;
    -- Only an active or suspended account in an active organisation keeps its
    -- state; closing, closed, deleted or missing is closed.
    if account_state is distinct from 'suspended' and (
      account_state is distinct from 'active' or not exists (
        select 1 from vortex_identity.organizations as organization
        where organization.organization_id = current_binding.organization_id
          and organization.state = 'active'
      )
    ) then
      account_state := 'closed';
    end if;
  else
    -- No registered system-actor lifecycle exists in storage yet, so a system
    -- actor can never be confirmed active here; it fails closed at use.
    account_state := 'closed';
  end if;

  return query select 'available'::text,
    case
      when current_binding.state = 'revoked' then 'revoked'
      when current_binding.expires_at is not null
        and current_binding.expires_at <= pg_catalog.clock_timestamp() then 'expired'
      else 'active'
    end,
    account_state,
    vortex_access.flow_execution_binding_to_json_internal(current_binding);
end
$function$;

revoke all on function vortex_access.read_flow_execution_binding_for_run(
  uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_access.read_flow_execution_binding_for_run(
  uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid
) to vortex_runtime;

commit;
