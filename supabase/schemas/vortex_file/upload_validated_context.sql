create or replace function vortex_file.upload_validated_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return vortex_context.validated_service_context();
end
$function$;

revoke execute on function vortex_file.upload_validated_context() from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_file.upload_validated_context() is
  'Returns the established upload context after the shared human or system context validator accepts it.';
