create or replace function vortex_identity.tenant_request_actor_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
begin
  checked := vortex_context.current_context();
  if checked ->> 'callerKind' is null
    or checked ->> 'callerKind' not in ('human', 'federated')
    or not vortex_context.is_non_nil_uuid(checked ->> 'identityId') then
    raise exception using errcode = '42501', message = 'Tenant request actor is unavailable';
  end if;
  perform vortex_identity.require_identity_not_disabled((checked ->> 'identityId')::uuid);
  return (checked ->> 'identityId')::uuid;
end
$function$;

revoke execute on function vortex_identity.tenant_request_actor_id()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.tenant_request_actor_id() is
  'Returns the acting person from the verified request context for tenant governance, or refuses when the bound context names no human or federated person or that person is disabled.';
