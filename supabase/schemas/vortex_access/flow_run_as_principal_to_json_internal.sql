create or replace function vortex_access.flow_run_as_principal_to_json_internal(
  p_principal vortex_access.flow_run_as_principals
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'executionBindingId', p_principal.execution_binding_id,
    'organizationId', p_principal.organization_id,
    'applicationRootId', p_principal.application_root_id,
    'releaseVersion', p_principal.release_version,
    'flowId', p_principal.flow_id,
    'actor', case p_principal.actor_kind
      when 'specified_account' then pg_catalog.jsonb_build_object(
        'kind', 'specified_account',
        'organizationAccountId', p_principal.actor_organization_account_id)
      else pg_catalog.jsonb_build_object(
        'kind', 'system', 'systemActorId', p_principal.actor_system_actor_id)
    end,
    'state', p_principal.state,
    'revision', p_principal.revision,
    'recordedAt', vortex_context.format_timestamp_utc(p_principal.recorded_at)
  )
  || case when p_principal.expires_at is null then '{}'::jsonb else pg_catalog.jsonb_build_object(
    'expiresAt', vortex_context.format_timestamp_utc(p_principal.expires_at)) end
  || case when p_principal.revoked_at is null then '{}'::jsonb else pg_catalog.jsonb_build_object(
    'revokedAt', vortex_context.format_timestamp_utc(p_principal.revoked_at)) end
$function$;

revoke all on function vortex_access.flow_run_as_principal_to_json_internal(
  vortex_access.flow_run_as_principals
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.flow_run_as_principal_to_json_internal(
  vortex_access.flow_run_as_principals
) is
  'Projects one stored flow run-as principal revision into its canonical JSON form.';
