-- #836: Upload admission checks funding, capacity and caller in the database.
--
-- The #652 upload functions trusted the caller for three things: that the
-- capability reservation existed and funded this upload, how many files the field
-- already held, and that the request's account was still live. This migration
-- patches the live bodies of the six upload functions in place (each patch is
-- guarded so it applies exactly once, and fails loudly if the live body is not the
-- text it expects) so that:
--   * every upload function validates the request context (an inactive account or
--     a stale Access version is refused; registered system actors keep working);
--   * admission locks and verifies the funding reservation (organisation, tenant,
--     correlation, active state, unexpired, unconsumed quantity) and binds it with a
--     foreign key;
--   * admission binds the Application to the request's Application and caps the
--     admitted bytes at the platform maximum;
--   * admission counts the field's attachments from file_records under the field
--     lock instead of trusting the caller's count, and activation takes the same
--     lock and recounts against the field's maximum recorded at admission.

begin;

-- ----------------------------------------------------------------------------
-- New helpers, columns and constraints
-- ----------------------------------------------------------------------------

-- The largest single file any attachment field may accept: the 5000 MB ceiling
-- of `max_file_size_mb` in the field contract.
create function vortex_file.upload_maximum_bytes_limit()
returns bigint
language sql
immutable
set search_path = ''
as $function$
  select 5000::bigint * 1024 * 1024
$function$;

-- The established context of an upload request. A human caller must still have
-- an active organisation account and a current Access version; a registered
-- system actor has no organisation account and is verified by its context alone.
create function vortex_file.upload_validated_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  established jsonb := vortex_context.current_context();
begin
  if established ->> 'callerKind' = 'human' then
    return vortex_access.validated_human_request_context();
  end if;
  return established;
end
$function$;

-- The field's maximum file count as admitted, so activation can recount without
-- trusting its caller. Uploads admitted before this change carry no maximum.
alter table vortex_file.upload_reservations
  add column if not exists max_files integer
    constraint upload_reservations_max_files_positive check (max_files is null or max_files >= 1);

-- The funding reservation must exist. Rows admitted before this change may name
-- reservations that never existed, so existing rows are not revalidated; every new
-- row is checked.
do $guard$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint as existing
    where existing.conrelid = 'vortex_file.upload_reservations'::regclass
      and existing.conname = 'upload_reservations_capability_reservation_fk'
  ) then
    alter table vortex_file.upload_reservations
      add constraint upload_reservations_capability_reservation_fk
      foreign key (capability_reservation_id)
      references vortex_access.capability_reservations (reservation_id)
      not valid;
  end if;
end
$guard$;

revoke execute on function
  vortex_file.upload_maximum_bytes_limit(),
  vortex_file.upload_validated_context()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

-- ----------------------------------------------------------------------------
-- Guarded in-place patches of the live function bodies
-- ----------------------------------------------------------------------------

-- Replaces one exact fragment of a function definition, and only once.
create function pg_temp.upload_patch(p_definition text, p_old text, p_new text)
returns text
language plpgsql
as $function$
begin
  if (pg_catalog.length(p_definition)
      - pg_catalog.length(pg_catalog.replace(p_definition, p_old, '')))
      / pg_catalog.length(p_old) <> 1 then
    raise exception 'Upload function body is not the expected text for patch: %',
      pg_catalog.left(p_old, 80);
  end if;
  return pg_catalog.replace(p_definition, p_old, p_new);
end
$function$;

do $patch$
declare
  definition text;
  target oid;
  context_old constant text :=
    'established jsonb := vortex_context.current_context();';
  context_new constant text :=
    'established jsonb := vortex_file.upload_validated_context();';
