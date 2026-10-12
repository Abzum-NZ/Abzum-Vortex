CREATE FUNCTION vortex_access.read_flow_execution_binding(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_execution_binding_id uuid, p_organization_id uuid, p_application_root_id uuid, p_release_version text, p_flow_id uuid, p_node_id uuid, p_operation_owner_kind text, p_operation_owner_id uuid, p_operation_id uuid, p_actor_kind text, p_actor_account_id uuid, p_actor_system_actor_id uuid) RETURNS TABLE(outcome text, effective_state text, result jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  authority record;
  current_binding vortex_access.flow_execution_bindings%rowtype;
begin
  if p_actor_identity_id is null or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or p_actor_organization_account_id is null
    or not vortex_context.is_non_nil_uuid(p_actor_organization_account_id::text)
    or p_execution_binding_id is null or not vortex_context.is_non_nil_uuid(p_execution_binding_id::text)
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
    raise exception using errcode = '22023', message = 'Flow execution binding read command is invalid';
  end if;

  select granted.* into strict authority
  from vortex_access.flow_execution_binding_authority_internal(
    p_actor_identity_id, p_actor_organization_account_id, p_organization_id, 'read'
  ) as granted;

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
    and binding.actor_system_actor_id is not distinct from p_actor_system_actor_id;

  if not found then
    return query select 'unavailable'::text, null::text, null::jsonb;
    return;
  end if;

  return query select 'available'::text,
    case
      when current_binding.state = 'revoked' then 'revoked'
      when current_binding.expires_at is not null
        and current_binding.expires_at <= pg_catalog.clock_timestamp() then 'expired'
      else 'active'
    end,
    vortex_access.flow_execution_binding_to_json_internal(current_binding);
end
$_$;


ALTER FUNCTION vortex_access.read_flow_execution_binding(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_execution_binding_id uuid, p_organization_id uuid, p_application_root_id uuid, p_release_version text, p_flow_id uuid, p_node_id uuid, p_operation_owner_kind text, p_operation_owner_id uuid, p_operation_id uuid, p_actor_kind text, p_actor_account_id uuid, p_actor_system_actor_id uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.read_flow_execution_binding(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_execution_binding_id uuid, p_organization_id uuid, p_application_root_id uuid, p_release_version text, p_flow_id uuid, p_node_id uuid, p_operation_owner_kind text, p_operation_owner_id uuid, p_operation_id uuid, p_actor_kind text, p_actor_account_id uuid, p_actor_system_actor_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.read_flow_execution_binding(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_execution_binding_id uuid, p_organization_id uuid, p_application_root_id uuid, p_release_version text, p_flow_id uuid, p_node_id uuid, p_operation_owner_kind text, p_operation_owner_id uuid, p_operation_id uuid, p_actor_kind text, p_actor_account_id uuid, p_actor_system_actor_id uuid) TO vortex_request;
