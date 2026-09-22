-- #652: Bounded upload admission, resumable renewal, trusted completion and
-- activation in the record save.
--
-- An admitted upload reserves its pending file, its capacity binding and its
-- first exact-object grant before any byte is accepted. Each grant issues one
-- Storage credential and is superseded by renewal or completion. Completion
-- records the inspected metadata and safety result; only the record save that
-- attaches a clean scanned file activates it. Every operation runs inside the
-- request's own organisation for the request's own verified actor, and no role
-- receives table access: these functions are the only write path.

begin;

-- ----------------------------------------------------------------------------
-- Upload reservations and grants
-- ----------------------------------------------------------------------------
create table vortex_file.upload_reservations (
  file_id uuid primary key
    references vortex_file.file_records (file_id),
  organization_id uuid not null
    references vortex_identity.organizations (organization_id),
  owner_record_type_id uuid not null,
  owner_record_id uuid not null,
  owner_field_id uuid not null,
  uploaded_by jsonb not null,
  maximum_bytes bigint not null,
  capability_reservation_id uuid not null,
  replacing_file_id uuid
    references vortex_file.file_records (file_id),
  correlation_id uuid not null,
  upload_expires_at timestamptz not null,
  revision bigint not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint upload_reservations_ids_non_nil check (
    vortex_context.is_non_nil_uuid(owner_record_type_id::text)
    and vortex_context.is_non_nil_uuid(owner_record_id::text)
    and vortex_context.is_non_nil_uuid(owner_field_id::text)
    and vortex_context.is_non_nil_uuid(capability_reservation_id::text)
    and vortex_context.is_non_nil_uuid(correlation_id::text)
  ),
  constraint upload_reservations_maximum_bytes_positive check (maximum_bytes > 0),
  constraint upload_reservations_not_self_replacing check (
    replacing_file_id is distinct from file_id
  ),
  constraint upload_reservations_revision_positive check (revision >= 1),
  constraint upload_reservations_window_valid check (
    upload_expires_at > created_at and updated_at >= created_at
  ),
  constraint upload_reservations_uploaded_by_object check (
    pg_catalog.jsonb_typeof(uploaded_by) = 'object'
  )
);

-- One capability reservation funds exactly one upload, so a replayed #650
-- consumption can never admit a second pending file.
create unique index upload_reservations_capability_reservation_unique
  on vortex_file.upload_reservations (capability_reservation_id);

create index upload_reservations_owner_idx
  on vortex_file.upload_reservations (
    organization_id, owner_record_type_id, owner_record_id, owner_field_id, upload_expires_at
  );

