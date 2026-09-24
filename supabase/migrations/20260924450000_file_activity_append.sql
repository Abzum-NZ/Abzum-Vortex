-- #744: append content-free Activity for private File operations.
--
-- The File service already owns admission, activation and private download
-- grants. This migration wires those living operations to the single existing
-- Activity append owner (#252/#743): every successful admission, activation and
-- download grant records one entry in the same transaction as its write, and a
-- clean pre-write permission refusal records one content-free refusal before it
-- returns. Other failures record nothing (docs/specification/14, "Activity
-- history"). No value, file content, storage address, exception text or
-- business payload is recorded; entries carry only the fixed action meaning, the
-- verified actor, the organisation, the request correlation and one verified
-- local subject identifier.
--
-- The identity is deterministic: a version-8 RFC 9562 UUID derived from the
-- action, organisation, correlation and subject. An exact retry therefore names
-- the same entry and records nothing new.
--
-- Main keeps rewriting these functions in place, so each live body is patched
-- from its current pg_get_functiondef with an exactly-once guard: ownership,
-- grants, comments and dependencies stay untouched, and drift fails the
-- migration instead of silently editing an unexpected body. Each body is
-- re-created under its function's own current owner.

begin;

-- ----------------------------------------------------------------------------
-- Deterministic Activity identity
-- ----------------------------------------------------------------------------
-- A version-8 UUID over the fixed action, organisation, request correlation and
-- subject. It never carries remote values and is stable for one exact
-- operation, so a retry reuses the same identity.
create function vortex_file.file_activity_id(
  p_action text,
  p_organization_id uuid,
  p_correlation_id uuid,
  p_subject_id uuid
)
returns uuid
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  hash_hex text;
begin
  if p_action is null
    or pg_catalog.char_length(p_action) not between 1 and 40
    or p_action !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_subject_id is null
    or p_subject_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'File Activity identity input is invalid';
  end if;

  hash_hex := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      p_action || E'\x1f' || p_organization_id::text || E'\x1f'
        || p_correlation_id::text || E'\x1f' || p_subject_id::text, 'UTF8')),
    'hex'
  );

  return (
    pg_catalog.substr(hash_hex, 1, 8) || '-'
    || pg_catalog.substr(hash_hex, 9, 4) || '-'
    || '8' || pg_catalog.substr(hash_hex, 14, 3) || '-'
    || pg_catalog.substr(
         '89ab',
         1 + ((pg_catalog.strpos(
           '0123456789abcdef', pg_catalog.substr(hash_hex, 17, 1)
         ) - 1) % 4),
         1
       ) || pg_catalog.substr(hash_hex, 18, 3) || '-'
    || pg_catalog.substr(hash_hex, 21, 12)
  )::uuid;
end
$function$;

