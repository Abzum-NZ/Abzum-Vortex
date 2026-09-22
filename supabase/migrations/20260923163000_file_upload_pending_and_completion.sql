-- Issue #652: Durable pending upload reservation and upload completion.
--
-- Admits bounded uploads by reserving pending file metadata and an exact-object
-- upload grant inside the private file store. Supports resumable grant renewal
-- and atomic completion with trusted media type, extension, size, checksum,
-- safety result, and access recheck.

begin;

-- ----------------------------------------------------------------------------
-- Upload transfer grants
-- ----------------------------------------------------------------------------
create table if not exists vortex_file.upload_grants (
  one_time_id uuid primary key constraint upload_grants_id_non_nil check (
    one_time_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  file_id uuid not null references vortex_file.file_records (file_id) on delete cascade,
  organization_id uuid not null references vortex_identity.organizations (organization_id),
  record_type_id uuid not null,
  record_id uuid not null,
  field_id uuid not null,
  actor jsonb not null,
  maximum_bytes bigint not null constraint upload_grants_max_bytes_positive check (maximum_bytes > 0),
  policy_fingerprint text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint upload_grants_expires_after_creation check (expires_at > created_at)
);

alter table vortex_file.upload_grants enable row level security;
alter table vortex_file.upload_grants force row level security;

create policy upload_grants_request_read on vortex_file.upload_grants
  for select to vortex_request
  using (organization_id = vortex_context.organization_id());

revoke all on table vortex_file.upload_grants
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant select on table vortex_file.upload_grants to vortex_request;

create index if not exists idx_upload_grants_file_id
  on vortex_file.upload_grants (file_id);
create index if not exists idx_upload_grants_org_expires
  on vortex_file.upload_grants (organization_id, expires_at);

-- ----------------------------------------------------------------------------
-- Protected upload lifecycle operations
-- ----------------------------------------------------------------------------

create or replace function vortex_file.reserve_pending_file_upload(
  p_file_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_owner_record_type_id uuid,
  p_owner_record_id uuid,
  p_owner_field_id uuid,
  p_original_safe_display_name text,
  p_detected_media_type text,
  p_extension text,
  p_size_bytes bigint,
  p_checksum text,
  p_storage_key text,
  p_scanner_name text,
  p_scanner_version text,
  p_uploaded_by jsonb,
  p_one_time_id uuid,
  p_maximum_bytes bigint,
  p_policy_fingerprint text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_current_org uuid;
  v_file_record record;
  v_grant record;
begin
  v_current_org := vortex_context.organization_id();
  if v_current_org is null or v_current_org <> p_organization_id then
    raise exception using errcode = '28000',
      message = 'Caller does not have authority over the specified organisation';
  end if;

  insert into vortex_file.file_records (
    file_id,
    organization_id,
    application_root_id,
    owner_record_type_id,
    owner_record_id,
    owner_field_id,
    owning_attachment_references,
    lifecycle_state,
    original_safe_display_name,
    detected_media_type,
    extension,
    size_bytes,
    checksum,
    storage_key,
    bucket_id,
    scanner_name,
    scanner_version,
    scanner_result,
    preview_references,
    uploaded_by,
    legal_hold,
    created_at
  ) values (
    p_file_id,
    p_organization_id,
    p_application_root_id,
    p_owner_record_type_id,
    p_owner_record_id,
    p_owner_field_id,
    '{}'::uuid[],
    'pending',
    p_original_safe_display_name,
    p_detected_media_type,
    p_extension,
    p_size_bytes,
    p_checksum,
    p_storage_key,
    'private_files',
    p_scanner_name,
    p_scanner_version,
    'pending',
    '[]'::jsonb,
    p_uploaded_by,
    false,
    pg_catalog.statement_timestamp()
  )
  returning * into v_file_record;

  insert into vortex_file.upload_grants (
    one_time_id,
    file_id,
    organization_id,
    record_type_id,
    record_id,
    field_id,
    actor,
    maximum_bytes,
    policy_fingerprint,
    expires_at,
    created_at
  ) values (
    p_one_time_id,
    p_file_id,
    p_organization_id,
    p_owner_record_type_id,
    p_owner_record_id,
    p_owner_field_id,
    p_uploaded_by,
    p_maximum_bytes,
    p_policy_fingerprint,
    p_expires_at,
    pg_catalog.statement_timestamp()
  )
  returning * into v_grant;

  return pg_catalog.jsonb_build_object(
    'outcome', 'admitted',
    'fileId', v_file_record.file_id,
    'storageKey', v_file_record.storage_key,
    'oneTimeId', v_grant.one_time_id,
    'expiresAt', v_grant.expires_at
  );
end
$function$;

create or replace function vortex_file.renew_pending_file_upload(
  p_file_id uuid,
  p_organization_id uuid,
  p_previous_one_time_id uuid,
  p_new_one_time_id uuid,
  p_new_expires_at timestamptz,
  p_new_policy_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_current_org uuid;
  v_file_record record;
  v_existing_grant record;
  v_new_grant record;
begin
  v_current_org := vortex_context.organization_id();
  if v_current_org is null or v_current_org <> p_organization_id then
    raise exception using errcode = '28000',
      message = 'Caller does not have authority over the specified organisation';
  end if;

  select * into v_file_record
  from vortex_file.file_records
  where file_id = p_file_id and organization_id = p_organization_id;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'File record not found';
  end if;

  if v_file_record.lifecycle_state <> 'pending' then
    raise exception using errcode = '23514',
      message = 'Only pending file uploads can be renewed';
  end if;

  select * into v_existing_grant
  from vortex_file.upload_grants
  where one_time_id = p_previous_one_time_id
    and file_id = p_file_id
    and organization_id = p_organization_id;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Previous upload grant not found for this file';
  end if;

  -- Mark previous grant consumed/superseded
  update vortex_file.upload_grants
  set consumed_at = pg_catalog.statement_timestamp()
  where one_time_id = p_previous_one_time_id;

  insert into vortex_file.upload_grants (
    one_time_id,
    file_id,
    organization_id,
    record_type_id,
    record_id,
    field_id,
    actor,
    maximum_bytes,
    policy_fingerprint,
    expires_at,
    created_at
  ) values (
    p_new_one_time_id,
    p_file_id,
    p_organization_id,
    v_existing_grant.record_type_id,
    v_existing_grant.record_id,
    v_existing_grant.field_id,
    v_existing_grant.actor,
    v_existing_grant.maximum_bytes,
    coalesce(p_new_policy_fingerprint, v_existing_grant.policy_fingerprint),
    p_new_expires_at,
    pg_catalog.statement_timestamp()
  )
  returning * into v_new_grant;

  return pg_catalog.jsonb_build_object(
    'outcome', 'renewed',
    'fileId', p_file_id,
    'oneTimeId', v_new_grant.one_time_id,
    'expiresAt', v_new_grant.expires_at
  );
end
$function$;

create or replace function vortex_file.complete_file_upload(
  p_file_id uuid,
  p_organization_id uuid,
  p_detected_media_type text,
  p_extension text,
  p_size_bytes bigint,
  p_checksum text,
  p_scanner_name text,
  p_scanner_version text,
  p_scanner_result text,
  p_target_state text,
  p_consumed_one_time_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_current_org uuid;
  v_file_record record;
  v_now timestamptz;
begin
  v_current_org := vortex_context.organization_id();
  if v_current_org is null or v_current_org <> p_organization_id then
    raise exception using errcode = '28000',
      message = 'Caller does not have authority over the specified organisation';
  end if;

  if p_target_state not in ('active', 'quarantined') then
    raise exception using errcode = '23514',
      message = 'Upload completion target state must be active or quarantined';
  end if;

  select * into v_file_record
  from vortex_file.file_records
  where file_id = p_file_id and organization_id = p_organization_id
  for update;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'File record not found';
  end if;

  if v_file_record.lifecycle_state not in ('pending', 'uploaded', 'scanning') then
    raise exception using errcode = '23514',
      message = 'File record lifecycle state is not eligible for completion';
  end if;

  v_now := pg_catalog.statement_timestamp();

  update vortex_file.file_records
  set
    detected_media_type = p_detected_media_type,
    extension = p_extension,
    size_bytes = p_size_bytes,
    checksum = p_checksum,
    scanner_name = p_scanner_name,
    scanner_version = p_scanner_version,
    scanner_result = p_scanner_result,
    lifecycle_state = p_target_state,
    activated_at = case when p_target_state = 'active' then v_now else null end
  where file_id = p_file_id and organization_id = p_organization_id
  returning * into v_file_record;

  -- Mark grant consumed if provided or mark all pending grants for file consumed
  if p_consumed_one_time_id is not null then
    update vortex_file.upload_grants
    set consumed_at = v_now
    where one_time_id = p_consumed_one_time_id;
  else
    update vortex_file.upload_grants
    set consumed_at = v_now
    where file_id = p_file_id and consumed_at is null;
  end if;

  return pg_catalog.to_jsonb(v_file_record);
end
$function$;

revoke all on function vortex_file.reserve_pending_file_upload(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, bigint, text, text, text, text, jsonb, uuid, bigint, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function vortex_file.reserve_pending_file_upload(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, bigint, text, text, text, text, jsonb, uuid, bigint, text, timestamptz
) to vortex_runtime, vortex_request;

revoke all on function vortex_file.renew_pending_file_upload(
  uuid, uuid, uuid, uuid, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function vortex_file.renew_pending_file_upload(
  uuid, uuid, uuid, uuid, timestamptz, text
) to vortex_runtime, vortex_request;

revoke all on function vortex_file.complete_file_upload(
  uuid, uuid, text, text, bigint, text, text, text, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function vortex_file.complete_file_upload(
  uuid, uuid, text, text, bigint, text, text, text, text, text, uuid
) to vortex_runtime, vortex_request;

comment on table vortex_file.upload_grants is
  'One-time bounded upload grants issued to admitted file upload sessions.';
comment on function vortex_file.reserve_pending_file_upload is
  'Reserves an organisation-owned pending file record and its short-lived upload grant.';
comment on function vortex_file.renew_pending_file_upload is
  'Renews a short-lived upload grant for an in-progress resumable upload under current authority.';
comment on function vortex_file.complete_file_upload is
  'Completes a file upload with verified content inspection, safety and scan results, activating or quarantining the file.';

commit;
