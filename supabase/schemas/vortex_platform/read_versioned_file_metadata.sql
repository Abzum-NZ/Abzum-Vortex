create or replace function vortex_platform.read_versioned_file_metadata(p_file_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  established jsonb := vortex_platform.validated_service_context();
  stored vortex_platform.file_records%rowtype;
begin
  select candidate.* into stored
  from vortex_platform.file_records as candidate
  where candidate.file_id = p_file_id
    and candidate.organization_id = (established ->> 'organizationId')::uuid;
  if not found then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'revision', stored.metadata_revision,
    'fileRecord', vortex_platform.upload_file_record(stored)
  );
end
$function$;

revoke execute on function vortex_platform.read_versioned_file_metadata(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_platform.read_versioned_file_metadata(uuid) to vortex_request;

comment on function vortex_platform.read_versioned_file_metadata(uuid) is
  'Reads one organization-scoped File metadata revision and its canonical FileRecord projection.';

alter function vortex_platform.read_versioned_file_metadata(uuid) owner to vortex_owner;
