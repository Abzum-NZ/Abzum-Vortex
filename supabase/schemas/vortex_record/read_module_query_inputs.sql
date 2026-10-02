create or replace function vortex_record.read_module_query_inputs(
  p_module_root_id uuid,
  p_query_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_address text;
  preview_context jsonb;
  resolved jsonb;
begin
  preview_address := nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  );
  if preview_address is not null then
    begin
      preview_context := vortex_record.read_current_preview_installation_internal();
      if preview_context is null
        or pg_catalog.jsonb_typeof(preview_context) is distinct from 'object'
        or preview_context ? 'outcome' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      resolved := vortex_record.resolve_preview_module_query_internal(p_module_root_id, p_query_id);
    exception when others then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
  else
    resolved := vortex_record.resolve_installed_module_query_internal(p_module_root_id, p_query_id);
  end if;
  if resolved is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'resolved',
    'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
    'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
    'inputs', coalesce(resolved #> '{query,inputs}', '[]'::jsonb)
  );
end
$function$;

alter function vortex_record.read_module_query_inputs(uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.read_module_query_inputs(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_module_query_inputs(uuid, uuid)
  to vortex_request;

comment on function vortex_record.read_module_query_inputs(uuid, uuid) is
  'The typed input contract of one installed or exact current human-owned preview Module query, or one refusal.';
