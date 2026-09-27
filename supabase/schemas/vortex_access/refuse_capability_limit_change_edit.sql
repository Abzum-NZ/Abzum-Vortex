create or replace function vortex_access.refuse_capability_limit_change_edit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception using errcode = '55000',
    message = 'Capability limit change evidence is append-only';
end
$function$;

revoke all on function vortex_access.refuse_capability_limit_change_edit()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.refuse_capability_limit_change_edit() is
  'Refuses every update, delete or truncate of capability limit change evidence.';
