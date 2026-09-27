create or replace function vortex_access.flow_execution_binding_to_json_internal(
  b vortex_access.flow_execution_bindings
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'executionBindingId', b.execution_binding_id,
    'organizationId', b.organization_id,
    'applicationRootId', b.application_root_id,
    'releaseVersion', b.release_version,
    'flowId', b.flow_id,
    'nodeId', b.node_id,
    'operation', pg_catalog.jsonb_build_object(
      'owner', case b.operation_owner_kind
        when 'application' then pg_catalog.jsonb_build_object(
          'kind', 'application', 'applicationRootId', b.operation_owner_id)
        when 'module' then pg_catalog.jsonb_build_object(
          'kind', 'module', 'moduleRootId', b.operation_owner_id)
        else pg_catalog.jsonb_build_object(
          'kind', 'platform_service', 'serviceId', b.operation_owner_id)
      end,
      'operationId', b.operation_id
    ),
    'actor', case b.actor_kind
      when 'specified_user' then pg_catalog.jsonb_build_object(
        'kind', 'specified_user', 'organizationAccountId', b.actor_organization_account_id)
      else pg_catalog.jsonb_build_object('kind', 'system', 'systemActorId', b.actor_system_actor_id)
    end,
    'permittedInvokers', b.permitted_invokers,
    'permittedSurfaces', b.permitted_surfaces,
    'permittedInputs', b.permitted_inputs,
    'state', b.state,
    'revision', b.revision,
    'recordedAt', vortex_context.format_timestamp_utc(b.recorded_at)
  )
  || case when b.expires_at is null then '{}'::jsonb else pg_catalog.jsonb_build_object(
    'expiresAt', vortex_context.format_timestamp_utc(b.expires_at)) end
  || case when b.revoked_at is null then '{}'::jsonb else pg_catalog.jsonb_build_object(
    'revokedAt', vortex_context.format_timestamp_utc(b.revoked_at)) end
$function$;

revoke all on function vortex_access.flow_execution_binding_to_json_internal(vortex_access.flow_execution_bindings) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.flow_execution_binding_to_json_internal(vortex_access.flow_execution_bindings) is
  'Projects one stored flow execution binding into its canonical JSON form.';