-- The one closed File Activity composer. It accepts only a fixed action and one
-- subject the calling owner has already verified as local, reads the verified
-- actor and current organisation/correlation from the request context, and
-- invokes the existing private Activity append as its owner. A request without a
-- verified human or system actor appends nothing. Because the identity is
-- derived from the operation, an entry that already exists is the same operation
-- retried: it records nothing new rather than appending or conflicting on its
-- later occurrence time. The identity lock makes a concurrent retry wait for the
-- first and then find its entry.
create function vortex_file.append_file_activity_internal(
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

revoke execute on function
  vortex_file.file_activity_id(text, uuid, uuid, uuid),
  vortex_file.append_file_activity_internal(text, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

-- ----------------------------------------------------------------------------
-- Guarded in-place patches of the live file function bodies
-- ----------------------------------------------------------------------------

-- Replaces one exact fragment of a function definition, and only once.
create function pg_temp.file_activity_patch(p_definition text, p_old text, p_new text)
returns text
language plpgsql
as $function$
begin
  if (pg_catalog.length(p_definition)
      - pg_catalog.length(pg_catalog.replace(p_definition, p_old, '')))
      / pg_catalog.length(p_old) <> 1 then
    raise exception 'File activity patch does not match exactly once: %',
      pg_catalog.left(p_old, 80);
  end if;
  return pg_catalog.replace(p_definition, p_old, p_new);
end
$function$;

do $patch$
declare
  definition text;
  procedure_id pg_catalog.regprocedure;
  owner_name name;
begin
  -- Admission: the admitted upload records one entry in the same transaction as
  -- its write. A refused funding capability is the admission's permission
  -- refusal; the proposed file does not exist, so the refusal names the verified
  -- request organisation instead. An exact retry of an admitted upload, which
  -- finds its own funded reservation, records nothing new. Replacement
  -- and field-capacity refusals are not permission refusals and record nothing.
  procedure_id := pg_catalog.to_regprocedure(
    'vortex_file.reserve_file_upload(uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, bigint, integer, integer, uuid, uuid, uuid, text, timestamptz, timestamptz)'
  );
  if procedure_id is null then
    raise exception 'File activity patch target is unavailable: reserve_file_upload';
  end if;
  definition := pg_catalog.replace(
    pg_catalog.pg_get_functiondef(procedure_id), E'\r\n', E'\n'
  );
  if pg_catalog.strpos(definition, 'append_file_activity_internal') = 0 then
    definition := pg_temp.file_activity_patch(definition,
      $old$  for update;
  if not found then
    return vortex_file.upload_refusal('capability_refused');
  end if;$old$,
      $new$  for update;
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
  end if;$new$);

    definition := pg_temp.file_activity_patch(definition,
      $old$    where reservation.capability_reservation_id = p_capability_reservation_id
  ) then
    return vortex_file.upload_refusal('capability_refused');
  end if;$old$,
      $new$    where reservation.capability_reservation_id = p_capability_reservation_id
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
  end if;$new$);

    definition := pg_temp.file_activity_patch(definition,
      $old$  return pg_catalog.jsonb_build_object(
    'outcome', 'reserved',
    'fileRecord', vortex_file.upload_file_record(reserved)
  );$old$,
      $new$  perform vortex_file.append_file_activity_internal(
    'file_upload_admitted', p_file_id);

  return pg_catalog.jsonb_build_object(
    'outcome', 'reserved',
    'fileRecord', vortex_file.upload_file_record(reserved)
  );$new$);

    select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
    from pg_catalog.pg_proc as procedure
    where procedure.oid = procedure_id;
    execute pg_catalog.format('set local role %I', owner_name);
    execute definition;
    reset role;
  end if;

  -- Activation: one activation entry. A caller that is not the file's uploader
  -- is the permission refusal and names the verified local file. The idempotent
  -- already-active return, a missing file and the lifecycle, expiry, revision,
  -- owner and replacement refusals record nothing.
  procedure_id := pg_catalog.to_regprocedure(
    'vortex_file.activate_uploaded_file(uuid, bigint, uuid, uuid, uuid, uuid, uuid)'
  );
  if procedure_id is null then
    raise exception 'File activity patch target is unavailable: activate_uploaded_file';
  end if;
  definition := pg_catalog.replace(
    pg_catalog.pg_get_functiondef(procedure_id), E'\r\n', E'\n'
  );
  if pg_catalog.strpos(definition, 'append_file_activity_internal') = 0 then
    definition := pg_temp.file_activity_patch(definition,
      $old$    return vortex_file.upload_refusal('caller_not_authorized');$old$,
      $new$    perform vortex_file.append_file_activity_internal(
      'file_activation_refused', p_file_id);
    return vortex_file.upload_refusal('caller_not_authorized');$new$);

    definition := pg_temp.file_activity_patch(definition,
      $old$  return pg_catalog.jsonb_build_object(
    'outcome', 'activated',
    'fileRecord', vortex_file.upload_file_record(uploaded)
  );$old$,
      $new$  perform vortex_file.append_file_activity_internal(
    'file_activated', p_file_id);

  return pg_catalog.jsonb_build_object(
    'outcome', 'activated',
    'fileRecord', vortex_file.upload_file_record(uploaded)
  );$new$);

    select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
    from pg_catalog.pg_proc as procedure
    where procedure.oid = procedure_id;
    execute pg_catalog.format('set local role %I', owner_name);
    execute definition;
    reset role;
  end if;

  -- Download grant: one grant entry. Read permission is decided upstream by
  -- decide_file_read; this owner's refusal is a lifecycle and attachment recheck
  -- of the file, not a permission refusal, and records nothing.
  procedure_id := pg_catalog.to_regprocedure(
    'vortex_file.record_file_download_grant(uuid, uuid, uuid, uuid, uuid, jsonb, text, uuid, timestamptz)'
  );
  if procedure_id is null then
    raise exception 'File activity patch target is unavailable: record_file_download_grant';
  end if;
  definition := pg_catalog.replace(
    pg_catalog.pg_get_functiondef(procedure_id), E'\r\n', E'\n'
  );
  if pg_catalog.strpos(definition, 'append_file_activity_internal') = 0 then
    definition := pg_temp.file_activity_patch(definition,
      $old$  return pg_catalog.jsonb_build_object('outcome', 'recorded');$old$,
      $new$  perform vortex_file.append_file_activity_internal(
    'file_download_granted', p_file_id);

  return pg_catalog.jsonb_build_object('outcome', 'recorded');$new$);

    select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
    from pg_catalog.pg_proc as procedure
    where procedure.oid = procedure_id;
    execute pg_catalog.format('set local role %I', owner_name);
    execute definition;
    reset role;
  end if;
end
$patch$;

drop function pg_temp.file_activity_patch(text, text, text);

comment on function vortex_file.file_activity_id(text, uuid, uuid, uuid) is
  'The deterministic version-8 Activity identity of one File operation, derived from its action, organisation, correlation and subject.';
comment on function vortex_file.append_file_activity_internal(text, uuid) is
  'Appends one content-free File Activity entry for the verified request actor; used by the admission, activation and download-grant owners.';

commit;
