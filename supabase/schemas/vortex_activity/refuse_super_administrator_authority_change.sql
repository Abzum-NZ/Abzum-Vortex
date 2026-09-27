create or replace function vortex_activity.refuse_super_administrator_authority_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception using errcode = '23514',
    message = 'Super-administrator activity authority evidence is immutable';
end
$function$;

revoke all on function vortex_activity.refuse_super_administrator_authority_change()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_activity.refuse_super_administrator_authority_change() is
  'Prevents rewriting or deleting activity evidence that names its super-administrator authority.';
