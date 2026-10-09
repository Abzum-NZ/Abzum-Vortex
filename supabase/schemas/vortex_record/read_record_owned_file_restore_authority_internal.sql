create or replace function vortex_record.read_record_owned_file_restore_authority_internal(
  p_command_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.record_lifecycle_command_receipts%rowtype;
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  restore_meta jsonb;
  read_meta jsonb;
  update_meta jsonb;
  restore_loaded jsonb;
  read_loaded jsonb;
  update_loaded jsonb;
  facts jsonb;
  decision jsonb;
  read_decision jsonb;
  update_decision jsonb;
  read_bounds jsonb;
  update_bounds jsonb;
  record_fact jsonb;
  attachment_field jsonb;
  attachment_value jsonb;
  attachment_fields jsonb := '[]'::jsonb;
  attachment_file_ids uuid[];
  attachment_file_id uuid;
  attachment_file_text text;
  attachment_field_count integer := 0;
  total_attachment_file_count integer := 0;
  has_attachments boolean := false;
  policy_value jsonb;
  proof_value jsonb;
  proof_digest text;
  restore_permission_valid_until timestamptz;
  read_permission_valid_until timestamptz;
  update_permission_valid_until timestamptz;
  request_timeout interval;
  request_lock_timeout interval;
  request_deadline_at timestamptz;
  effect_count integer;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Record File restore command is invalid';
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
      message = 'Record File restore request is unavailable';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record File restore requires an Application context';
  end if;
  select stored.* into receipt
  from vortex_record.record_lifecycle_command_receipts as stored
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and stored.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and stored.command_id = p_command_id
  for update;
  if not found
    or receipt.state is distinct from 'pending'
    or receipt.operation is distinct from 'restore' then
    raise exception using errcode = '42501',
      message = 'Record File restore receipt is unavailable';
  end if;

  select pg_catalog.count(*) into effect_count
  from (
    select 1
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id
    limit 2
  ) as bounded_effects;
  if effect_count <> 1 then
    raise exception using errcode = '55000',
      message = 'Record File restore effect is incomplete';
  end if;
  select effect.* into strict effect_row
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = receipt.organization_id
    and effect.application_root_id = receipt.application_root_id
    and effect.actor_organization_account_id = receipt.actor_organization_account_id
    and effect.command_id = receipt.command_id
    and effect.effect_kind = 'restored'
    and effect.record_type_id = receipt.record_type_id
    and effect.record_id = receipt.record_id
    and effect.pre_concurrency_number = receipt.expected_concurrency_number
  for update;
  if effect_row.restore_original_deleted_at is null
    or effect_row.restore_policy_revision is null
    or effect_row.restore_recovery_window_days is null
    or effect_row.restore_recovery_window_days not between 1 and 104249991
    or effect_row.restore_request_deadline_at is null
    or effect_row.restore_request_deadline_at <= pg_catalog.clock_timestamp()
    or effect_row.file_cascade_proof_digest is null
    or effect_row.file_cascade_proof_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '55000',
      message = 'Record File restore proof is unavailable';
  end if;

  restore_meta := vortex_record.resolve_record_action_context_internal(
    effect_row.record_type_id, 'restore'
  );
  read_meta := vortex_record.resolve_record_action_context_internal(
    effect_row.record_type_id, 'read'
  );
  update_meta := vortex_record.resolve_record_action_context_internal(
    effect_row.record_type_id, 'update'
  );
  if restore_meta ? 'previewInstallationId'
    or read_meta ? 'previewInstallationId'
    or update_meta ? 'previewInstallationId'
    or pg_catalog.jsonb_typeof(restore_meta -> 'declaration') is distinct from 'object'
    or pg_catalog.jsonb_typeof(read_meta -> 'declaration') is distinct from 'object'
    or pg_catalog.jsonb_typeof(update_meta -> 'declaration') is distinct from 'object'
    or (restore_meta ->> 'storageContractId') is distinct from effect_row.storage_contract_id::text
    or (read_meta ->> 'storageContractId') is distinct from effect_row.storage_contract_id::text
    or (update_meta ->> 'storageContractId') is distinct from effect_row.storage_contract_id::text
    or (read_meta ->> 'moduleRootId') is distinct from (restore_meta ->> 'moduleRootId')
    or (update_meta ->> 'moduleRootId') is distinct from (restore_meta ->> 'moduleRootId')
    or (read_meta ->> 'moduleReleaseRevision') is distinct from
      (restore_meta ->> 'moduleReleaseRevision')
    or (update_meta ->> 'moduleReleaseRevision') is distinct from
      (restore_meta ->> 'moduleReleaseRevision') then
    raise exception using errcode = '42501',
      message = 'Record File restore source is unavailable';
  end if;
  if effect_row.restore_request_deadline_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '57014',
      message = 'Record File restore request deadline expired';
  end if;

  restore_loaded := vortex_record.load_record_access_facts_internal(
    effect_row.record_type_id, 'restore', effect_row.record_id, null
  );
  read_loaded := vortex_record.load_record_access_facts_internal(
    effect_row.record_type_id, 'read', effect_row.record_id, null
  );
  update_loaded := vortex_record.load_record_access_facts_internal(
    effect_row.record_type_id, 'update', effect_row.record_id, null
  );
  if restore_loaded ->> 'outcome' is distinct from 'loaded'
    or read_loaded ->> 'outcome' is distinct from 'loaded'
    or update_loaded ->> 'outcome' is distinct from 'loaded'
    or (restore_loaded ->> 'concurrencyNumber')::bigint is distinct from
      effect_row.post_concurrency_number
    or (read_loaded ->> 'concurrencyNumber')::bigint is distinct from
      effect_row.post_concurrency_number
    or (update_loaded ->> 'concurrencyNumber')::bigint is distinct from
      effect_row.post_concurrency_number
    or (restore_loaded ->> 'definitionRevision')::bigint is distinct from
      (restore_meta ->> 'moduleReleaseRevision')::bigint
    or (read_loaded ->> 'definitionRevision')::bigint is distinct from
      (restore_meta ->> 'moduleReleaseRevision')::bigint
    or (update_loaded ->> 'definitionRevision')::bigint is distinct from
      (restore_meta ->> 'moduleReleaseRevision')::bigint then
    raise exception using errcode = '40001',
      message = 'Record File restore revision is stale';
  end if;
  select item.value into record_fact
  from pg_catalog.jsonb_array_elements(restore_loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'storageContractId')::uuid =
      effect_row.storage_contract_id
    and (item.value -> 'recordScope' ->> 'recordId')::uuid = effect_row.record_id
    and (item.value -> 'recordScope' ->> 'recordTypeId')::uuid = effect_row.record_type_id;
  if record_fact ->> 'lifecycleState' is distinct from 'active' then
    raise exception using errcode = '40001',
      message = 'Record File restore owner is stale';
  end if;
  facts := restore_loaded -> 'facts';
  decision := vortex_access.evaluate_organization_record_access_internal(
    restore_meta -> 'declaration', effect_row.record_id,
    facts || pg_catalog.jsonb_build_object(
      'binding', restore_meta -> 'declaration' -> 'recordBinding'
    )
  );
  restore_permission_valid_until := nullif(decision ->> 'validUntil', '')::timestamptz;
  if decision ->> 'outcome' is distinct from 'allowed'
    or restore_permission_valid_until is null
    or restore_permission_valid_until <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '42501',
      message = 'Record File restore authority is unavailable';
  end if;

  select item.value into record_fact
  from pg_catalog.jsonb_array_elements(read_loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'storageContractId')::uuid =
      effect_row.storage_contract_id
    and (item.value -> 'recordScope' ->> 'recordId')::uuid = effect_row.record_id;
  if record_fact ->> 'lifecycleState' is distinct from 'active' then
    raise exception using errcode = '40001',
      message = 'File attachment owner is stale';
  end if;
  read_decision := vortex_access.evaluate_organization_record_access_internal(
    read_meta -> 'declaration', effect_row.record_id,
    read_loaded -> 'facts' || pg_catalog.jsonb_build_object(
      'binding', read_meta -> 'declaration' -> 'recordBinding'
    )
  );
  select item.value into record_fact
  from pg_catalog.jsonb_array_elements(update_loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'storageContractId')::uuid =
      effect_row.storage_contract_id
    and (item.value -> 'recordScope' ->> 'recordId')::uuid = effect_row.record_id;
  if record_fact ->> 'lifecycleState' is distinct from 'active' then
    raise exception using errcode = '40001',
      message = 'File attachment owner is stale';
  end if;
  update_decision := vortex_access.evaluate_organization_record_access_internal(
    update_meta -> 'declaration', effect_row.record_id,
    update_loaded -> 'facts' || pg_catalog.jsonb_build_object(
      'binding', update_meta -> 'declaration' -> 'recordBinding'
    )
  );
  read_permission_valid_until := nullif(read_decision ->> 'validUntil', '')::timestamptz;
  update_permission_valid_until := nullif(update_decision ->> 'validUntil', '')::timestamptz;
  read_bounds := vortex_access.resolve_record_field_bounds_internal(read_decision);
  update_bounds := vortex_access.resolve_record_field_bounds_internal(update_decision);
  attachment_fields := '[]'::jsonb;
  for attachment_field in
    select declared.value
    from pg_catalog.jsonb_array_elements(restore_meta -> 'recordType' -> 'fields') as declared(value)
    where declared.value ->> 'type' = 'attachment'
    order by pg_catalog.lower(declared.value ->> 'fieldId') collate "C"
  loop
    attachment_field_count := attachment_field_count + 1;
    if attachment_field_count > 500 then
      raise exception using errcode = '57014',
        message = 'Record File attachment field limit exceeded';
    end if;
    attachment_file_ids := array[]::uuid[];
    attachment_value := restore_loaded -> 'fieldValues' -> pg_catalog.lower(
      attachment_field ->> 'fieldId'
    );
    if attachment_value is not null
      and pg_catalog.jsonb_typeof(attachment_value) <> 'null' then
      if pg_catalog.jsonb_typeof(attachment_value) <> 'array'
        or pg_catalog.jsonb_array_length(attachment_value) > 100 then
        raise exception using errcode = '23514',
          message = 'Attachment ownership is invalid';
      end if;
      for attachment_file_text in
        select item.value
        from pg_catalog.jsonb_array_elements_text(attachment_value) as item(value)
      loop
        if total_attachment_file_count >= 1000 then
          raise exception using errcode = '57014',
            message = 'Record File attachment value limit exceeded';
        end if;
        begin
          attachment_file_id := attachment_file_text::uuid;
        exception when invalid_text_representation then
          raise exception using errcode = '23514',
            message = 'Attachment ownership is invalid';
        end;
        if not vortex_context.is_non_nil_uuid(attachment_file_id::text)
          or attachment_file_id = any (attachment_file_ids) then
          raise exception using errcode = '23514',
            message = 'Attachment ownership is invalid';
        end if;
        attachment_file_ids := pg_catalog.array_append(attachment_file_ids, attachment_file_id);
        total_attachment_file_count := total_attachment_file_count + 1;
      end loop;
    end if;
    if pg_catalog.cardinality(attachment_file_ids) > 0 then
      has_attachments := true;
    end if;
    select coalesce(pg_catalog.array_agg(item.file_id order by item.file_id), array[]::uuid[])
    into attachment_file_ids
    from pg_catalog.unnest(attachment_file_ids) as item(file_id);
    attachment_fields := attachment_fields || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'fieldId', pg_catalog.lower(attachment_field ->> 'fieldId'),
        'fileIds', pg_catalog.to_jsonb(attachment_file_ids)
      )
    );
  end loop;
  if has_attachments then
    if read_decision ->> 'outcome' is distinct from 'allowed'
      or update_decision ->> 'outcome' is distinct from 'allowed'
      or read_permission_valid_until is null
      or update_permission_valid_until is null
      or read_permission_valid_until <= pg_catalog.clock_timestamp()
      or update_permission_valid_until <= pg_catalog.clock_timestamp()
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(attachment_fields) as field_item(value)
        where pg_catalog.jsonb_array_length(field_item.value -> 'fileIds') > 0
          and (
            not exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(read_bounds -> 'readableFieldIds') as allowed(value)
              where pg_catalog.lower(allowed.value) = field_item.value ->> 'fieldId'
            )
            or not exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(update_bounds -> 'changeableFieldIds') as allowed(value)
              where pg_catalog.lower(allowed.value) = field_item.value ->> 'fieldId'
            )
          )
      ) then
      raise exception using errcode = '42501',
        message = 'File attachment authority is unavailable';
    end if;
  end if;

  policy_value := vortex_record.lock_record_recovery_policy_internal(
    receipt.organization_id, effect_row.storage_contract_id,
    case when restore_meta ->> 'storageScope' = 'application_contained'
      then receipt.application_root_id else null end
  );
  if policy_value ->> 'action' is distinct from 'delete'
    or pg_catalog.jsonb_typeof(policy_value -> 'recoveryWindowDays') is distinct from 'number'
    or (policy_value ->> 'recoveryWindowDays') !~ '^[1-9][0-9]{0,8}$'
    or (policy_value ->> 'recoveryWindowDays')::integer is distinct from
      effect_row.restore_recovery_window_days
    or (policy_value ->> 'policyRevision')::bigint is distinct from
      effect_row.restore_policy_revision then
    raise exception using errcode = '23514',
      message = 'File restore policy is unavailable';
  end if;
  if effect_row.restore_original_deleted_at
      + pg_catalog.make_interval(days => effect_row.restore_recovery_window_days)
      <= pg_catalog.clock_timestamp()
    or effect_row.restore_request_deadline_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '57014',
      message = 'Record File restore request deadline expired';
  end if;

  proof_value := pg_catalog.jsonb_build_object(
    'version', 1,
    'commandId', receipt.command_id,
    'organizationId', receipt.organization_id,
    'applicationRootId', receipt.application_root_id,
    'actorOrganizationAccountId', receipt.actor_organization_account_id,
    'storageContractId', effect_row.storage_contract_id,
    'moduleRootId', (restore_meta ->> 'moduleRootId')::uuid,
    'moduleReleaseRevision', (restore_meta ->> 'moduleReleaseRevision')::bigint,
    'recordTypeId', effect_row.record_type_id,
    'recordId', effect_row.record_id,
    'preConcurrencyNumber', effect_row.pre_concurrency_number,
    'postConcurrencyNumber', effect_row.post_concurrency_number,
    'originalDeletedAt', vortex_context.format_timestamp_utc(
      effect_row.restore_original_deleted_at
    ),
    'recoveryPolicyRevision', effect_row.restore_policy_revision,
    'recoveryWindowDays', effect_row.restore_recovery_window_days,
    'requestDeadlineAt', vortex_context.format_timestamp_utc(
      effect_row.restore_request_deadline_at
    ),
    'attachmentFields', attachment_fields
  );
  proof_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(proof_value::text, 'UTF8')),
    'hex'
  );
  if not effect_row.file_cascade_settled
    and proof_digest is distinct from effect_row.file_cascade_proof_digest then
    raise exception using errcode = '40001',
      message = 'Record File restore proof is stale';
  end if;
  if request_deadline_at <= pg_catalog.clock_timestamp()
    or effect_row.restore_request_deadline_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '57014',
      message = 'Record File restore request deadline expired';
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'requestDeadlineAt', vortex_context.format_timestamp_utc(
      effect_row.restore_request_deadline_at
    ),
    'effects', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'effectSequence', effect_row.effect_sequence,
      'organizationId', receipt.organization_id,
      'applicationRootId', receipt.application_root_id,
      'actorOrganizationAccountId', receipt.actor_organization_account_id,
      'storageContractId', effect_row.storage_contract_id,
      'moduleRootId', (restore_meta ->> 'moduleRootId')::uuid,
      'moduleReleaseRevision', (restore_meta ->> 'moduleReleaseRevision')::bigint,
      'storageScope', restore_meta ->> 'storageScope',
      'recordTypeId', effect_row.record_type_id,
      'recordId', effect_row.record_id,
      'preConcurrencyNumber', effect_row.pre_concurrency_number,
      'postConcurrencyNumber', effect_row.post_concurrency_number,
      'recordProofDigest', effect_row.file_cascade_proof_digest,
      'originalDeletedAt', vortex_context.format_timestamp_utc(
        effect_row.restore_original_deleted_at
      ),
      'recoveryPolicyRevision', effect_row.restore_policy_revision,
      'recoveryWindowDays', effect_row.restore_recovery_window_days,
      'requestDeadlineAt', vortex_context.format_timestamp_utc(
        effect_row.restore_request_deadline_at
      ),
      'restorePermissionValidUntil', vortex_context.format_timestamp_utc(
        restore_permission_valid_until
      ),
      'readPermissionValidUntil', case when read_permission_valid_until is not null
        then vortex_context.format_timestamp_utc(read_permission_valid_until) else null end,
      'updatePermissionValidUntil', case when update_permission_valid_until is not null
        then vortex_context.format_timestamp_utc(update_permission_valid_until) else null end,
      'attachmentFields', attachment_fields
    ))
  );
end
$function$;

alter function vortex_record.read_record_owned_file_restore_authority_internal(uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_owned_file_restore_authority_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_record_owned_file_restore_authority_internal(uuid)
  to vortex_file_owner, vortex_record_inventory, vortex_record_owner;
comment on function vortex_record.read_record_owned_file_restore_authority_internal(uuid) is
  'Private current HUMAN Record-restore proof reader for the File cascade; returns only the verified same-organization attachment identities and current authorized restore/read/update facts to the named internal owners.';
