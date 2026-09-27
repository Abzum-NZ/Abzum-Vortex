create or replace function vortex_file.read_file_for_download(p_file_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  established jsonb := vortex_context.validated_service_context();
  stored vortex_file.file_records%rowtype;
begin
  select candidate.* into stored
  from vortex_file.file_records as candidate
  where candidate.file_id = p_file_id
    and candidate.organization_id = (established ->> 'organizationId')::uuid;
  if not found then
    return null;
  end if;
  return vortex_file.upload_file_record(stored);
end
$function$;

revoke execute on function vortex_file.read_file_for_download(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_file.read_file_for_download(uuid) to vortex_request;

comment on function vortex_file.read_file_for_download(uuid) is
  'Reads the canonical FileRecord of one file of the request organisation.';
