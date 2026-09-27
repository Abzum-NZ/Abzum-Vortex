create or replace function vortex_file.claim_file_upload_grant(p_one_time_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  established jsonb := vortex_file.upload_validated_context();
  request_actor jsonb := vortex_file.upload_request_actor(established);
  claimed_file_id uuid;
  reservation vortex_file.upload_reservations%rowtype;
  claimed vortex_file.upload_grants%rowtype;
  uploaded vortex_file.file_records%rowtype;
begin
  select candidate.file_id into claimed_file_id
  from vortex_file.upload_grants as candidate
  where candidate.one_time_id = p_one_time_id
    and candidate.organization_id = (established ->> 'organizationId')::uuid;
  if not found or request_actor is null then
    return null;
  end if;

  -- Reservation first, then grant: the same order renewal and completion use.
  select stored.* into strict reservation
  from vortex_file.upload_reservations as stored
  where stored.file_id = claimed_file_id
  for update;

  select stored.* into strict claimed
  from vortex_file.upload_grants as stored
  where stored.one_time_id = p_one_time_id
  for update;

  select stored.* into strict uploaded
  from vortex_file.file_records as stored
  where stored.file_id = claimed_file_id;

  if claimed.superseded_at is not null
    or claimed.credential_issued_at is not null
    or claimed.expires_at <= evaluated_at
    or claimed.actor is distinct from request_actor
    or reservation.uploaded_by is distinct from request_actor
    or reservation.upload_expires_at <= evaluated_at
    or uploaded.lifecycle_state <> 'pending' then
    return null;
  end if;

  update vortex_file.upload_grants
  set credential_issued_at = evaluated_at
  where one_time_id = claimed.one_time_id;

  return pg_catalog.jsonb_build_object(
    'grant', pg_catalog.jsonb_build_object(
      'kind', 'upload',
      'organizationId', claimed.organization_id,
      'actor', claimed.actor,
      'recordTypeId', reservation.owner_record_type_id,
      'recordId', reservation.owner_record_id,
      'fieldId', reservation.owner_field_id,
      'maximumBytes', claimed.maximum_bytes,
      'policyFingerprint', claimed.policy_fingerprint,
      'expiresAt', vortex_context.format_timestamp_utc(claimed.expires_at),
      'oneTimeId', claimed.one_time_id
    ),
    'fileRecord', vortex_file.upload_file_record(uploaded),
    'correlationId', reservation.correlation_id
  );
end
$function$;

revoke execute on function vortex_file.claim_file_upload_grant(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_file.claim_file_upload_grant(uuid) to vortex_request;

comment on function vortex_file.claim_file_upload_grant(uuid) is
  'Issues the one Storage credential of a current, unexpired grant for the uploader of a pending upload.';
