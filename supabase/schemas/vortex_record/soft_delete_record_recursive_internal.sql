create or replace function vortex_record.soft_delete_record_recursive_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_visited text[]
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  read_meta jsonb;
  read_loaded jsonb;
  read_decision jsonb;
  read_bounds jsonb;
  update_meta jsonb;
  update_loaded jsonb;
  update_decision jsonb;
  update_bounds jsonb;
  facts jsonb;
  decision jsonb;
  context_value jsonb;
  record_fact jsonb;
  identity_value text;
  incoming record;
  source_catalogue vortex_record.storage_catalogue%rowtype;
  source_meta jsonb;
  source_loaded jsonb;
  source_decision jsonb;
  source_record_type jsonb;
  source_concurrency bigint;
  source_link_column text;
  source_link_value jsonb;
  source_identity text;
  source_action_kind text;
  changed_rows integer;
  clear_result jsonb;
  clear_notice_eligible boolean;
  expected_clear_notice_eligible boolean;
  clear_saved_record_id uuid;
  clear_saved_concurrency_number bigint;
  clear_application_root_id uuid;
  expected_clear_application_root_id uuid;
  application_scope uuid;
  saved_record_id uuid;
  saved_concurrency_number bigint;
  preview_installation jsonb;
  notice_sequence bigint;
  attachment_field jsonb;
  attachment_value jsonb;
  attachment_fields jsonb := '[]'::jsonb;
  attachment_file_ids uuid[];
  attachment_file_id uuid;
  attachment_file_text text;
  has_attachments boolean := false;
  attachment_policy jsonb;
  proof_value jsonb;
  proof_digest text;
  effect_sequence integer;
  changed_effects integer;
