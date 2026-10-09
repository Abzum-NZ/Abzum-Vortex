create or replace function vortex_file.apply_record_owned_file_restore_cascade_internal(
  p_command_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  membership_result jsonb;
  revalidated_authority jsonb;
  effect_item jsonb;
  revalidated_item jsonb;
  membership_item jsonb;
  candidate_file_ids uuid[] := array[]::uuid[];
  candidate_file_text_value text;
  file_row vortex_file.file_records%rowtype;
  owner_effect jsonb;
  proof_files jsonb;
  settlement_items jsonb := '[]'::jsonb;
  proof_value jsonb;
  proof_digest text;
  original_deleted_at timestamptz;
  due_at timestamptz;
  stored_restore_deadline_at timestamptz;
  recovery_window_days integer;
  new_metadata_revision bigint;
  file_count integer := 0;
  expected_count integer := 0;
  effect_sequence integer;
  effect_cas jsonb;
  request_deadline_at timestamptz;
  request_timeout interval;
  request_lock_timeout interval;
  minimum_permission_deadline timestamptz;
  locked_file_count integer := 0;
  effect_has_files boolean;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'File restore command is invalid';
  end if;
  begin
    request_timeout := pg_catalog.current_setting('statement_timeout')::interval;
    request_lock_timeout := pg_catalog.current_setting('lock_timeout')::interval;
  exception when invalid_text_representation then
    request_timeout := interval '0';
    request_lock_timeout := interval '0';
  end;
  request_deadline_at := pg_catalog.statement_timestamp() + request_timeout;
  if request_timeout <= interval '0' or request_timeout > interval '30 seconds'
    or request_lock_timeout <= interval '0'
    or request_lock_timeout > interval '5 seconds'
    or request_deadline_at <= pg_catalog.clock_timestamp()
    or pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = '57014',
      message = 'File restore request is unavailable';
  end if;
  membership_result := vortex_record.read_record_file_restore_membership_internal(
    p_command_id
  );
  if membership_result ->> 'outcome' is distinct from 'complete'
    or pg_catalog.jsonb_typeof(membership_result -> 'effects') is distinct from 'array'
    or pg_catalog.jsonb_typeof(membership_result -> 'memberships') is distinct from 'array' then
    raise exception using errcode = '55000',
      message = 'File restore membership is unavailable';
  end if;

  for effect_item in
    select item.value
    from pg_catalog.jsonb_array_elements(membership_result -> 'effects') as item(value)
    order by (item.value ->> 'effectSequence')::integer
  loop
    for membership_item in
      select field.value
      from pg_catalog.jsonb_array_elements(effect_item -> 'attachmentFields') as field(value)
    loop
      for candidate_file_text_value in
        select file.value
        from pg_catalog.jsonb_array_elements_text(membership_item -> 'fileIds') as file(value)
      loop
        candidate_file_ids := pg_catalog.array_append(
          candidate_file_ids, candidate_file_text_value::uuid
        );
      end loop;
    end loop;
  end loop;

  select coalesce(pg_catalog.array_agg(item.file_id order by item.file_id), array[]::uuid[])
  into candidate_file_ids
  from (select distinct file_id from pg_catalog.unnest(candidate_file_ids) as source(file_id)) as item;
  expected_count := pg_catalog.cardinality(candidate_file_ids);

  -- Lock every candidate File row before re-reading HUMAN Record authority.
  -- No metadata CAS is allowed until the current actor, field bounds, and
  -- permission deadlines have been checked after these potentially blocking
  -- row locks.
  perform stored.file_id
  from vortex_file.file_records as stored
  where stored.organization_id =
    ((membership_result -> 'effects' -> 0) ->> 'organizationId')::uuid
    and stored.file_id = any (candidate_file_ids)
  order by stored.file_id
  for update;
  get diagnostics locked_file_count = row_count;
  if locked_file_count <> expected_count
    or request_deadline_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '40001',
      message = 'File restore membership changed';
  end if;
  revalidated_authority := vortex_record.read_record_owned_file_restore_authority_internal(
    p_command_id
  );
  if revalidated_authority ->> 'outcome' is distinct from 'prepared'
    or pg_catalog.jsonb_array_length(revalidated_authority -> 'effects') < 1
    or pg_catalog.jsonb_array_length(revalidated_authority -> 'effects') > 100
    or pg_catalog.jsonb_array_length(revalidated_authority -> 'effects') <>
      pg_catalog.jsonb_array_length(membership_result -> 'effects') then
    raise exception using errcode = '42501',
      message = 'File attachment authority changed';
  end if;
  for effect_item in
    select item.value
    from pg_catalog.jsonb_array_elements(membership_result -> 'effects') as item(value)
    order by (item.value ->> 'effectSequence')::integer
  loop
    select item.value into strict revalidated_item
    from pg_catalog.jsonb_array_elements(revalidated_authority -> 'effects') as item(value)
    where item.value ->> 'effectSequence' = effect_item ->> 'effectSequence';
    if (effect_item - array[
          'restorePermissionValidUntil', 'readPermissionValidUntil',
          'updatePermissionValidUntil'
        ]) is distinct from
       (revalidated_item - array[
          'restorePermissionValidUntil', 'readPermissionValidUntil',
          'updatePermissionValidUntil'
        ]) then
      raise exception using errcode = '40001',
        message = 'File attachment authority changed';
    end if;
    select exists (
      select 1
      from pg_catalog.jsonb_array_elements(effect_item -> 'attachmentFields') as field(value)
      cross join lateral pg_catalog.jsonb_array_elements_text(field.value -> 'fileIds') as file(value)
    ) into effect_has_files;
    stored_restore_deadline_at :=
      (effect_item ->> 'requestDeadlineAt')::timestamptz;
    minimum_permission_deadline := least(
      nullif(effect_item ->> 'restorePermissionValidUntil', '')::timestamptz,
      nullif(effect_item ->> 'readPermissionValidUntil', '')::timestamptz,
      nullif(effect_item ->> 'updatePermissionValidUntil', '')::timestamptz,
      nullif(revalidated_item ->> 'restorePermissionValidUntil', '')::timestamptz,
      nullif(revalidated_item ->> 'readPermissionValidUntil', '')::timestamptz,
      nullif(revalidated_item ->> 'updatePermissionValidUntil', '')::timestamptz,
      stored_restore_deadline_at,
      (effect_item ->> 'originalDeletedAt')::timestamptz
        + pg_catalog.make_interval(days => (effect_item ->> 'recoveryWindowDays')::integer)
    );
    if minimum_permission_deadline is null
      or (effect_has_files and (
        nullif(effect_item ->> 'readPermissionValidUntil', '') is null
        or nullif(effect_item ->> 'updatePermissionValidUntil', '') is null
        or nullif(revalidated_item ->> 'readPermissionValidUntil', '') is null
        or nullif(revalidated_item ->> 'updatePermissionValidUntil', '') is null
      ))
      or minimum_permission_deadline <= pg_catalog.clock_timestamp()
      or request_deadline_at <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '42501',
        message = 'File attachment authority expired';
    end if;
  end loop;

  file_count := 0;
  for file_row in
    select stored.*
    from vortex_file.file_records as stored
    where stored.organization_id =
      ((membership_result -> 'effects' -> 0) ->> 'organizationId')::uuid
      and stored.file_id = any (candidate_file_ids)
    order by stored.file_id
  loop
    file_count := file_count + 1;
    select membership.value into strict membership_item
    from pg_catalog.jsonb_array_elements(membership_result -> 'memberships') as membership(value)
    where (membership.value ->> 'fileId')::uuid = file_row.file_id;
    select effect.value into strict owner_effect
    from pg_catalog.jsonb_array_elements(membership_result -> 'effects') as effect(value)
    where (effect.value ->> 'storageContractId')::uuid =
        (membership_item ->> 'storageContractId')::uuid
      and (effect.value ->> 'recordTypeId')::uuid =
        (membership_item ->> 'recordTypeId')::uuid
      and (effect.value ->> 'recordId')::uuid =
        (membership_item ->> 'recordId')::uuid;

    if file_row.file_id is null
      or file_row.lifecycle_state is distinct from 'soft_deleted'
      or file_row.scanner_result is distinct from 'clean'
      or file_row.metadata_revision not between 1 and 9007199254740990
      or file_row.activated_at is null
      or file_row.application_root_id is distinct from
        (owner_effect ->> 'applicationRootId')::uuid
      or file_row.owner_record_type_id is distinct from
        (membership_item ->> 'recordTypeId')::uuid
      or file_row.owner_record_id is distinct from
        (membership_item ->> 'recordId')::uuid
      or file_row.owner_field_id is distinct from
        (membership_item ->> 'fieldId')::uuid
      or (owner_effect ->> 'storageScope') = 'application_contained'
        and (membership_item ->> 'applicationRootId') is distinct from
          (owner_effect ->> 'applicationRootId')
      or (owner_effect ->> 'storageScope') = 'organization_shared'
        and (membership_item ->> 'applicationRootId') is not null then
      raise exception using errcode = '40001',
        message = 'File attachment ownership or revision is stale';
    end if;
    if pg_catalog.jsonb_typeof(owner_effect -> 'recoveryWindowDays') is distinct from 'number'
      or (owner_effect ->> 'recoveryWindowDays') !~ '^[1-9][0-9]{0,8}$'
      or (owner_effect ->> 'recoveryWindowDays')::bigint > 104249991 then
      raise exception using errcode = '23514',
        message = 'File recovery policy is unavailable';
    end if;
    original_deleted_at := (owner_effect ->> 'originalDeletedAt')::timestamptz;
    recovery_window_days := (owner_effect ->> 'recoveryWindowDays')::integer;
    due_at := original_deleted_at + pg_catalog.make_interval(
      secs => recovery_window_days::double precision * 86400.0
    );
    stored_restore_deadline_at := (owner_effect ->> 'requestDeadlineAt')::timestamptz;
    if original_deleted_at is null or due_at <= original_deleted_at
      or file_row.deleted_at is distinct from original_deleted_at
      or file_row.removal_due_at is distinct from due_at
      or due_at <= pg_catalog.clock_timestamp()
      or stored_restore_deadline_at is null
      or stored_restore_deadline_at <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '23514',
        message = 'File recovery deadline is invalid';
    end if;

    select item.value into strict revalidated_item
    from pg_catalog.jsonb_array_elements(revalidated_authority -> 'effects') as item(value)
    where item.value ->> 'effectSequence' = owner_effect ->> 'effectSequence';
    minimum_permission_deadline := least(
      nullif(owner_effect ->> 'restorePermissionValidUntil', '')::timestamptz,
      nullif(owner_effect ->> 'readPermissionValidUntil', '')::timestamptz,
      nullif(owner_effect ->> 'updatePermissionValidUntil', '')::timestamptz,
      nullif(revalidated_item ->> 'restorePermissionValidUntil', '')::timestamptz,
      nullif(revalidated_item ->> 'readPermissionValidUntil', '')::timestamptz,
      nullif(revalidated_item ->> 'updatePermissionValidUntil', '')::timestamptz,
      stored_restore_deadline_at,
      due_at
    );
    if minimum_permission_deadline is null
      or minimum_permission_deadline <= pg_catalog.clock_timestamp()
      or request_deadline_at <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '42501',
        message = 'File attachment authority expired';
    end if;

    update vortex_file.file_records as stored
    set lifecycle_state = 'active',
      deleted_at = null,
      removal_due_at = null
    where stored.file_id = file_row.file_id
      and stored.organization_id = file_row.organization_id
      and stored.application_root_id = file_row.application_root_id
      and stored.owner_record_type_id = file_row.owner_record_type_id
      and stored.owner_record_id = file_row.owner_record_id
      and stored.owner_field_id = file_row.owner_field_id
      and stored.lifecycle_state = 'soft_deleted'
      and stored.deleted_at = original_deleted_at
      and stored.removal_due_at = due_at
      and stored.scanner_result = 'clean'
      and stored.metadata_revision = file_row.metadata_revision
    returning stored.metadata_revision into new_metadata_revision;
    if not found or new_metadata_revision <> file_row.metadata_revision + 1 then
      raise exception using errcode = '40001',
        message = 'File attachment metadata revision is stale';
    end if;

    effect_sequence := (owner_effect ->> 'effectSequence')::integer;
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'fileId', file_row.file_id,
        'fieldId', file_row.owner_field_id,
        'preMetadataRevision', file_row.metadata_revision,
        'postMetadataRevision', new_metadata_revision,
        'priorDeletedAt', vortex_context.format_timestamp_utc(original_deleted_at),
        'priorRemovalDueAt', vortex_context.format_timestamp_utc(due_at),
        'priorLifecycleState', 'soft_deleted',
        'restoredLifecycleState', 'active'
      ) order by file_row.file_id
    ), '[]'::jsonb)
    into effect_cas
    from pg_catalog.jsonb_array_elements(membership_result -> 'memberships') as member(value)
    where (member.value ->> 'storageContractId')::uuid =
        (owner_effect ->> 'storageContractId')::uuid
      and (member.value ->> 'recordTypeId')::uuid =
        (owner_effect ->> 'recordTypeId')::uuid
      and (member.value ->> 'recordId')::uuid =
        (owner_effect ->> 'recordId')::uuid
      and (member.value ->> 'fileId')::uuid = file_row.file_id;
    -- Accumulate this file's exact metadata CAS under its owning lifecycle effect.
    owner_effect := owner_effect || pg_catalog.jsonb_build_object(
      'fileCascadeProof', coalesce(owner_effect -> 'fileCascadeProof', '[]'::jsonb)
        || effect_cas
    );
    membership_result := membership_result || pg_catalog.jsonb_build_object(
      'effects', (
        select pg_catalog.jsonb_agg(
          case when (item.value ->> 'effectSequence')::integer = effect_sequence
            then owner_effect else item.value end
          order by item.ordinality
        )
        from pg_catalog.jsonb_array_elements(membership_result -> 'effects')
          with ordinality as item(value, ordinality)
      )
    );
  end loop;
  if file_count <> expected_count then
    raise exception using errcode = '40001',
      message = 'File attachment membership changed';
  end if;

  revalidated_authority := vortex_record.read_record_owned_file_restore_authority_internal(
    p_command_id
  );
  if revalidated_authority ->> 'outcome' is distinct from 'prepared'
    or pg_catalog.jsonb_array_length(revalidated_authority -> 'effects') < 1
    or pg_catalog.jsonb_array_length(revalidated_authority -> 'effects') > 100
    or pg_catalog.jsonb_array_length(revalidated_authority -> 'effects') <>
      pg_catalog.jsonb_array_length(membership_result -> 'effects') then
    raise exception using errcode = '42501',
      message = 'File attachment authority changed';
  end if;
  for effect_item in
    select item.value
    from pg_catalog.jsonb_array_elements(membership_result -> 'effects') as item(value)
    order by (item.value ->> 'effectSequence')::integer
  loop
    select item.value into strict revalidated_item
    from pg_catalog.jsonb_array_elements(revalidated_authority -> 'effects') as item(value)
    where item.value ->> 'effectSequence' = effect_item ->> 'effectSequence';
    if (effect_item - array[
          'restorePermissionValidUntil', 'readPermissionValidUntil',
          'updatePermissionValidUntil', 'fileCascadeProof'
        ]) is distinct from
       (revalidated_item - array[
          'restorePermissionValidUntil', 'readPermissionValidUntil',
          'updatePermissionValidUntil'
        ]) then
      raise exception using errcode = '40001',
        message = 'File attachment authority changed';
    end if;
    minimum_permission_deadline := least(
      nullif(effect_item ->> 'restorePermissionValidUntil', '')::timestamptz,
      nullif(effect_item ->> 'readPermissionValidUntil', '')::timestamptz,
      nullif(effect_item ->> 'updatePermissionValidUntil', '')::timestamptz,
      nullif(revalidated_item ->> 'restorePermissionValidUntil', '')::timestamptz,
      nullif(revalidated_item ->> 'readPermissionValidUntil', '')::timestamptz,
      nullif(revalidated_item ->> 'updatePermissionValidUntil', '')::timestamptz
    );
    if minimum_permission_deadline is null
      or minimum_permission_deadline <= pg_catalog.clock_timestamp()
      or request_deadline_at <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '42501',
        message = 'File attachment authority expired';
    end if;
  end loop;

  for effect_item in
    select item.value
    from pg_catalog.jsonb_array_elements(membership_result -> 'effects') as item(value)
    order by (item.value ->> 'effectSequence')::integer
  loop
    proof_files := coalesce(effect_item -> 'fileCascadeProof', '[]'::jsonb);
    proof_value := pg_catalog.jsonb_build_object(
      'version', 1,
      'commandId', p_command_id,
      'effectSequence', (effect_item ->> 'effectSequence')::integer,
      'recordProofDigest', effect_item ->> 'recordProofDigest',
      'fileMetadataCas', proof_files
    );
    proof_digest := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(proof_value::text, 'UTF8')),
      'hex'
    );
    settlement_items := settlement_items || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'effectSequence', (effect_item ->> 'effectSequence')::integer,
        'proofDigest', proof_digest
      )
    );
  end loop;

  perform vortex_record.settle_record_owned_file_restore_cascade_internal(
    p_command_id, settlement_items
  );
  return pg_catalog.jsonb_build_object('outcome', 'settled');
end
$function$;

alter function vortex_file.apply_record_owned_file_restore_cascade_internal(uuid)
  owner to vortex_file_owner;

revoke all on function vortex_file.apply_record_owned_file_restore_cascade_internal(uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_file.apply_record_owned_file_restore_cascade_internal(uuid)
  to vortex_runtime;
comment on function vortex_file.apply_record_owned_file_restore_cascade_internal(uuid) is
  'Applies the exact current HUMAN Record-owned File restore CAS and private lifecycle-effect settlement in the same request transaction, preserving File content, metadata, references and legal holds.';
