create or replace function vortex_identity.stage_organization_runtime_settings_update(
  p_settings jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_settings is null or pg_catalog.jsonb_typeof(p_settings) <> 'object'
    or not p_settings ?& array[
      'organizationId', 'language', 'timeZone', 'currency', 'dateFormat',
      'numberFormat', 'revision'
    ]
    or p_settings - array[
      'organizationId', 'language', 'timeZone', 'currency', 'dateFormat',
      'numberFormat', 'revision'
    ] <> '{}'::jsonb then
    raise exception using errcode = '22023',
      message = 'Organization runtime settings staging is invalid';
  end if;

  insert into vortex_identity.organization_runtime_settings_update_staging as staged (
    backend_pid, transaction_id, settings
  ) values (
    pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), p_settings
  ) on conflict on constraint organization_runtime_settings_update_staging_pk do update
    set transaction_id = excluded.transaction_id, settings = excluded.settings
    where staged.transaction_id <> excluded.transaction_id;
  if not found then
    raise exception using errcode = '55000',
      message = 'Organization runtime settings update is already staged';
  end if;
end
$function$;

revoke all on function vortex_identity.stage_organization_runtime_settings_update(jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.stage_organization_runtime_settings_update(jsonb) to vortex_runtime;

comment on function vortex_identity.stage_organization_runtime_settings_update(jsonb) is null;

alter function vortex_identity.stage_organization_runtime_settings_update(jsonb) owner to vortex_identity_owner;
