create or replace function vortex_definition.require_system_application_stays_installed_internal()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  -- A platform system Application is never uninstalled (architecture decision 11): detaching its
  -- bindings is allowed only inside a transaction that activates a replacing release, so at
  -- commit it still has an active binding.
  if exists (
      select 1
      from vortex_definition.roots as root
      where root.root_id = new.application_root_id
        and root.application_origin_kind = 'platform_system_application'
    )
    and not exists (
      select 1
      from vortex_module.installation_bindings as binding
      where binding.organization_id = new.organization_id
        and binding.application_root_id = new.application_root_id
        and binding.state = 'active'
    ) then
    raise exception using errcode = '42501',
      message = 'A platform application cannot be uninstalled';
  end if;
  return null;
end
$function$;

alter function vortex_definition.require_system_application_stays_installed_internal()
  owner to vortex_owner;

revoke all on function vortex_definition.require_system_application_stays_installed_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_definition.require_system_application_stays_installed_internal() is
  'Deferred constraint trigger function: a transaction that detaches a platform system Application''s bindings must leave it with an active binding.';