begin
  -- Context validation for the four functions that need no other change.
  foreach target in array array[
    to_regprocedure('vortex_file.read_file_upload(uuid)')::oid,
    to_regprocedure('vortex_file.claim_file_upload_grant(uuid)')::oid,
    to_regprocedure('vortex_file.renew_file_upload(uuid, bigint, uuid, uuid, text, timestamptz)')::oid,
    to_regprocedure('vortex_file.record_file_upload_outcome(uuid, bigint, text, bigint, text, text, text, text)')::oid
  ] loop
    if target is null then
      raise exception 'Upload function is missing';
    end if;
    definition := pg_catalog.pg_get_functiondef(target);
    if pg_catalog.position('vortex_file.upload_validated_context()' in definition) = 0 then
      execute pg_temp.upload_patch(definition, context_old, context_new);
    end if;
  end loop;

  -- Admission.
  target := to_regprocedure(
    'vortex_file.reserve_file_upload(uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, bigint, integer, integer, uuid, uuid, uuid, text, timestamptz, timestamptz)'
  )::oid;
  if target is null then
    raise exception 'Upload function is missing';
  end if;
  definition := pg_catalog.pg_get_functiondef(target);
  if pg_catalog.position('vortex_file.upload_validated_context()' in definition) = 0 then
    definition := pg_temp.upload_patch(definition, context_old, context_new);

    definition := pg_temp.upload_patch(definition,
      $old$  in_flight_count bigint;
$old$,
      $new$  in_flight_count bigint;
  existing_count bigint;
$new$);

    -- The Application must be the request's own Application.
    definition := pg_temp.upload_patch(definition,
      $old$    or p_organization_id is distinct from (established ->> 'organizationId')::uuid
    or p_uploaded_by is distinct from request_actor then$old$,
      $new$    or p_organization_id is distinct from (established ->> 'organizationId')::uuid
    or p_application_root_id is distinct from (established ->> 'applicationRootId')::uuid
    or p_uploaded_by is distinct from request_actor then$new$);

    definition := pg_temp.upload_patch(definition,
      $old$    or p_maximum_bytes is null or p_maximum_bytes < 1
$old$,
      $new$    or p_maximum_bytes is null or p_maximum_bytes < 1
    or p_maximum_bytes > vortex_file.upload_maximum_bytes_limit()
$new$);

    -- The funding reservation must be a live reservation of this request.
    definition := pg_temp.upload_patch(definition,
      $old$  if exists (
    select 1 from vortex_file.upload_reservations as reservation
    where reservation.capability_reservation_id = p_capability_reservation_id
  ) then$old$,
      $new$  perform 1
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
    return vortex_file.upload_refusal('capability_refused');
  end if;

  if exists (
    select 1 from vortex_file.upload_reservations as reservation
    where reservation.capability_reservation_id = p_capability_reservation_id
  ) then$new$);

    -- The field's attachments are counted here, under the field lock.
    definition := pg_temp.upload_patch(definition,
      $old$  if p_replacing_file_id is not null and (
    p_existing_attachment_count < 1
$old$,
      $new$  select pg_catalog.count(*) into existing_count
  from vortex_file.file_records as attached
  where attached.organization_id = p_organization_id
    and attached.owner_record_type_id = p_owner_record_type_id
    and attached.owner_record_id = p_owner_record_id
    and attached.owner_field_id = p_owner_field_id
    and attached.lifecycle_state = 'active';

  if p_replacing_file_id is not null and (
    existing_count < 1
$new$);

    definition := pg_temp.upload_patch(definition,
      $old$  if p_existing_attachment_count
    - (case$old$,
      $new$  if existing_count
    - (case$new$);

    definition := pg_temp.upload_patch(definition,
      $old$    correlation_id, upload_expires_at, revision, created_at, updated_at
  ) values ($old$,
      $new$    correlation_id, upload_expires_at, revision, created_at, updated_at, max_files
  ) values ($new$);

    definition := pg_temp.upload_patch(definition,
      $old$    (established ->> 'correlationId')::uuid, p_upload_expires_at, 1, evaluated_at, evaluated_at
  );$old$,
      $new$    (established ->> 'correlationId')::uuid, p_upload_expires_at, 1, evaluated_at, evaluated_at,
    p_max_files
  );$new$);

    execute definition;
  end if;

  -- Activation.
  target := to_regprocedure(
    'vortex_file.activate_uploaded_file(uuid, bigint, uuid, uuid, uuid, uuid, uuid)'
  )::oid;
  if target is null then
    raise exception 'Upload function is missing';
  end if;
  definition := pg_catalog.pg_get_functiondef(target);
  if pg_catalog.position('vortex_file.upload_validated_context()' in definition) = 0 then
    definition := pg_temp.upload_patch(definition, context_old, context_new);

    definition := pg_temp.upload_patch(definition,
      $old$  uploaded vortex_file.file_records%rowtype;
begin
  if p_attachment_reference_id is null$old$,
      $new$  uploaded vortex_file.file_records%rowtype;
  attached_count bigint;
begin
  if p_attachment_reference_id is null$new$);

    -- The same field lock admission takes, before any row lock, so admission and
    -- activation on one field serialise in one order.
    definition := pg_temp.upload_patch(definition,
      $old$    raise exception using errcode = '22023', message = 'File activation is invalid';
  end if;
$old$,
      $new$    raise exception using errcode = '22023', message = 'File activation is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f',
      'vortex_file.upload_field', (established ->> 'organizationId'),
      p_owner_record_type_id::text, p_owner_record_id::text, p_owner_field_id::text), 652)
  );
$new$);

    -- Recount the field's active attachments against the maximum recorded at
    -- admission. A save that would exceed it fails, rolling the record save back.
    definition := pg_temp.upload_patch(definition,
      $old$  update vortex_file.file_records
  set
    lifecycle_state = 'active',$old$,
      $new$  if reservation.max_files is not null then
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
    lifecycle_state = 'active',$new$);

    execute definition;
  end if;
end
$patch$;

drop function pg_temp.upload_patch(text, text, text);

comment on column vortex_file.upload_reservations.max_files is
  'The attachment field''s maximum file count as admitted; activation recounts the field against it.';
comment on function vortex_file.upload_validated_context() is
  'The established upload request context: a human caller must have a live account and current Access version.';
comment on function vortex_file.upload_maximum_bytes_limit() is
  'The platform ceiling for one uploaded file, matching the 5000 MB field maximum.';

commit;
