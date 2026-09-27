create or replace function vortex_file.reserve_file_upload(
  p_file_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_owner_record_type_id uuid,
  p_owner_record_id uuid,
  p_owner_field_id uuid,
  p_original_safe_display_name text,
  p_extension text,
  p_storage_key text,
  p_uploaded_by jsonb,
  p_maximum_bytes bigint,
  p_max_files integer,
  p_existing_attachment_count integer,
  p_replacing_file_id uuid,
  p_capability_reservation_id uuid,
  p_one_time_id uuid,
  p_policy_fingerprint text,
  p_grant_expires_at timestamptz,
  p_upload_expires_at timestamptz
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
  in_flight_count bigint;
  existing_count bigint;
  reserved vortex_file.file_records%rowtype;
begin
  if request_actor is null
    or p_organization_id is distinct from (established ->> 'organizationId')::uuid
    or p_application_root_id is distinct from (established ->> 'applicationRootId')::uuid
    or p_uploaded_by is distinct from request_actor then
    raise exception using errcode = '42501', message = 'File upload scope is unavailable';
  end if;

  if p_file_id is null
    or p_owner_record_type_id is null
    or p_owner_record_id is null
    or p_owner_field_id is null
    or p_maximum_bytes is null or p_maximum_bytes < 1
    or p_maximum_bytes > vortex_file.upload_maximum_bytes_limit()
    or p_max_files is null or p_max_files < 1
    or p_existing_attachment_count is null or p_existing_attachment_count < 0
    or p_capability_reservation_id is null
    or p_one_time_id is null
    or p_policy_fingerprint is null
    or p_grant_expires_at is null
    or p_grant_expires_at <= evaluated_at
    or p_grant_expires_at > evaluated_at + interval '65 seconds'
    or p_upload_expires_at is null
    or p_upload_expires_at < p_grant_expires_at
    or p_upload_expires_at > evaluated_at + interval '24 hours 5 minutes' then
    raise exception using errcode = '22023', message = 'File upload reservation is invalid';
  end if;

  -- Admissions to one attachment field are serialised so concurrent uploads
  -- cannot together exceed its file count.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f',
      'vortex_file.upload_field', p_organization_id::text,
      p_owner_record_type_id::text, p_owner_record_id::text, p_owner_field_id::text), 652)
  );

  perform 1
  from vortex_access.capability_reservations as funding
  where funding.reservation_id = p_capability_reservation_id
    and funding.tenant_id = (established ->> 'tenantId')::uuid
    and funding.request_organization_id = p_organization_id
    and funding.correlation_id = (established ->> 'correlationId')::uuid
    and funding.state = 'active'
    and funding.expires_at > evaluated_at
    and funding.reserved_quantity - funding.consumed_quantity - funding.released_quantity > 0
  for update;
  if not found then
    if not exists (
      select 1 from vortex_file.upload_reservations as retried
      where retried.capability_reservation_id = p_capability_reservation_id
        and retried.file_id = p_file_id
    ) then
      perform vortex_file.append_file_activity_internal(
        'file_upload_refused', p_organization_id);
    end if;
    return vortex_file.upload_refusal('capability_refused');
  end if;

  if exists (
    select 1 from vortex_file.upload_reservations as reservation
    where reservation.capability_reservation_id = p_capability_reservation_id
  ) then
    if not exists (
      select 1 from vortex_file.upload_reservations as retried
      where retried.capability_reservation_id = p_capability_reservation_id
        and retried.file_id = p_file_id
    ) then
      perform vortex_file.append_file_activity_internal(
        'file_upload_refused', p_organization_id);
    end if;
    return vortex_file.upload_refusal('capability_refused');
  end if;

  select pg_catalog.count(*) into existing_count
  from vortex_file.file_records as attached
  where attached.organization_id = p_organization_id
    and attached.owner_record_type_id = p_owner_record_type_id
    and attached.owner_record_id = p_owner_record_id
    and attached.owner_field_id = p_owner_field_id
    and attached.lifecycle_state = 'active';

  if p_replacing_file_id is not null and (
    existing_count < 1
    or not exists (
      select 1 from vortex_file.file_records as replaced
      where replaced.file_id = p_replacing_file_id
        and replaced.organization_id = p_organization_id
        and replaced.owner_record_type_id = p_owner_record_type_id
        and replaced.owner_record_id = p_owner_record_id
        and replaced.owner_field_id = p_owner_field_id
        and replaced.lifecycle_state = 'active'
    )
  ) then
    return vortex_file.upload_refusal('replacement_file_not_found');
  end if;

  select pg_catalog.count(*) into in_flight_count
  from vortex_file.upload_reservations as reservation
  join vortex_file.file_records as uploaded
    on uploaded.file_id = reservation.file_id
  where reservation.organization_id = p_organization_id
    and reservation.owner_record_type_id = p_owner_record_type_id
    and reservation.owner_record_id = p_owner_record_id
    and reservation.owner_field_id = p_owner_field_id
    and reservation.upload_expires_at > evaluated_at
    and uploaded.lifecycle_state in ('pending', 'uploaded', 'scanning');

  if existing_count
    - (case when p_replacing_file_id is null then 0 else 1 end)
    + in_flight_count >= p_max_files then
    return vortex_file.upload_refusal('field_capacity_exceeded');
  end if;

  insert into vortex_file.file_records (
    file_id, organization_id, application_root_id,
    owner_record_type_id, owner_record_id, owner_field_id,
    owning_attachment_references, lifecycle_state, original_safe_display_name,
    detected_media_type, extension, size_bytes, checksum,
    storage_key, bucket_id, scanner_name, scanner_version, scanner_result,
    preview_references, uploaded_by, legal_hold, created_at
  ) values (
    p_file_id, p_organization_id, p_application_root_id,
    p_owner_record_type_id, p_owner_record_id, p_owner_field_id,
    '{}'::uuid[], 'pending', p_original_safe_display_name,
    'application/octet-stream', p_extension, 0, 'sha256:' || pg_catalog.repeat('0', 64),
    p_storage_key, 'private_files', 'vortex_file_preflight', '1', 'pending',
    '[]'::jsonb, request_actor, false, evaluated_at
  )
  returning * into reserved;

  insert into vortex_file.upload_reservations (
    file_id, organization_id, owner_record_type_id, owner_record_id, owner_field_id,
    uploaded_by, maximum_bytes, capability_reservation_id, replacing_file_id,
    correlation_id, upload_expires_at, revision, created_at, updated_at, max_files
  ) values (
    p_file_id, p_organization_id, p_owner_record_type_id, p_owner_record_id, p_owner_field_id,
    request_actor, p_maximum_bytes, p_capability_reservation_id, p_replacing_file_id,
    (established ->> 'correlationId')::uuid, p_upload_expires_at, 1, evaluated_at, evaluated_at,
    p_max_files
  );

  insert into vortex_file.upload_grants (
    one_time_id, file_id, organization_id, actor, maximum_bytes,
    policy_fingerprint, expires_at, created_at
  ) values (
    p_one_time_id, p_file_id, p_organization_id, request_actor, p_maximum_bytes,
    p_policy_fingerprint, p_grant_expires_at, evaluated_at
  );

  perform vortex_file.append_file_activity_internal(
    'file_upload_admitted', p_file_id);

  return pg_catalog.jsonb_build_object(
    'outcome', 'reserved',
    'fileRecord', vortex_file.upload_file_record(reserved)
  );
end
$function$;

comment on function vortex_file.reserve_file_upload(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, bigint, integer, integer,
  uuid, uuid, uuid, text, timestamptz, timestamptz
) is
  'Reserves a pending file, its capacity binding and its first grant under a lock on the owning attachment field.';

revoke execute on function
  vortex_file.reserve_file_upload(
    uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, bigint, integer, integer,
    uuid, uuid, uuid, text, timestamptz, timestamptz
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function
  vortex_file.reserve_file_upload(
    uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, bigint, integer, integer,
    uuid, uuid, uuid, text, timestamptz, timestamptz
  ) to vortex_request;
