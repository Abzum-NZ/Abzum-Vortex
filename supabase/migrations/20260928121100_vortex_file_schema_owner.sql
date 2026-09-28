-- #1594: let File definers use only File-owned tables and tenant-scoped rows.
begin;

-- This trigger reads Definition roots directly. Existing Definition definers
-- require a published release or an authorized installed-application request,
-- and the projection helper is SECURITY INVOKER. None returns the existence,
-- kind and organization of an arbitrary root, including an unpublished root.
create or replace function vortex_file.enforce_file_application_root()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  application_root record;
begin
  if new.application_root_id is null then
    return new;
  end if;

  select root.organization_id, root.kind into application_root
  from vortex_definition.roots as root
  where root.root_id = new.application_root_id;

  if not found then
    raise exception using errcode = '23503',
      message = 'Referenced application root does not exist';
  end if;

  if application_root.kind <> 'application' then
    raise exception using errcode = '23514',
      message = 'Referenced root must be of kind application';
  end if;

  if application_root.organization_id <> new.organization_id then
    raise exception using errcode = '23514',
      message = 'Referenced application root organization does not match file organization';
  end if;

  return new;
end
$function$;

revoke all on function vortex_file.enforce_file_application_root()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_file.enforce_file_application_root() is
  'Keeps a file''s Application scope inside its own organisation and on a root of kind application.';
alter function vortex_file.enforce_file_application_root() owner to postgres;

-- This File helper reads Activity rows directly and writes through the existing
-- SECURITY INVOKER appender. It stays postgres-owned until Activity exposes an
-- equivalent narrow definer operation.
create or replace function vortex_file.append_file_activity_internal(
  p_action text,
  p_subject_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  established jsonb := vortex_context.current_context();
  request_actor jsonb;
  organization_id_value uuid;
  correlation_id_value uuid;
  outcome_value text;
  actor_kind text;
  actor_identifier uuid;
  source_value text;
  activity_id_value uuid;
begin
  outcome_value := case p_action
    when 'file_upload_admitted' then 'completed'
    when 'file_upload_refused' then 'refused'
    when 'file_activated' then 'completed'
    when 'file_activation_refused' then 'refused'
    when 'file_download_granted' then 'completed'
  end;
  if outcome_value is null
    or p_subject_id is null
    or p_subject_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'File Activity input is invalid';
  end if;

  request_actor := vortex_file.upload_request_actor(established);
  if request_actor is null then
    return;
  end if;

  if request_actor ->> 'kind' = 'human' then
    actor_kind := 'organization_account';
    actor_identifier := (request_actor ->> 'organizationAccountId')::uuid;
    source_value := 'web';
  else
    actor_kind := 'system';
    actor_identifier := (request_actor ->> 'systemActorId')::uuid;
    source_value := 'system';
  end if;

  organization_id_value := (established ->> 'organizationId')::uuid;
  correlation_id_value := (established ->> 'correlationId')::uuid;
  activity_id_value := vortex_file.file_activity_id(
    p_action, organization_id_value, correlation_id_value, p_subject_id
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f',
      'vortex_file.activity', organization_id_value::text, activity_id_value::text), 744)
  );

  if exists (
    select 1
    from vortex_activity.organization_activity_entries as existing
    where existing.organization_id = organization_id_value
      and existing.activity_id = activity_id_value
  ) then
    return;
  end if;

  perform vortex_activity.append_organization_activity_entry(
    organization_id_value,
    activity_id_value,
    pg_catalog.statement_timestamp(),
    actor_kind,
    actor_identifier,
    p_action,
    array[p_subject_id]::uuid[],
    array[]::uuid[],
    source_value,
    correlation_id_value,
    outcome_value
  );
end
$function$;