create table vortex_file.upload_grants (
  one_time_id uuid primary key
    constraint upload_grants_one_time_id_non_nil check (
      one_time_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  file_id uuid not null
    references vortex_file.upload_reservations (file_id),
  organization_id uuid not null
    references vortex_identity.organizations (organization_id),
  actor jsonb not null,
  maximum_bytes bigint not null,
  policy_fingerprint text not null,
  expires_at timestamptz not null,
  credential_issued_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz not null,
  constraint upload_grants_maximum_bytes_positive check (maximum_bytes > 0),
  constraint upload_grants_policy_fingerprint_valid check (
    policy_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  -- A grant is short lived: its one browser credential lasts at most 60 seconds,
  -- with a few seconds allowed for server clock skew.
  constraint upload_grants_short_lived check (
    expires_at > created_at and expires_at <= created_at + interval '65 seconds'
  ),
  constraint upload_grants_actor_object check (
    pg_catalog.jsonb_typeof(actor) = 'object'
  )
);

-- At most one grant of an upload is current; renewal supersedes it first.
create unique index upload_grants_one_current_per_file
  on vortex_file.upload_grants (file_id)
  where superseded_at is null;

alter table vortex_file.upload_reservations enable row level security;
alter table vortex_file.upload_reservations force row level security;
alter table vortex_file.upload_grants enable row level security;
alter table vortex_file.upload_grants force row level security;

revoke all on table vortex_file.upload_reservations, vortex_file.upload_grants
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

-- ----------------------------------------------------------------------------
-- Internal helpers
-- ----------------------------------------------------------------------------

-- The verified file actor of the established request: a human organisation
-- account with its identity, or a registered system actor. Any other caller has
-- no upload actor.
create function vortex_file.upload_request_actor(p_context jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select case p_context ->> 'callerKind'
    when 'human' then pg_catalog.jsonb_build_object(
      'kind', 'human',
      'organizationAccountId', p_context ->> 'organizationAccountId',
      'identityId', p_context ->> 'identityId'
    )
    when 'system' then pg_catalog.jsonb_build_object(
      'kind', 'system',
      'systemActorId', p_context ->> 'systemActorId'
    )
  end
$function$;

create function vortex_file.upload_timestamp(p_value timestamptz)
returns text
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$function$;

-- The File-service FileRecord projection of one stored file.
create function vortex_file.upload_file_record(p_file vortex_file.file_records)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'fileId', p_file.file_id,
    'organizationId', p_file.organization_id,
    'applicationRootId', p_file.application_root_id,
    'lifecycleState', p_file.lifecycle_state,
    'originalSafeDisplayName', p_file.original_safe_display_name,
    'detectedMediaType', p_file.detected_media_type,
    'extension', p_file.extension,
    'sizeBytes', p_file.size_bytes,
    'checksum', p_file.checksum,
    'storageKey', p_file.storage_key,
    'bucketId', p_file.bucket_id,
    'scannerName', p_file.scanner_name,
    'scannerVersion', p_file.scanner_version,
    'scannerResult', p_file.scanner_result,
    'previewReferences', p_file.preview_references,
    'uploadedBy', p_file.uploaded_by,
    'createdAt', vortex_file.upload_timestamp(p_file.created_at),
    'activatedAt', vortex_file.upload_timestamp(p_file.activated_at),
    'deletedAt', vortex_file.upload_timestamp(p_file.deleted_at),
    'removalDueAt', vortex_file.upload_timestamp(p_file.removal_due_at),
    'owningAttachmentReferences', pg_catalog.to_jsonb(p_file.owning_attachment_references),
    'ownerRecordTypeId', p_file.owner_record_type_id,
    'ownerRecordId', p_file.owner_record_id,
    'ownerFieldId', p_file.owner_field_id,
    'legalHold', pg_catalog.jsonb_build_object('isHeld', p_file.legal_hold)
  ))
$function$;

create function vortex_file.upload_refusal(p_reason text)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object('outcome', 'refused', 'reason', p_reason)
$function$;

-- ----------------------------------------------------------------------------
-- Admission
-- ----------------------------------------------------------------------------
create function vortex_file.reserve_file_upload(
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
  established jsonb := vortex_context.current_context();
  request_actor jsonb := vortex_file.upload_request_actor(established);
  in_flight_count bigint;
  reserved vortex_file.file_records%rowtype;
begin
  if request_actor is null
    or p_organization_id is distinct from (established ->> 'organizationId')::uuid
    or p_uploaded_by is distinct from request_actor then
    raise exception using errcode = '42501', message = 'File upload scope is unavailable';
  end if;

  if p_file_id is null
    or p_owner_record_type_id is null
    or p_owner_record_id is null
    or p_owner_field_id is null
    or p_maximum_bytes is null or p_maximum_bytes < 1
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

  if exists (
    select 1 from vortex_file.upload_reservations as reservation
    where reservation.capability_reservation_id = p_capability_reservation_id
  ) then
    return vortex_file.upload_refusal('capability_refused');
  end if;

  if p_replacing_file_id is not null and (
    p_existing_attachment_count < 1
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

  if p_existing_attachment_count
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
    correlation_id, upload_expires_at, revision, created_at, updated_at
  ) values (
    p_file_id, p_organization_id, p_owner_record_type_id, p_owner_record_id, p_owner_field_id,
    request_actor, p_maximum_bytes, p_capability_reservation_id, p_replacing_file_id,
    (established ->> 'correlationId')::uuid, p_upload_expires_at, 1, evaluated_at, evaluated_at
  );

  insert into vortex_file.upload_grants (
    one_time_id, file_id, organization_id, actor, maximum_bytes,
    policy_fingerprint, expires_at, created_at
  ) values (
    p_one_time_id, p_file_id, p_organization_id, request_actor, p_maximum_bytes,
    p_policy_fingerprint, p_grant_expires_at, evaluated_at
  );

  return pg_catalog.jsonb_build_object(
    'outcome', 'reserved',
    'fileRecord', vortex_file.upload_file_record(reserved)
  );
end
$function$;

-- ----------------------------------------------------------------------------
-- Upload state and credential issuance
-- ----------------------------------------------------------------------------
create function vortex_file.read_file_upload(p_file_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  established jsonb := vortex_context.current_context();
  reservation vortex_file.upload_reservations%rowtype;
  uploaded vortex_file.file_records%rowtype;
  current_grant_id uuid;
begin
  select stored.* into reservation
  from vortex_file.upload_reservations as stored
  where stored.file_id = p_file_id
    and stored.organization_id = (established ->> 'organizationId')::uuid;
  if not found then
    return null;
  end if;

  select stored.* into strict uploaded
  from vortex_file.file_records as stored
  where stored.file_id = p_file_id;

  select current_grant.one_time_id into current_grant_id
  from vortex_file.upload_grants as current_grant
  where current_grant.file_id = p_file_id
    and current_grant.superseded_at is null;

  return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'fileRecord', vortex_file.upload_file_record(uploaded),
    'uploader', reservation.uploaded_by,
    'maximumBytes', reservation.maximum_bytes,
    'uploadExpiresAt', vortex_file.upload_timestamp(reservation.upload_expires_at),
    'replacingFileId', reservation.replacing_file_id,
    'currentGrantId', current_grant_id,
    'correlationId', reservation.correlation_id,
    'revision', reservation.revision
  ));
end
$function$;

-- Issues the one Storage credential of a current, unexpired grant for the
-- request's own actor while the upload is pending.
create function vortex_file.claim_file_upload_grant(p_one_time_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  established jsonb := vortex_context.current_context();
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
      'expiresAt', vortex_file.upload_timestamp(claimed.expires_at),
      'oneTimeId', claimed.one_time_id
    ),
    'fileRecord', vortex_file.upload_file_record(uploaded),
    'correlationId', reservation.correlation_id
  );
