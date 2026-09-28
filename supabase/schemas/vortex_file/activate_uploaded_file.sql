create or replace function vortex_file.activate_uploaded_file(
  p_file_id uuid,
  p_expected_revision bigint,
  p_owner_record_type_id uuid,
  p_owner_record_id uuid,
  p_owner_field_id uuid,
  p_attachment_reference_id uuid,
  p_replacing_file_id uuid
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
  attached_count bigint;
begin
  if p_attachment_reference_id is null
    or not vortex_context.is_non_nil_uuid(p_attachment_reference_id::text) then
    raise exception using errcode = '22023', message = 'File activation is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f',
      'vortex_file.upload_field', (established ->> 'organizationId')::uuid::text,
      p_owner_record_type_id::text, p_owner_record_id::text, p_owner_field_id::text), 652)
  );

  select stored.* into reservation
  from vortex_file.upload_reservations as stored
  where stored.file_id = p_file_id
    and stored.organization_id = (established ->> 'organizationId')::uuid
  for update;
  if not found then
    return vortex_file.upload_refusal('file_not_found');
  end if;
  if request_actor is null or reservation.uploaded_by is distinct from request_actor then
    perform vortex_file.append_file_activity_internal(
      'file_activation_refused', p_file_id);
    return vortex_file.upload_refusal('caller_not_authorized');
  end if;
  if reservation.owner_record_type_id is distinct from p_owner_record_type_id
    or reservation.owner_record_id is distinct from p_owner_record_id
    or reservation.owner_field_id is distinct from p_owner_field_id then
    return vortex_file.upload_refusal('owner_mismatch');
  end if;

  select stored.* into strict uploaded
  from vortex_file.file_records as stored
  where stored.file_id = p_file_id
  for update;

  if uploaded.lifecycle_state = 'active'
    and p_attachment_reference_id = any (uploaded.owning_attachment_references) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'activated',
      'fileRecord', vortex_file.upload_file_record(uploaded)
    );
  end if;
  if uploaded.lifecycle_state <> 'scanning' or uploaded.scanner_result <> 'clean' then
    return vortex_file.upload_refusal('invalid_lifecycle_state');
  end if;
  if reservation.upload_expires_at <= evaluated_at then
    return vortex_file.upload_refusal('upload_expired');
  end if;
  if reservation.revision is distinct from p_expected_revision then
    return vortex_file.upload_refusal('revision_conflict');
  end if;
  if reservation.replacing_file_id is distinct from p_replacing_file_id then
    return vortex_file.upload_refusal('replacement_file_not_found');
  end if;
  if p_replacing_file_id is not null then
    perform 1
    from vortex_file.file_records as replaced
    where replaced.file_id = p_replacing_file_id
      and replaced.organization_id = reservation.organization_id
      and replaced.owner_record_type_id = reservation.owner_record_type_id
      and replaced.owner_record_id = reservation.owner_record_id
      and replaced.owner_field_id = reservation.owner_field_id
      and replaced.lifecycle_state = 'active'
    for share;
    if not found then
      return vortex_file.upload_refusal('replacement_file_not_found');
    end if;
  end if;

  if reservation.max_files is not null then
    select pg_catalog.count(*) into attached_count
    from vortex_file.file_records as attached
    where attached.organization_id = reservation.organization_id
      and attached.owner_record_type_id = reservation.owner_record_type_id
      and attached.owner_record_id = reservation.owner_record_id
      and attached.owner_field_id = reservation.owner_field_id
      and attached.lifecycle_state = 'active'
      and attached.file_id <> p_file_id
      and attached.file_id is distinct from p_replacing_file_id;
    if attached_count >= reservation.max_files then
      raise exception using errcode = '23514',
        message = 'Attachment field already holds its maximum number of files';
    end if;
  end if;

  update vortex_file.file_records
  set
    lifecycle_state = 'active',
    activated_at = evaluated_at,
    owning_attachment_references = pg_catalog.array_append(
      owning_attachment_references, p_attachment_reference_id
    )
  where file_id = p_file_id
  returning * into uploaded;

  update vortex_file.upload_reservations
  set revision = revision + 1, updated_at = evaluated_at
  where file_id = p_file_id;

  perform vortex_file.append_file_activity_internal(
    'file_activated', p_file_id);

  return pg_catalog.jsonb_build_object(
    'outcome', 'activated',
    'fileRecord', vortex_file.upload_file_record(uploaded)
  );
end
$function$;

comment on function vortex_file.activate_uploaded_file(uuid, bigint, uuid, uuid, uuid, uuid, uuid) is
  'Activates a clean scanned upload inside the record save that attaches it.';

revoke execute on function
  vortex_file.activate_uploaded_file(uuid, bigint, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function
  vortex_file.activate_uploaded_file(uuid, bigint, uuid, uuid, uuid, uuid, uuid) to vortex_request;

alter function vortex_file.activate_uploaded_file(uuid, bigint, uuid, uuid, uuid, uuid, uuid)
  owner to vortex_file_owner;