begin
  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'delete');
  context_value := meta -> 'context';
  identity_value := pg_catalog.lower((meta ->> 'storageContractId')) || ':'
    || pg_catalog.lower(p_record_id::text);
  if identity_value = any (p_visited) then
    raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
  end if;
  p_visited := pg_catalog.array_append(p_visited, identity_value);

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'delete', p_record_id, p_expected_concurrency_number
  );
  if loaded ->> 'outcome' = 'conflict' then
    raise exception using errcode = '40001', message = 'Record delete revision is stale';
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;
  select item.value into record_fact
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  if record_fact ->> 'lifecycleState' <> 'active' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;
  facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
    'binding', meta -> 'declaration' -> 'recordBinding'
  );
  decision := vortex_access.evaluate_organization_record_access_internal(
    meta -> 'declaration', p_record_id, facts
  );
  if decision ->> 'outcome' <> 'allowed'
    or nullif(decision ->> 'validUntil', '')::timestamptz is null
    or nullif(decision ->> 'validUntil', '')::timestamptz
      <= pg_catalog.statement_timestamp() then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;

  -- Capture only the IDs needed by the File owner. The complete value and
  -- current action decisions remain in memory; only a server SHA-256 proof is
  -- attached to the private lifecycle effect after the Record CAS succeeds.
  for attachment_field in
    select declared.value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as declared(value)
    where declared.value ->> 'type' = 'attachment'
    order by pg_catalog.lower(declared.value ->> 'fieldId') collate "C"
  loop
    attachment_file_ids := array[]::uuid[];
    attachment_value := loaded -> 'fieldValues' -> pg_catalog.lower(
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
    read_meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
    update_meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'update');
    if read_meta ->> 'outcome' = 'refused'
      or update_meta ->> 'outcome' = 'refused'
      or read_meta ? 'previewInstallationId'
      or update_meta ? 'previewInstallationId'
      or (read_meta ->> 'storageContractId') is distinct from
        (meta ->> 'storageContractId')
      or (update_meta ->> 'storageContractId') is distinct from
        (meta ->> 'storageContractId')
      or (read_meta ->> 'moduleRootId') is distinct from (meta ->> 'moduleRootId')
      or (update_meta ->> 'moduleRootId') is distinct from (meta ->> 'moduleRootId')
      or (read_meta ->> 'moduleReleaseRevision') is distinct from
        (meta ->> 'moduleReleaseRevision')
      or (update_meta ->> 'moduleReleaseRevision') is distinct from
        (meta ->> 'moduleReleaseRevision')
      or (read_meta -> 'context' ->> 'organizationId') is distinct from
        (context_value ->> 'organizationId')
      or (update_meta -> 'context' ->> 'organizationId') is distinct from
        (context_value ->> 'organizationId')
      or (read_meta -> 'context' ->> 'applicationRootId') is distinct from
        (context_value ->> 'applicationRootId')
      or (update_meta -> 'context' ->> 'applicationRootId') is distinct from
        (context_value ->> 'applicationRootId') then
      raise exception using errcode = '42501',
        message = 'File attachment authority is unavailable';
    end if;
    read_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'read', p_record_id, p_expected_concurrency_number
    );
    update_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
    );
    if read_loaded ->> 'outcome' <> 'loaded'
      or update_loaded ->> 'outcome' <> 'loaded'
      or (read_loaded ->> 'concurrencyNumber')::bigint is distinct from
        p_expected_concurrency_number
      or (update_loaded ->> 'concurrencyNumber')::bigint is distinct from
        p_expected_concurrency_number
      or pg_catalog.jsonb_typeof(read_meta -> 'declaration') <> 'object'
      or pg_catalog.jsonb_typeof(update_meta -> 'declaration') <> 'object' then
      raise exception using errcode = '42501',
        message = 'File attachment authority is unavailable';
    end if;
    read_decision := vortex_access.evaluate_organization_record_access_internal(
      read_meta -> 'declaration', p_record_id,
      (read_loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', read_meta -> 'declaration' -> 'recordBinding'
      )
    );
    update_decision := vortex_access.evaluate_organization_record_access_internal(
      update_meta -> 'declaration', p_record_id,
      (update_loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', update_meta -> 'declaration' -> 'recordBinding'
      )
    );
    if read_decision ->> 'outcome' <> 'allowed'
      or update_decision ->> 'outcome' <> 'allowed'
      or nullif(read_decision ->> 'validUntil', '')::timestamptz is null
      or nullif(update_decision ->> 'validUntil', '')::timestamptz is null
      or nullif(read_decision ->> 'validUntil', '')::timestamptz
        <= pg_catalog.statement_timestamp()
      or nullif(update_decision ->> 'validUntil', '')::timestamptz
        <= pg_catalog.statement_timestamp() then
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
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'storageContractId')::uuid,
      case when meta ->> 'storageScope' = 'application_contained'
        then (context_value ->> 'applicationRootId')::uuid else null end
    );
    if attachment_policy ->> 'action' is distinct from 'delete'
      or pg_catalog.jsonb_typeof(attachment_policy -> 'recoveryWindowDays') <> 'number'
      or (attachment_policy ->> 'recoveryWindowDays') !~ '^[1-9][0-9]{0,8}$'
      or (attachment_policy ->> 'recoveryWindowDays')::bigint > 104249991 then
      raise exception using errcode = '23514',
        message = 'File recovery policy is unavailable';
    end if;
  end if;

  -- Incoming edges are canonicalised before any child lock.  Every affected
  -- child is then reloaded and locked by #401's fixed loader.
  for incoming in
    select edge.*, mapping.on_parent_delete, mapping.relationship_id,
      mapping.source_field_id
    from vortex_record.relationship_edges as edge
    join vortex_record.relationship_storage_mappings as mapping
      on mapping.relationship_id = edge.relationship_id
    where edge.to_organisation_id = (context_value ->> 'organizationId')::uuid
      and edge.to_storage_contract_id = (meta ->> 'storageContractId')::uuid
      and edge.to_record_id = p_record_id
    order by edge.from_storage_contract_id, edge.from_record_id, edge.relationship_id
  loop
    select catalogue.* into source_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = incoming.from_storage_contract_id;
    source_identity := pg_catalog.lower(incoming.from_storage_contract_id::text) || ':'
      || pg_catalog.lower(incoming.from_record_id::text);
    if source_identity = any (p_visited) then
      raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
    end if;

    -- A child retained by another Application cannot be silently modified
    -- under this Application's request context.  It is therefore a safe
    -- blocking relationship, not an authority bypass.
    source_action_kind := case
      when incoming.on_parent_delete = 'empty_optional' then 'update'
      when incoming.on_parent_delete = 'soft_delete_dependent' then 'delete'
      else 'read'
    end;
    begin
      source_meta := vortex_record.resolve_record_action_context_internal(
        source_catalogue.record_type_id, source_action_kind
      );
    exception when others then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end;

    select field_mapping.physical_column_token into strict source_link_column
    from vortex_record.field_storage_mappings as field_mapping
    where field_mapping.storage_contract_id = incoming.from_storage_contract_id
      and field_mapping.field_id = incoming.source_field_id
      and field_mapping.state = 'active'
      and field_mapping.introduced_at_release_revision <=
        (source_meta ->> 'moduleReleaseRevision')::bigint;

    execute pg_catalog.format(
      'select concurrency_number, %I from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.lifecycle_state = ''active'' for update',
      source_link_column, source_meta ->> 'table'
    ) into source_concurrency, source_link_value using
      (context_value ->> 'organizationId')::uuid, incoming.from_record_id;
    if not found then
      continue;
    end if;
    -- The incoming-edge cursor may have been opened before a concurrent link
    -- change committed. The source row lock returns the current tuple, so
    -- re-check its exact field before applying parent-delete behaviour. This
    -- prevents a stale edge snapshot from clearing or revising the source a
    -- second time after that link was already removed or redirected.
    if pg_catalog.jsonb_typeof(source_link_value) <> 'object'
      or source_link_value ->> 'recordId' is distinct from p_record_id::text then
      continue;
    end if;
    source_loaded := vortex_record.load_record_access_facts_internal(
      source_catalogue.record_type_id, source_action_kind, incoming.from_record_id,
      source_concurrency
    );
    if source_loaded ->> 'outcome' <> 'loaded' then
      continue;
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(source_loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = incoming.from_record_id;
    if record_fact ->> 'lifecycleState' <> 'active' then
      continue;
    end if;
    if incoming.on_parent_delete = 'refuse' then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end if;
    if pg_catalog.jsonb_typeof(source_meta -> 'declaration') <> 'object' then
      raise exception using errcode = '42501', message = 'Affected record is unavailable';
    end if;
    source_decision := vortex_access.evaluate_organization_record_access_internal(
      source_meta -> 'declaration', incoming.from_record_id,
      (source_loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', source_meta -> 'declaration' -> 'recordBinding'
      )
    );
    if source_decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501', message = 'Affected record is unavailable';
    end if;

    if incoming.on_parent_delete = 'empty_optional' then
      clear_result := vortex_record.write_relationship_value_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        incoming.relationship_id, 'null'::jsonb, true, true
      );
      preview_installation := vortex_record.read_current_preview_installation_internal();
      expected_clear_application_root_id := case
        when source_meta ->> 'storageScope' = 'application_contained'
          then (source_meta -> 'context' ->> 'applicationRootId')::uuid
        else null
      end;
      expected_clear_notice_eligible := coalesce(
        preview_installation is null
          and source_meta ->> 'storageScope' = 'application_contained',
        false
      );
      if pg_catalog.jsonb_typeof(clear_result) is distinct from 'object'
        or not (clear_result ?& array[
          'organizationId', 'applicationRootId', 'recordTypeId', 'storageContractId',
          'recordId', 'concurrencyNumber', 'noticeEligible'
        ])
        or clear_result - array[
          'organizationId', 'applicationRootId', 'recordTypeId', 'storageContractId',
          'recordId', 'concurrencyNumber', 'noticeEligible'
        ] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(clear_result -> 'organizationId') <> 'string'
        or pg_catalog.jsonb_typeof(clear_result -> 'recordTypeId') <> 'string'
        or pg_catalog.jsonb_typeof(clear_result -> 'storageContractId') <> 'string'
        or pg_catalog.jsonb_typeof(clear_result -> 'recordId') <> 'string'
        or pg_catalog.jsonb_typeof(clear_result -> 'concurrencyNumber') <> 'number'
        or (clear_result ->> 'concurrencyNumber') !~ '^[1-9][0-9]{0,15}$'
        or pg_catalog.jsonb_typeof(clear_result -> 'noticeEligible') <> 'boolean'
        or pg_catalog.jsonb_typeof(clear_result -> 'applicationRootId') is distinct from
          case when expected_clear_application_root_id is null then 'null' else 'string' end then
        raise exception using errcode = '55000',
          message = 'Optional relationship clear tuple is unavailable';
      end if;
      clear_saved_record_id := (clear_result ->> 'recordId')::uuid;
      clear_saved_concurrency_number := (clear_result ->> 'concurrencyNumber')::bigint;
      clear_notice_eligible := (clear_result ->> 'noticeEligible')::boolean;
      clear_application_root_id := (clear_result ->> 'applicationRootId')::uuid;
      if (
        (source_meta ->> 'storageScope') = 'application_contained'
        and (
          expected_clear_application_root_id is null
          or not coalesce(
            vortex_context.is_non_nil_uuid(expected_clear_application_root_id::text), false
          )
        )
      )
        or not coalesce(vortex_context.is_non_nil_uuid(clear_result ->> 'organizationId'), false)
        or not coalesce(vortex_context.is_non_nil_uuid(clear_result ->> 'recordTypeId'), false)
        or not coalesce(vortex_context.is_non_nil_uuid(clear_result ->> 'storageContractId'), false)
        or not coalesce(vortex_context.is_non_nil_uuid(clear_result ->> 'recordId'), false)
        or clear_saved_record_id is distinct from incoming.from_record_id
        or clear_saved_concurrency_number not between 1 and 9007199254740991
        or (clear_result ->> 'organizationId')::uuid is distinct from
          (context_value ->> 'organizationId')::uuid
        or (clear_result ->> 'recordTypeId')::uuid is distinct from
          source_catalogue.record_type_id
        or (clear_result ->> 'storageContractId')::uuid is distinct from
          incoming.from_storage_contract_id
        or clear_application_root_id is distinct from expected_clear_application_root_id
        or clear_notice_eligible is distinct from expected_clear_notice_eligible then
        raise exception using errcode = '55000',
          message = 'Optional relationship clear tuple is unavailable';
      end if;
      perform vortex_record.append_record_lifecycle_effect_internal(
        'optional_cleared', incoming.from_storage_contract_id,
        source_catalogue.record_type_id, incoming.from_record_id,
        source_concurrency, incoming.relationship_id
      );
      if clear_notice_eligible then
        begin
          notice_sequence := pg_catalog.nextval(
            'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
          );
          if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
            raise exception using errcode = '22003',
              message = 'Optional relationship notice sequence is unavailable';
          end if;
          perform vortex_invalidation.publish_change_notice(
            (clear_result ->> 'organizationId')::uuid,
            clear_application_root_id,
            (clear_result ->> 'recordTypeId')::uuid,
            clear_saved_record_id, clear_saved_concurrency_number, 'changed',
            notice_sequence, notice_sequence,
            (context_value ->> 'correlationId')::uuid
          );
        exception when others then
          -- The exact source notice is advisory; all prior authority and journals stay structural.
          null;
        end;
      end if;
    elsif incoming.on_parent_delete = 'soft_delete_dependent' then
      source_record_type := source_meta -> 'recordType';
      if source_record_type ->> 'ownershipMode' <> 'inherited'
        or not source_record_type ? 'ownershipRelationshipId'
        or (source_record_type ->> 'ownershipRelationshipId')::uuid <>
          incoming.relationship_id then
        raise exception using errcode = '23514', message = 'Dependent deletion is not declared';
      end if;
      perform vortex_record.soft_delete_record_recursive_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        source_concurrency, p_visited
      );
    else
      raise exception using errcode = '23514', message = 'Parent deletion behavior is invalid';
    end if;
  end loop;

  execute pg_catalog.format(
    'update record_data.%I as stored
     set lifecycle_state = ''soft_deleted'',
       concurrency_number = concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       deleted_at = pg_catalog.statement_timestamp(), deleted_by = $3,
       removal_due_at = null, definition_revision = $4
     where organisation_id = $1 and record_id = $2
       and lifecycle_state = ''active'' and concurrency_number = $5
     returning stored.record_id, stored.concurrency_number',
    meta ->> 'table'
  ) into saved_record_id, saved_concurrency_number using
    (context_value ->> 'organizationId')::uuid, p_record_id,
    (context_value ->> 'organizationAccountId')::uuid,
    (meta ->> 'moduleReleaseRevision')::bigint, p_expected_concurrency_number;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Record delete revision changed';
  end if;
  if saved_record_id is distinct from p_record_id
    or saved_concurrency_number is null
    or saved_concurrency_number not between 1 and 9007199254740991 then
    raise exception using errcode = '55000', message = 'Record delete saved identity is unavailable';
  end if;
  perform vortex_record.append_record_lifecycle_effect_internal(
    'soft_deleted', (meta ->> 'storageContractId')::uuid,
    p_record_type_id, p_record_id, p_expected_concurrency_number, null
  );
  proof_value := pg_catalog.jsonb_build_object(
    'version', 1,
    'commandId', pg_catalog.current_setting('vortex_record.lifecycle_command_id')::uuid,
    'organizationId', (context_value ->> 'organizationId')::uuid,
    'applicationRootId', (context_value ->> 'applicationRootId')::uuid,
    'actorOrganizationAccountId', (context_value ->> 'organizationAccountId')::uuid,
    'storageContractId', (meta ->> 'storageContractId')::uuid,
    'moduleRootId', (meta ->> 'moduleRootId')::uuid,
    'moduleReleaseRevision', (meta ->> 'moduleReleaseRevision')::bigint,
    'recordTypeId', p_record_type_id,
    'recordId', p_record_id,
    'preConcurrencyNumber', p_expected_concurrency_number,
    'postConcurrencyNumber', saved_concurrency_number,
    'attachmentFields', attachment_fields
  );
  proof_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(proof_value::text, 'UTF8')),
    'hex'
  );
  select effect.effect_sequence into strict effect_sequence
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = (context_value ->> 'organizationId')::uuid
    and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and effect.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and effect.command_id =
      pg_catalog.current_setting('vortex_record.lifecycle_command_id')::uuid
    and effect.effect_kind = 'soft_deleted'
    and effect.storage_contract_id = (meta ->> 'storageContractId')::uuid
    and effect.record_type_id = p_record_type_id
    and effect.record_id = p_record_id
    and effect.pre_concurrency_number = p_expected_concurrency_number
    and effect.post_concurrency_number = saved_concurrency_number;
  update vortex_record.record_lifecycle_command_effects as effect
  set file_cascade_proof_digest = proof_digest,
    file_cascade_settled = false
  where effect.organization_id = (context_value ->> 'organizationId')::uuid
    and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and effect.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and effect.command_id =
      pg_catalog.current_setting('vortex_record.lifecycle_command_id')::uuid
    and effect.effect_sequence = effect_sequence
    and effect.effect_kind = 'soft_deleted'
    and effect.file_cascade_proof_digest is null
    and not effect.file_cascade_settled;
  get diagnostics changed_effects = row_count;
  if changed_effects <> 1 then
    raise exception using errcode = '55000',
      message = 'Record File cascade proof could not be recorded';
  end if;
  application_scope := case when meta ->> 'storageScope' = 'application_contained'
    then (context_value ->> 'applicationRootId')::uuid else null end;
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is null
    and meta ->> 'storageScope' = 'application_contained' then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      perform vortex_invalidation.publish_change_notice(
        (context_value ->> 'organizationId')::uuid,
        application_scope, p_record_type_id,
        saved_record_id, saved_concurrency_number, 'deleted',
        notice_sequence, notice_sequence,
        (context_value ->> 'correlationId')::uuid
      );
    exception when others then
      -- Invalidation is advisory; the protected delete remains transactional.
      null;
    end;
  else
    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'storageContractId')::uuid, application_scope
    );
  end if;
end
$function$;

alter function vortex_record.soft_delete_record_recursive_internal(uuid,uuid,bigint,text[]) owner to vortex_record_adapter;

revoke all on function vortex_record.soft_delete_record_recursive_internal(uuid,uuid,bigint,text[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on function vortex_record.soft_delete_record_recursive_internal(uuid,uuid,bigint,text[]) is null;