end
$function$;

-- ----------------------------------------------------------------------------
-- Resumable renewal
-- ----------------------------------------------------------------------------
create function vortex_file.renew_file_upload(
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
  established jsonb := vortex_context.current_context();
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

-- ----------------------------------------------------------------------------
-- Completion: trusted inspection and safety result
-- ----------------------------------------------------------------------------
create function vortex_file.record_file_upload_outcome(
  p_file_id uuid,
  p_expected_revision bigint,
  p_detected_media_type text,
  p_size_bytes bigint,
  p_checksum text,
  p_scanner_name text,
  p_scanner_version text,
  p_scanner_result text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  established jsonb := vortex_context.current_context();
  request_actor jsonb := vortex_file.upload_request_actor(established);
  reservation vortex_file.upload_reservations%rowtype;
  uploaded vortex_file.file_records%rowtype;
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
  where stored.file_id = p_file_id
  for update;
  if uploaded.lifecycle_state <> 'pending' then
    return vortex_file.upload_refusal('invalid_lifecycle_state');
  end if;
  if reservation.upload_expires_at <= evaluated_at then
    return vortex_file.upload_refusal('upload_expired');
  end if;
  if reservation.revision is distinct from p_expected_revision then
    return vortex_file.upload_refusal('revision_conflict');
  end if;

  -- Bytes beyond the admitted reservation are never accepted as clean.
  if p_scanner_result is null
    or p_scanner_result not in ('clean', 'quarantined', 'refused')
    or p_size_bytes is null or p_size_bytes < 0
    or (p_scanner_result = 'clean' and p_size_bytes > reservation.maximum_bytes)
    or p_scanner_name is null
    or p_scanner_version is null then
    raise exception using errcode = '22023', message = 'File upload outcome is invalid';
  end if;

  update vortex_file.file_records
  set
    detected_media_type = p_detected_media_type,
    size_bytes = p_size_bytes,
    checksum = p_checksum,
    scanner_name = p_scanner_name,
    scanner_version = p_scanner_version,
    scanner_result = p_scanner_result,
    lifecycle_state = case when p_scanner_result = 'clean' then 'scanning' else 'quarantined' end
  where file_id = p_file_id
  returning * into uploaded;

  update vortex_file.upload_grants
  set superseded_at = evaluated_at
  where file_id = p_file_id
    and superseded_at is null;

  update vortex_file.upload_reservations
  set revision = revision + 1, updated_at = evaluated_at
  where file_id = p_file_id;

  return pg_catalog.jsonb_build_object(
    'outcome', 'recorded',
    'fileRecord', vortex_file.upload_file_record(uploaded)
  );
end
$function$;

-- ----------------------------------------------------------------------------
-- Activation in the record save
-- ----------------------------------------------------------------------------
-- Called inside the record save transaction that attaches the file, so the
-- activation commits or rolls back with the field value. The file it replaces is
-- not changed here and stays the current attachment until that save commits.
create function vortex_file.activate_uploaded_file(
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
  established jsonb := vortex_context.current_context();
  request_actor jsonb := vortex_file.upload_request_actor(established);
  reservation vortex_file.upload_reservations%rowtype;
  uploaded vortex_file.file_records%rowtype;
begin
  if p_attachment_reference_id is null
    or not vortex_context.is_non_nil_uuid(p_attachment_reference_id::text) then
    raise exception using errcode = '22023', message = 'File activation is invalid';
  end if;

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

  return pg_catalog.jsonb_build_object(
    'outcome', 'activated',
    'fileRecord', vortex_file.upload_file_record(uploaded)
  );
end
$function$;

-- ----------------------------------------------------------------------------
-- Privileges
-- ----------------------------------------------------------------------------
revoke execute on function
  vortex_file.upload_request_actor(jsonb),
  vortex_file.upload_timestamp(timestamptz),
  vortex_file.upload_file_record(vortex_file.file_records),
  vortex_file.upload_refusal(text),
  vortex_file.reserve_file_upload(
    uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, bigint, integer, integer,
    uuid, uuid, uuid, text, timestamptz, timestamptz
  ),
  vortex_file.read_file_upload(uuid),
  vortex_file.claim_file_upload_grant(uuid),
  vortex_file.renew_file_upload(uuid, bigint, uuid, uuid, text, timestamptz),
  vortex_file.record_file_upload_outcome(uuid, bigint, text, bigint, text, text, text, text),
  vortex_file.activate_uploaded_file(uuid, bigint, uuid, uuid, uuid, uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function
  vortex_file.reserve_file_upload(
    uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, bigint, integer, integer,
    uuid, uuid, uuid, text, timestamptz, timestamptz
  ),
  vortex_file.read_file_upload(uuid),
  vortex_file.claim_file_upload_grant(uuid),
  vortex_file.renew_file_upload(uuid, bigint, uuid, uuid, text, timestamptz),
  vortex_file.record_file_upload_outcome(uuid, bigint, text, bigint, text, text, text, text),
  vortex_file.activate_uploaded_file(uuid, bigint, uuid, uuid, uuid, uuid, uuid)
to vortex_request;

comment on table vortex_file.upload_reservations is
  'One admitted upload: its owning record field, uploader, admitted byte bound, capability reservation, replacement target, window and revision.';
comment on table vortex_file.upload_grants is
  'Short-lived exact-object upload grants; each issues one Storage credential and is superseded by renewal or completion.';
comment on function vortex_file.reserve_file_upload(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, bigint, integer, integer,
  uuid, uuid, uuid, text, timestamptz, timestamptz
) is
  'Reserves a pending file, its capacity binding and its first grant under a lock on the owning attachment field.';
comment on function vortex_file.read_file_upload(uuid) is
  'Reads one upload of the request organisation with its current grant and revision.';
comment on function vortex_file.claim_file_upload_grant(uuid) is
  'Issues the one Storage credential of a current, unexpired grant for the uploader of a pending upload.';
comment on function vortex_file.renew_file_upload(uuid, bigint, uuid, uuid, text, timestamptz) is
  'Supersedes the current grant of a pending upload with a new short-lived grant for its uploader.';
comment on function vortex_file.record_file_upload_outcome(
  uuid, bigint, text, bigint, text, text, text, text
) is
  'Records trusted inspection and the safety result of a pending upload, leaving it scanning or quarantined.';
comment on function vortex_file.activate_uploaded_file(uuid, bigint, uuid, uuid, uuid, uuid, uuid) is
  'Activates a clean scanned upload inside the record save that attaches it.';

commit;