revoke execute on function vortex_file.append_file_activity_internal(text, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_file.append_file_activity_internal(text, uuid)
  to vortex_file_owner;
comment on function vortex_file.append_file_activity_internal(text, uuid) is
  'Appends one content-free File Activity entry for the verified request actor; used by the admission, activation and download-grant owners.';
alter function vortex_file.append_file_activity_internal(text, uuid) owner to postgres;

-- The upload reservation is locked and read directly from Access. No existing
-- Access definer returns and locks this exact active reservation, so this
-- admission function remains postgres-owned until Access exposes that interface.

-- File-owned definers use only the validated service-context entry point and
-- two pure UUID/timestamp helpers in the private Context schema.
grant usage on schema vortex_context to vortex_file_owner;
grant execute on function
  vortex_context.is_non_nil_uuid(text),
  vortex_context.format_timestamp_utc(timestamptz),
  vortex_context.validated_service_context()
to vortex_file_owner;

-- Only the selected File helper functions are callable by the File owner. The
-- externally callable File functions retain their existing request grants.
grant execute on function
  vortex_file.upload_request_actor(jsonb),
  vortex_file.upload_file_record(vortex_file.file_records),
  vortex_file.upload_refusal(text),
  vortex_file.append_file_activity_internal(text, uuid)
to vortex_file_owner;

-- Every stored row remains forced-RLS. The File owner receives only the
-- operations and update/insert columns used by the converted function bodies.
revoke all on table
  vortex_file.file_records,
  vortex_file.upload_reservations,
  vortex_file.upload_grants,
  vortex_file.download_grants
from vortex_file_owner;

grant select on table
  vortex_file.file_records,
  vortex_file.upload_reservations,
  vortex_file.upload_grants,
  vortex_file.download_grants
to vortex_file_owner;

grant update (
  lifecycle_state,
  activated_at,
  owning_attachment_references,
  detected_media_type,
  size_bytes,
  checksum,
  scanner_name,
  scanner_version,
  scanner_result
) on table vortex_file.file_records to vortex_file_owner;

grant update (revision, updated_at)
  on table vortex_file.upload_reservations to vortex_file_owner;

grant insert (
  one_time_id,
  file_id,
  organization_id,
  actor,
  maximum_bytes,
  policy_fingerprint,
  expires_at,
  created_at
) on table vortex_file.upload_grants to vortex_file_owner;
grant update (credential_issued_at, superseded_at)
  on table vortex_file.upload_grants to vortex_file_owner;

grant insert (
  one_time_id,
  file_id,
  organization_id,
  owner_record_type_id,
  owner_record_id,
  owner_field_id,
  actor,
  purpose,
  correlation_id,
  expires_at,
  created_at
) on table vortex_file.download_grants to vortex_file_owner;
grant update (credential_issued_at)
  on table vortex_file.download_grants to vortex_file_owner;
grant delete on table vortex_file.download_grants to vortex_file_owner;

-- The validator returns the established organization for both human and
-- registered-system File requests. A missing organization fails closed.
create policy file_records_file_owner_read on vortex_file.file_records
  for select to vortex_file_owner
  using (
    organization_id =
      (vortex_file.upload_validated_context() ->> 'organizationId')::uuid
  );
create policy file_records_file_owner_update on vortex_file.file_records
  for update to vortex_file_owner
  using (
    organization_id =
      (vortex_file.upload_validated_context() ->> 'organizationId')::uuid
  )
  with check (
    organization_id =
      (vortex_file.upload_validated_context() ->> 'organizationId')::uuid
  );

create policy upload_reservations_file_owner_read on vortex_file.upload_reservations
  for select to vortex_file_owner
  using (
    organization_id =
      (vortex_file.upload_validated_context() ->> 'organizationId')::uuid
  );
create policy upload_reservations_file_owner_update on vortex_file.upload_reservations
  for update to vortex_file_owner
  using (
    organization_id =
      (vortex_file.upload_validated_context() ->> 'organizationId')::uuid
  )
  with check (
    organization_id =
      (vortex_file.upload_validated_context() ->> 'organizationId')::uuid
  );

create policy upload_grants_file_owner_read on vortex_file.upload_grants
  for select to vortex_file_owner
  using (
    organization_id =
      (vortex_file.upload_validated_context() ->> 'organizationId')::uuid
  );
create policy upload_grants_file_owner_insert on vortex_file.upload_grants
  for insert to vortex_file_owner
  with check (
    organization_id =
      (vortex_file.upload_validated_context() ->> 'organizationId')::uuid
  );
create policy upload_grants_file_owner_update on vortex_file.upload_grants
  for update to vortex_file_owner
  using (
    organization_id =
      (vortex_file.upload_validated_context() ->> 'organizationId')::uuid
  )
  with check (
    organization_id =
      (vortex_file.upload_validated_context() ->> 'organizationId')::uuid
  );

create policy download_grants_file_owner_read on vortex_file.download_grants
  for select to vortex_file_owner
  using (
    organization_id =
      (vortex_file.upload_validated_context() ->> 'organizationId')::uuid
  );
create policy download_grants_file_owner_insert on vortex_file.download_grants
  for insert to vortex_file_owner
  with check (
    organization_id =
      (vortex_file.upload_validated_context() ->> 'organizationId')::uuid
  );
create policy download_grants_file_owner_update on vortex_file.download_grants
  for update to vortex_file_owner
  using (
    organization_id =
      (vortex_file.upload_validated_context() ->> 'organizationId')::uuid
  )
  with check (
    organization_id =
      (vortex_file.upload_validated_context() ->> 'organizationId')::uuid
  );
create policy download_grants_file_owner_delete on vortex_file.download_grants
  for delete to vortex_file_owner
  using (
    organization_id =
      (vortex_file.upload_validated_context() ->> 'organizationId')::uuid
  );

-- These nine functions have no direct cross-schema table access. They use the
-- narrow Context entry points above and, for the existing Activity event path,
-- the explicitly retained postgres-owned File helper. Preserve their bodies,
-- comments and caller grants.
alter function vortex_file.activate_uploaded_file(
  uuid, bigint, uuid, uuid, uuid, uuid, uuid
) owner to vortex_file_owner;
alter function vortex_file.claim_file_download_grant(uuid) owner to vortex_file_owner;
alter function vortex_file.claim_file_upload_grant(uuid) owner to vortex_file_owner;
alter function vortex_file.read_file_for_download(uuid) owner to vortex_file_owner;
alter function vortex_file.read_file_upload(uuid) owner to vortex_file_owner;
alter function vortex_file.record_file_download_grant(
  uuid, uuid, uuid, uuid, uuid, jsonb, text, uuid, timestamptz
) owner to vortex_file_owner;
alter function vortex_file.record_file_upload_outcome(
  uuid, bigint, text, bigint, text, text, text, text
) owner to vortex_file_owner;
alter function vortex_file.renew_file_upload(
  uuid, bigint, uuid, uuid, text, timestamptz
) owner to vortex_file_owner;
alter function vortex_file.upload_validated_context() owner to vortex_file_owner;

-- Preserve postgres ownership where the checked-in caller still depends on
-- cross-schema table access without an equivalent definer interface.
alter function vortex_file.reserve_file_upload(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, bigint, integer, integer,
  uuid, uuid, uuid, text, timestamptz, timestamptz
) owner to postgres;

commit;
