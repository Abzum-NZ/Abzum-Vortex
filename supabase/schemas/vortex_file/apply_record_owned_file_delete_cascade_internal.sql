create or replace function vortex_file.apply_record_owned_file_delete_cascade_internal(
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
  effect_item jsonb;
  membership_item jsonb;
  candidate_file_ids uuid[] := array[]::uuid[];
  candidate_file_text text[] := array[]::text[];
  candidate_file_text_value text;
  file_row vortex_file.file_records%rowtype;
  owner_effect jsonb;
  proof_files jsonb;
  settlement_items jsonb := '[]'::jsonb;
  proof_value jsonb;
  proof_digest text;
  record_deleted_at timestamptz;
  due_at timestamptz;
  recovery_window_days integer;
  new_metadata_revision bigint;
  file_count integer := 0;
  expected_count integer := 0;
  effect_sequence integer;
  effect_cas jsonb;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'File cascade command is invalid';
  end if;
  membership_result := vortex_record.read_record_file_lifecycle_membership_internal(
    p_command_id
  );
  if membership_result ->> 'outcome' is distinct from 'complete'
    or pg_catalog.jsonb_typeof(membership_result -> 'effects') is distinct from 'array'
    or pg_catalog.jsonb_typeof(membership_result -> 'memberships') is distinct from 'array' then
    raise exception using errcode = '55000',
      message = 'File cascade membership is unavailable';
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
        candidate_file_text := pg_catalog.array_append(
          candidate_file_text, candidate_file_text_value
        );
        candidate_file_ids := pg_catalog.array_append(
          candidate_file_ids, candidate_file_text_value::uuid
        );
      end loop;
    end loop;
  end loop;

  select coalesce(pg_catalog.array_agg(item.file_id order by item.file_id), array[]::uuid[])
  into candidate_file_ids
  from (select distinct file_id from pg_catalog.unnest(candidate_file_ids) as source(file_id)) as item;
  select coalesce(pg_catalog.array_agg(item.file_id::text order by item.file_id), array[]::text[])
  into candidate_file_text
  from pg_catalog.unnest(candidate_file_ids) as item(file_id);
  expected_count := pg_catalog.cardinality(candidate_file_ids);

  for file_row in
    select stored.*
    from vortex_file.file_records as stored
    where stored.organization_id =
      ((membership_result -> 'effects' -> 0) ->> 'organizationId')::uuid
      and stored.file_id = any (candidate_file_ids)
    order by stored.file_id
    for update
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
      or file_row.lifecycle_state is distinct from 'active'
      or file_row.deleted_at is not null
      or file_row.removal_due_at is not null
      or file_row.metadata_revision not between 1 and 9007199254740990
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
    record_deleted_at := (owner_effect ->> 'recordDeletedAt')::timestamptz;
    recovery_window_days := (owner_effect ->> 'recoveryWindowDays')::integer;
    due_at := record_deleted_at + pg_catalog.make_interval(
      secs => recovery_window_days::double precision * 86400.0
    );
    if record_deleted_at is null or due_at <= record_deleted_at then
      raise exception using errcode = '23514',
        message = 'File recovery deadline is invalid';
    end if;

    update vortex_file.file_records as stored
    set lifecycle_state = 'soft_deleted',
      deleted_at = record_deleted_at,
      removal_due_at = due_at
    where stored.file_id = file_row.file_id
      and stored.organization_id = file_row.organization_id
      and stored.application_root_id = file_row.application_root_id
      and stored.owner_record_type_id = file_row.owner_record_type_id
      and stored.owner_record_id = file_row.owner_record_id
      and stored.owner_field_id = file_row.owner_field_id
      and stored.lifecycle_state = 'active'
      and stored.deleted_at is null
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
        'deletedAt', vortex_context.format_timestamp_utc(record_deleted_at),
        'removalDueAt', vortex_context.format_timestamp_utc(due_at)
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

  perform vortex_record.settle_record_owned_file_delete_cascade_internal(
    p_command_id, settlement_items
  );
  return pg_catalog.jsonb_build_object('outcome', 'settled');
end
$function$;

alter function vortex_file.apply_record_owned_file_delete_cascade_internal(uuid)
  owner to vortex_file_owner;

revoke all on function vortex_file.apply_record_owned_file_delete_cascade_internal(uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_file.apply_record_owned_file_delete_cascade_internal(uuid)
  to vortex_runtime;
comment on function vortex_file.apply_record_owned_file_delete_cascade_internal(uuid) is
  'Applies the exact current HUMAN Record-owned File soft-delete CAS and private lifecycle-effect settlement in the same request transaction, preserving File content, metadata, references and legal holds.';
