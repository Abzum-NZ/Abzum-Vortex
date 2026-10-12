create or replace function vortex_module.read_current_system_installation()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
begin
  checked_context := vortex_definition.validated_system_context();
  if not checked_context ? 'applicationRootId' then
    raise exception using errcode = '22023', message = 'Active Application context is required';
  end if;
  return vortex_module.read_active_installation_for_scope_internal(
    (checked_context ->> 'organizationId')::uuid,
    (checked_context ->> 'applicationRootId')::uuid
  );
end
$function$;

revoke all on function vortex_module.read_current_system_installation()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_module.read_current_system_installation()
  to vortex_record_adapter;

comment on function vortex_module.read_current_system_installation() is
  'Returns the complete exact active Module binding set selected from the validated system context Application, for the Record adapter''s system-only search snapshot read.';
