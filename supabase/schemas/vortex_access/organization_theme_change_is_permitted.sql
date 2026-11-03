create or replace function vortex_access.organization_theme_change_is_permitted()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_access.validated_human_request_context();
  -- The organisation theme is an organisation setting: the runtime-settings manage permission decides.
  return vortex_access.organization_runtime_settings_manage_is_current();
end
$function$;

comment on function vortex_access.organization_theme_change_is_permitted() is
  'Whether the validated human organisation context may change the organisation theme, so the editor can show a read-only theme to a member without the permission. The change itself checks the same permission again.';

revoke all on function vortex_access.organization_theme_change_is_permitted()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.organization_theme_change_is_permitted()
  to vortex_request;
alter function vortex_access.organization_theme_change_is_permitted()
  owner to vortex_owner;
grant execute on function vortex_access.organization_theme_change_is_permitted()
  to postgres;
