create or replace function vortex_file.renew_file_upload(
  p_file_id uuid,
  p_expected_revision bigint,
  p_previous_one_time_id uuid,
  p_new_one_time_id uuid,
  p_policy_fingerprint text,
  p_grant_expires_at timestamptz
)
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
  reservation vortex_file.upload_reservations%rowtype;
  uploaded vortex_file.file_records%rowtype;
  current_grant_id uuid;
begin
  select stored.* into reservation
  from vortex_file.upload_reservations as stored
  where stored.file_id = p_file_id
    and stored.organization_id = (established ->> 'organizationId')::uuid
  for update;
  if not found then
    return vortex_file.upload_refusal('file_not_found');
  end if;
  if request_actor is null or reservation.uploaded_by is distinct from request_actor then
    return vortex_file.upload_refusal('caller_not_authorized');
  end if;

  select stored.* into strict uploaded
  from vortex_file.file_records as stored
  where stored.file_id = p_file_id;
  if uploaded.lifecycle_state <> 'pending' then
    return vortex_file.upload_refusal('invalid_lifecycle_state');
  end if;
  if reservation.upload_expires_at <= evaluated_at then
    return vortex_file.upload_refusal('upload_expired');
  end if;

  select current_grant.one_time_id into current_grant_id
  from vortex_file.upload_grants as current_grant
  where current_grant.file_id = p_file_id
    and current_grant.superseded_at is null
  for update;
  if reservation.revision is distinct from p_expected_revision
    or current_grant_id is distinct from p_previous_one_time_id then
    return vortex_file.upload_refusal('grant_mismatch');
  end if;

  if p_new_one_time_id is null
    or p_policy_fingerprint is null
    or p_grant_expires_at is null
    or p_grant_expires_at <= evaluated_at
    or p_grant_expires_at > evaluated_at + interval '65 seconds'
    or p_grant_expires_at > reservation.upload_expires_at then
    raise exception using errcode = '22023', message = 'File upload renewal is invalid';
  end if;

  update vortex_file.upload_grants
  set superseded_at = evaluated_at
  where one_time_id = p_previous_one_time_id;

  insert into vortex_file.upload_grants (
    one_time_id, file_id, organization_id, actor, maximum_bytes,
    policy_fingerprint, expires_at, created_at
  ) values (
    p_new_one_time_id, p_file_id, reservation.organization_id, reservation.uploaded_by,
    reservation.maximum_bytes, p_policy_fingerprint, p_grant_expires_at, evaluated_at
  );

  update vortex_file.upload_reservations
  set revision = revision + 1, updated_at = evaluated_at
  where file_id = p_file_id;

  return pg_catalog.jsonb_build_object('outcome', 'renewed');
end
$function$;

comment on function vortex_file.renew_file_upload(uuid, bigint, uuid, uuid, text, timestamptz) is
  'Supersedes the current grant of a pending upload with a new short-lived grant for its uploader.';

revoke execute on function
  vortex_file.renew_file_upload(uuid, bigint, uuid, uuid, text, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function
  vortex_file.renew_file_upload(uuid, bigint, uuid, uuid, text, timestamptz) to vortex_request;

alter function vortex_file.renew_file_upload(uuid, bigint, uuid, uuid, text, timestamptz)
  owner to vortex_file_owner;
