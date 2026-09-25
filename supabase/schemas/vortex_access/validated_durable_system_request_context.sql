create or replace function vortex_access.validated_durable_system_request_context(
  p_operation_key text,
  p_flow_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
begin
  if p_operation_key is null
    or pg_catalog.octet_length(p_operation_key) not between 1 and 128
    or p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_flow_id is null
    or not vortex_context.is_non_nil_uuid(p_flow_id::text) then
    raise exception using errcode = '22023',
      message = 'Durable system actor purpose is invalid';
  end if;

  checked := vortex_context.current_context();
  if checked ->> 'callerKind' is distinct from 'system'
    or checked ->> 'channel' is distinct from 'durable_workflow'
    or checked ? 'supportContext'
    or not checked ? 'applicationRootId'
    or not vortex_context.is_non_nil_uuid(checked ->> 'systemActorId') then
    raise exception using errcode = '42501',
      message = 'Durable system actor context is required';
  end if;

  if not exists (
    select 1
    from vortex_access.organization_access_versions as version
    where version.organization_id = (checked ->> 'organizationId')::uuid
      and version.current_version = (checked ->> 'accessVersion')::bigint
  ) then
    raise exception using errcode = '42501',
      message = 'Request access version is stale or unavailable';
  end if;

  -- The grant is re-read for this exact operation and flow inside the protected
  -- operation's own transaction, so a revocation between resolution and use
  -- refuses instead of running on the earlier read.
  if not exists (
    select 1
    from vortex_identity.organizations as organization
    where organization.organization_id = (checked ->> 'organizationId')::uuid
      and organization.state = 'active'
  ) or vortex_access.resolve_system_actor_grant_internal(
    (checked ->> 'systemActorId')::uuid,
    p_operation_key,
    (checked ->> 'organizationId')::uuid,
    p_flow_id,
    'application:' || pg_catalog.lower(checked ->> 'applicationRootId')
  ) is distinct from 'active' then
    raise exception using errcode = '42501',
      message = 'Durable system actor authority is unavailable';
  end if;

  return checked;
end
$function$;

revoke all on function vortex_access.validated_durable_system_request_context(text, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.validated_durable_system_request_context(text, uuid)
  to vortex_request;

comment on function vortex_access.validated_durable_system_request_context(text, uuid) is
  'Fails closed unless the request context is a system actor context on the durable_workflow channel for an application, its Access version is current and the system actor grant registry still holds an active grant for exactly this actor, operation, organisation, flow and application source.';
