create or replace function vortex_record.preview_scoped_command_id_internal(
  p_command_id uuid
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  preview_value jsonb;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Record command identity is invalid';
  end if;
  preview_value := vortex_record.read_current_preview_installation_internal();
  if preview_value is null then
    return p_command_id;
  end if;
  if preview_value ->> 'outcome' is distinct from 'refused' then
    return (pg_catalog.md5(
      (preview_value ->> 'previewInstallationId') || ':' || p_command_id::text
    ))::uuid;
  end if;
  return null;
end
$function$;

alter function vortex_record.preview_scoped_command_id_internal(uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.preview_scoped_command_id_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;
grant execute on function vortex_record.preview_scoped_command_id_internal(uuid)
  to vortex_record_owner, vortex_record_adapter;
comment on function vortex_record.preview_scoped_command_id_internal(uuid) is
  'Derives a deterministic receipt identity inside one validated preview installation so retries stay isolated from live and other preview record commands.';
