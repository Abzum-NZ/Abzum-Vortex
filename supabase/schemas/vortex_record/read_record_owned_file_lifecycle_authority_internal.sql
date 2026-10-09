create or replace function vortex_record.read_record_owned_file_lifecycle_authority_internal(
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
  target_identity text;
  delete_meta jsonb;
  read_meta jsonb;
  update_meta jsonb;
  delete_loaded jsonb;
  read_loaded jsonb;
  update_loaded jsonb;
  facts jsonb;
  records_value jsonb;
  decision jsonb;
  read_decision jsonb;
  update_decision jsonb;
  read_bounds jsonb;
  update_bounds jsonb;
  record_fact jsonb;
  attachment_field jsonb;
  attachment_value jsonb;
  attachment_fields jsonb;
  attachment_file_ids uuid[];
  attachment_file_id uuid;
  attachment_file_text text;
  attachment_field_count integer;
  total_attachment_file_count integer := 0;
  has_attachments boolean;
  attachment_policy jsonb;
  proof_value jsonb;
  proof_digest text;
  deleted_at_value timestamptz;
  request_timeout interval;
  request_lock_timeout interval;
  request_deadline_at timestamptz;
  delete_permission_valid_until timestamptz;
  read_permission_valid_until timestamptz;
  update_permission_valid_until timestamptz;
  effect_values jsonb := '[]'::jsonb;
  effect_count integer := 0;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Record File cascade command is invalid';
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
      message = 'Record File cascade request is unavailable';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record File cascade requires an Application context';
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
    or receipt.operation is distinct from 'delete' then
    raise exception using errcode = '42501',
      message = 'Record File cascade receipt is unavailable';
  end if;

  for effect_row in
    select bounded.*
    from (
      select effect.*
      from vortex_record.record_lifecycle_command_effects as effect
      where effect.organization_id = receipt.organization_id
        and effect.application_root_id = receipt.application_root_id
        and effect.actor_organization_account_id = receipt.actor_organization_account_id
        and effect.command_id = receipt.command_id
        and effect.effect_kind = 'soft_deleted'
      order by effect.effect_sequence
      limit 101
      for update
    ) as bounded
  loop
    effect_count := effect_count + 1;
    if effect_count > 100 then
      raise exception using errcode = '57014',
        message = 'Record File cascade effect limit exceeded';
    end if;
    target_identity := pg_catalog.lower(effect_row.storage_contract_id::text) || ':' ||
      pg_catalog.lower(effect_row.record_id::text);
    read_permission_valid_until := null;
    update_permission_valid_until := null;
    if request_deadline_at <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '57014',
        message = 'Record File cascade request deadline expired';
    end if;
    if effect_row.file_cascade_settled
      or effect_row.file_cascade_proof_digest is null
      or effect_row.file_cascade_proof_digest !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '55000',
        message = 'Record File cascade proof is unavailable';
    end if;

    delete_meta := vortex_record.resolve_record_action_context_internal(
      effect_row.record_type_id, 'delete'
    );
    if delete_meta ? 'previewInstallationId'
      or pg_catalog.jsonb_typeof(delete_meta -> 'declaration') is distinct from 'object'
      or (delete_meta ->> 'storageContractId') is distinct from
        effect_row.storage_contract_id::text then
      raise exception using errcode = '42501',
        message = 'Record File cascade source is unavailable';
    end if;
    delete_loaded := vortex_record.load_record_access_facts_internal(
      effect_row.record_type_id, 'delete', effect_row.record_id,
      effect_row.post_concurrency_number
    );
    if delete_loaded ->> 'outcome' is distinct from 'loaded'
      or (delete_loaded ->> 'concurrencyNumber')::bigint is distinct from
        effect_row.post_concurrency_number
      or (delete_loaded ->> 'definitionRevision')::bigint is distinct from
        (delete_meta ->> 'moduleReleaseRevision')::bigint then
      raise exception using errcode = '40001',
        message = 'Record File cascade revision is stale';
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(delete_loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'storageContractId')::uuid =
        effect_row.storage_contract_id
      and (item.value -> 'recordScope' ->> 'recordId')::uuid = effect_row.record_id;
    if record_fact ->> 'lifecycleState' is distinct from 'soft_deleted' then
      raise exception using errcode = '40001',
        message = 'Record File cascade owner is stale';
    end if;

    -- Rebuild the pre-delete lifecycle state from this command's identity-only
    -- effect journal. All other loaded values remain the current locked tuple.
    facts := delete_loaded -> 'facts';
    select coalesce(pg_catalog.jsonb_agg(
      case when (
        pg_catalog.lower(item.value -> 'recordScope' ->> 'storageContractId') || ':' ||
        pg_catalog.lower(item.value -> 'recordScope' ->> 'recordId')
      ) = target_identity
        then item.value || pg_catalog.jsonb_build_object('lifecycleState', 'active')
        else item.value end
      order by item.ordinality
    ), '[]'::jsonb)
    into records_value
    from pg_catalog.jsonb_array_elements(facts -> 'records')
      with ordinality as item(value, ordinality);
    facts := facts || pg_catalog.jsonb_build_object('records', records_value);
    decision := vortex_access.evaluate_organization_record_access_internal(
      delete_meta -> 'declaration', effect_row.record_id,
      facts || pg_catalog.jsonb_build_object(
        'binding', delete_meta -> 'declaration' -> 'recordBinding'
      )
    );
    delete_permission_valid_until := nullif(decision ->> 'validUntil', '')::timestamptz;
    if decision ->> 'outcome' is distinct from 'allowed'
      or delete_permission_valid_until is null
      or delete_permission_valid_until <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '42501',
        message = 'Record File cascade authority is unavailable';
    end if;

    attachment_fields := '[]'::jsonb;
    has_attachments := false;
    attachment_field_count := 0;
    for attachment_field in
      select declared.value
      from pg_catalog.jsonb_array_elements(delete_meta -> 'recordType' -> 'fields') as declared(value)
      where declared.value ->> 'type' = 'attachment'
      order by pg_catalog.lower(declared.value ->> 'fieldId') collate "C"
    loop
      attachment_field_count := attachment_field_count + 1;
      if attachment_field_count > 500 then
        raise exception using errcode = '57014',
          message = 'Record File attachment field limit exceeded';
      end if;
      attachment_file_ids := array[]::uuid[];
      attachment_value := delete_loaded -> 'fieldValues' -> pg_catalog.lower(
        attachment_field ->> 'fieldId'
      );
      if attachment_value is not null
        and pg_catalog.jsonb_typeof(attachment_value) <> 'null' then
        if pg_catalog.jsonb_typeof(attachment_value) <> 'array' then
          raise exception using errcode = '23514',
            message = 'Attachment ownership is invalid';
        end if;
        for attachment_file_text in
          select item.value
          from pg_catalog.jsonb_array_elements_text(attachment_value) as item(value)
        loop
          if pg_catalog.cardinality(attachment_file_ids) >= 100
            or total_attachment_file_count >= 1000 then
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
          attachment_file_ids := pg_catalog.array_append(
            attachment_file_ids, attachment_file_id
          );
          total_attachment_file_count := total_attachment_file_count + 1;
        end loop;
      end if;
      select coalesce(pg_catalog.array_agg(item.file_id order by item.file_id), array[]::uuid[])
      into attachment_file_ids
      from pg_catalog.unnest(attachment_file_ids) as item(file_id);
      if pg_catalog.cardinality(attachment_file_ids) > 0 then
        has_attachments := true;
      end if;
      attachment_fields := attachment_fields || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'fieldId', pg_catalog.lower(attachment_field ->> 'fieldId'),
          'fileIds', pg_catalog.to_jsonb(attachment_file_ids)
        )
      );
    end loop;

    if has_attachments then
      read_meta := vortex_record.resolve_record_action_context_internal(
        effect_row.record_type_id, 'read'
      );
      update_meta := vortex_record.resolve_record_action_context_internal(
        effect_row.record_type_id, 'update'
      );
      if read_meta ? 'previewInstallationId'
        or update_meta ? 'previewInstallationId'
        or pg_catalog.jsonb_typeof(read_meta -> 'declaration') is distinct from 'object'
        or pg_catalog.jsonb_typeof(update_meta -> 'declaration') is distinct from 'object'
        or (read_meta ->> 'storageContractId') is distinct from
          (delete_meta ->> 'storageContractId')
        or (update_meta ->> 'storageContractId') is distinct from
          (delete_meta ->> 'storageContractId')
        or (read_meta ->> 'moduleRootId') is distinct from
          (delete_meta ->> 'moduleRootId')
        or (update_meta ->> 'moduleRootId') is distinct from
          (delete_meta ->> 'moduleRootId')
        or (read_meta ->> 'moduleReleaseRevision') is distinct from
          (delete_meta ->> 'moduleReleaseRevision')
        or (update_meta ->> 'moduleReleaseRevision') is distinct from
          (delete_meta ->> 'moduleReleaseRevision') then
        raise exception using errcode = '42501',
          message = 'File attachment source is unavailable';
      end if;
      read_loaded := vortex_record.load_record_access_facts_internal(
        effect_row.record_type_id, 'read', effect_row.record_id,
        effect_row.post_concurrency_number
      );
      update_loaded := vortex_record.load_record_access_facts_internal(
        effect_row.record_type_id, 'update', effect_row.record_id,
        effect_row.post_concurrency_number
      );
      if read_loaded ->> 'outcome' is distinct from 'loaded'
        or update_loaded ->> 'outcome' is distinct from 'loaded'
        or (read_loaded ->> 'concurrencyNumber')::bigint is distinct from
          effect_row.post_concurrency_number
        or (update_loaded ->> 'concurrencyNumber')::bigint is distinct from
          effect_row.post_concurrency_number then
        raise exception using errcode = '40001',
          message = 'File attachment revision is stale';
      end if;
      select item.value into record_fact
      from pg_catalog.jsonb_array_elements(read_loaded -> 'facts' -> 'records') as item(value)
      where (item.value -> 'recordScope' ->> 'storageContractId')::uuid =
          effect_row.storage_contract_id
        and (item.value -> 'recordScope' ->> 'recordId')::uuid = effect_row.record_id;
      if record_fact ->> 'lifecycleState' is distinct from 'soft_deleted' then
        raise exception using errcode = '40001',
          message = 'File attachment owner is stale';
      end if;
      select coalesce(pg_catalog.jsonb_agg(
        case when (
          pg_catalog.lower(item.value -> 'recordScope' ->> 'storageContractId') || ':' ||
          pg_catalog.lower(item.value -> 'recordScope' ->> 'recordId')
          ) = target_identity
          then item.value || pg_catalog.jsonb_build_object('lifecycleState', 'active')
          else item.value end
        order by item.ordinality
      ), '[]'::jsonb)
      into records_value
      from pg_catalog.jsonb_array_elements(read_loaded -> 'facts' -> 'records')
        with ordinality as item(value, ordinality);
      facts := (read_loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'records', records_value
      );
      read_decision := vortex_access.evaluate_organization_record_access_internal(
        read_meta -> 'declaration', effect_row.record_id,
        facts || pg_catalog.jsonb_build_object(
          'binding', read_meta -> 'declaration' -> 'recordBinding'
        )
      );
      select item.value into record_fact
      from pg_catalog.jsonb_array_elements(update_loaded -> 'facts' -> 'records') as item(value)
      where (item.value -> 'recordScope' ->> 'storageContractId')::uuid =
          effect_row.storage_contract_id
        and (item.value -> 'recordScope' ->> 'recordId')::uuid = effect_row.record_id;
      if record_fact ->> 'lifecycleState' is distinct from 'soft_deleted' then
        raise exception using errcode = '40001',
          message = 'File attachment owner is stale';
      end if;
      select coalesce(pg_catalog.jsonb_agg(
        case when (
          pg_catalog.lower(item.value -> 'recordScope' ->> 'storageContractId') || ':' ||
          pg_catalog.lower(item.value -> 'recordScope' ->> 'recordId')
          ) = target_identity
          then item.value || pg_catalog.jsonb_build_object('lifecycleState', 'active')
          else item.value end
        order by item.ordinality
      ), '[]'::jsonb)
      into records_value
      from pg_catalog.jsonb_array_elements(update_loaded -> 'facts' -> 'records')
        with ordinality as item(value, ordinality);
      facts := (update_loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'records', records_value
      );
      update_decision := vortex_access.evaluate_organization_record_access_internal(
        update_meta -> 'declaration', effect_row.record_id,
        facts || pg_catalog.jsonb_build_object(
          'binding', update_meta -> 'declaration' -> 'recordBinding'
        )
      );
      read_permission_valid_until := nullif(read_decision ->> 'validUntil', '')::timestamptz;
      update_permission_valid_until := nullif(update_decision ->> 'validUntil', '')::timestamptz;
      if read_decision ->> 'outcome' is distinct from 'allowed'
        or update_decision ->> 'outcome' is distinct from 'allowed'
        or read_permission_valid_until is null
        or update_permission_valid_until is null
        or read_permission_valid_until <= pg_catalog.clock_timestamp()
        or update_permission_valid_until <= pg_catalog.clock_timestamp() then
        raise exception using errcode = '42501',
          message = 'File attachment authority is unavailable';
      end if;
      read_bounds := vortex_access.resolve_record_field_bounds_internal(read_decision);
      update_bounds := vortex_access.resolve_record_field_bounds_internal(update_decision);
      if exists (
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
      attachment_policy := vortex_record.lock_record_recovery_policy_internal(
        receipt.organization_id, effect_row.storage_contract_id,
        case when delete_meta ->> 'storageScope' = 'application_contained'
          then receipt.application_root_id else null end
      );
      if attachment_policy ->> 'action' is distinct from 'delete'
        or pg_catalog.jsonb_typeof(attachment_policy -> 'recoveryWindowDays') <> 'number'
        or (attachment_policy ->> 'recoveryWindowDays') !~ '^[1-9][0-9]{0,8}$'
        or (attachment_policy ->> 'recoveryWindowDays')::bigint > 104249991 then
        raise exception using errcode = '23514',
          message = 'File recovery policy is unavailable';
      end if;
    else
      attachment_policy := null;
    end if;

    proof_value := pg_catalog.jsonb_build_object(
      'version', 1,
      'commandId', receipt.command_id,
      'organizationId', receipt.organization_id,
      'applicationRootId', receipt.application_root_id,
      'actorOrganizationAccountId', receipt.actor_organization_account_id,
      'storageContractId', effect_row.storage_contract_id,
      'moduleRootId', (delete_meta ->> 'moduleRootId')::uuid,
      'moduleReleaseRevision', (delete_meta ->> 'moduleReleaseRevision')::bigint,
      'recordTypeId', effect_row.record_type_id,
      'recordId', effect_row.record_id,
      'preConcurrencyNumber', effect_row.pre_concurrency_number,
      'postConcurrencyNumber', effect_row.post_concurrency_number,
      'attachmentFields', attachment_fields
    );
    proof_digest := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(proof_value::text, 'UTF8')),
      'hex'
    );
    if proof_digest is distinct from effect_row.file_cascade_proof_digest then
      raise exception using errcode = '40001',
        message = 'Record File cascade proof is stale';
    end if;

    execute pg_catalog.format(
      'select stored.deleted_at
       from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.lifecycle_state = ''soft_deleted''
         and stored.concurrency_number = $3
         and stored.definition_revision = $4',
      delete_meta ->> 'table'
    ) into deleted_at_value using receipt.organization_id, effect_row.record_id,
      effect_row.post_concurrency_number,
      (delete_meta ->> 'moduleReleaseRevision')::bigint;
    if deleted_at_value is null then
      raise exception using errcode = '40001',
        message = 'Record File cascade owner is stale';
    end if;
    effect_values := effect_values || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'effectSequence', effect_row.effect_sequence,
        'organizationId', receipt.organization_id,
        'applicationRootId', receipt.application_root_id,
        'storageContractId', effect_row.storage_contract_id,
        'moduleRootId', (delete_meta ->> 'moduleRootId')::uuid,
        'moduleReleaseRevision', (delete_meta ->> 'moduleReleaseRevision')::bigint,
        'storageScope', delete_meta ->> 'storageScope',
        'recordTypeId', effect_row.record_type_id,
        'recordId', effect_row.record_id,
        'preConcurrencyNumber', effect_row.pre_concurrency_number,
        'postConcurrencyNumber', effect_row.post_concurrency_number,
        'recordProofDigest', effect_row.file_cascade_proof_digest,
        'recordDeletedAt', vortex_context.format_timestamp_utc(deleted_at_value),
        'deletePermissionValidUntil', vortex_context.format_timestamp_utc(
          delete_permission_valid_until
        ),
        'readPermissionValidUntil', case when read_permission_valid_until is not null
          then vortex_context.format_timestamp_utc(read_permission_valid_until) else null end,
        'updatePermissionValidUntil', case when update_permission_valid_until is not null
          then vortex_context.format_timestamp_utc(update_permission_valid_until) else null end,
        'attachmentFields', attachment_fields
      ) || case when attachment_policy is not null
        then pg_catalog.jsonb_build_object(
          'recoveryPolicyRevision', attachment_policy -> 'policyRevision',
          'recoveryWindowDays', attachment_policy -> 'recoveryWindowDays'
        )
        else '{}'::jsonb end
    );
  end loop;

  if effect_count = 0
    or not exists (
      select 1
      from vortex_record.record_lifecycle_command_effects as effect
      where effect.organization_id = receipt.organization_id
        and effect.application_root_id = receipt.application_root_id
        and effect.actor_organization_account_id = receipt.actor_organization_account_id
        and effect.command_id = receipt.command_id
        and effect.effect_kind = 'soft_deleted'
        and effect.record_type_id = receipt.record_type_id
        and effect.record_id = receipt.record_id
        and effect.pre_concurrency_number = receipt.expected_concurrency_number
    ) then
    raise exception using errcode = '55000',
      message = 'Record File cascade effects are incomplete';
  end if;
  if request_deadline_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '57014',
      message = 'Record File cascade request deadline expired';
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared', 'effects', effect_values
  );
end
$function$;

alter function vortex_record.read_record_owned_file_lifecycle_authority_internal(uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_owned_file_lifecycle_authority_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_record_owned_file_lifecycle_authority_internal(uuid)
  to vortex_file_owner, vortex_record_inventory, vortex_record_owner;
comment on function vortex_record.read_record_owned_file_lifecycle_authority_internal(uuid) is
  'Private current HUMAN Record-delete proof reader for the File cascade. Returns only the verified same-command attachment identities to the File owner and organization-complete inventory role.';
