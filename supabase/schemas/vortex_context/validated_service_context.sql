create or replace function vortex_context.validated_service_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  established jsonb := vortex_context.current_context();
begin
  case established ->> 'callerKind'
    when 'human' then
      return vortex_access.validated_human_request_context();
    when 'system' then
      return vortex_definition.validated_system_context();
    else
      raise exception using
        errcode = '42501',
        message = 'Request requires a validated human or system context';
  end case;
end
$function$;

revoke execute on function vortex_context.validated_service_context()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_context.validated_service_context()
  to vortex_connection_owner;

comment on function vortex_context.validated_service_context() is
  'Dispatches an established request context through the authoritative human or system validator.';
