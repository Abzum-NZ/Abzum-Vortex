create or replace function vortex_identity.suspend_tenant(
  p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid,
  p_command_fingerprint text, p_tenant_id uuid, p_expected_revision bigint
)
returns table (outcome text, operation text, tenant_id uuid, revision bigint,
  correlation_id uuid, accepted_at timestamptz)
language sql volatile security definer set search_path = ''
as $function$
  select * from vortex_identity.apply_configured_tenant_lifecycle(
    'suspend_tenant', p_cluster_id, p_operator_actor_id, p_duplicate_key,
    p_command_fingerprint, p_tenant_id, p_expected_revision
  )
$function$;

revoke execute on function vortex_identity.suspend_tenant(uuid,uuid,uuid,text,uuid,bigint) from public, anon, authenticated, service_role, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.suspend_tenant(uuid,uuid,uuid,text,uuid,bigint) to vortex_runtime;

comment on function vortex_identity.suspend_tenant(uuid,uuid,uuid,text,uuid,bigint) is 'Configured-system-only non-cascading suspension of one active tenant.';

alter function vortex_identity.suspend_tenant(uuid,uuid,uuid,text,uuid,bigint) owner to vortex_identity_owner;
