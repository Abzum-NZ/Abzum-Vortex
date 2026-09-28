create or replace function vortex_file.claim_file_download_grant(p_one_time_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  established jsonb := vortex_context.validated_service_context();
  request_actor jsonb := vortex_file.upload_request_actor(established);
  claimed vortex_file.download_grants%rowtype;
  stored vortex_file.file_records%rowtype;
begin
  if request_actor is null then
    return null;
  end if;

  select candidate.* into claimed
  from vortex_file.download_grants as candidate
  where candidate.one_time_id = p_one_time_id
    and candidate.organization_id = (established ->> 'organizationId')::uuid
  for update;
  if not found
    or claimed.credential_issued_at is not null
    or claimed.expires_at <= evaluated_at
    or claimed.actor is distinct from request_actor then
    return null;
  end if;

  select candidate.* into stored
  from vortex_file.file_records as candidate
  where candidate.file_id = claimed.file_id
    and candidate.organization_id = claimed.organization_id;
  if not found
    or stored.lifecycle_state <> 'active'
    or stored.scanner_result <> 'clean'
    or stored.owner_record_type_id is distinct from claimed.owner_record_type_id
    or stored.owner_record_id is distinct from claimed.owner_record_id
    or stored.owner_field_id is distinct from claimed.owner_field_id then
    return null;
  end if;

  update vortex_file.download_grants
  set credential_issued_at = evaluated_at
  where one_time_id = claimed.one_time_id;

  return pg_catalog.jsonb_build_object(
    'grant', pg_catalog.jsonb_build_object(
      'kind', 'download',
      'organizationId', claimed.organization_id,
      'actor', claimed.actor,
      'recordTypeId', claimed.owner_record_type_id,
      'recordId', claimed.owner_record_id,
      'fieldId', claimed.owner_field_id,
      'fileId', claimed.file_id,
      'oneTimeId', claimed.one_time_id,
      'expiresAt', vortex_context.format_timestamp_utc(claimed.expires_at)
    ),
    'fileRecord', vortex_file.upload_file_record(stored),
    'correlationId', claimed.correlation_id
  );
end
$function$;

revoke execute on function vortex_file.claim_file_download_grant(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_file.claim_file_download_grant(uuid) to vortex_request;

comment on function vortex_file.claim_file_download_grant(uuid) is
  'Claims an unexpired read grant of the request actor exactly once with its current FileRecord.';

alter function vortex_file.claim_file_download_grant(uuid) owner to vortex_file_owner;
