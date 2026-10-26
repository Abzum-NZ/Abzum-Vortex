create or replace function vortex_access.platform_permission_id(p_permission_key text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  found_id uuid;
begin
  select declaration.permission_id into found_id
  from vortex_access.platform_permission_declarations as declaration
  where declaration.owner_kind = 'platform'
    and declaration.permission_key = p_permission_key;
  if found_id is null then
    raise exception using errcode = '55000',
      message = 'Platform permission is not declared';
  end if;
  return found_id;
end
$function$;

alter function vortex_access.platform_permission_id(text) owner to vortex_owner;
revoke all on function vortex_access.platform_permission_id(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.platform_permission_id(text) to vortex_owner;
comment on function vortex_access.platform_permission_id(text) is
  'The identity of one declared platform permission, by its key.';
