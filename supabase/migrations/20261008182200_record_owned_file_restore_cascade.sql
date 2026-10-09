-- #2143: same-transaction, current HUMAN Record-owned File restore cascade.
--
-- The request restores one revision-bound Record, proves its original deletion
-- and current recovery policy, restores only the exact same-organization File
-- memberships with metadata CAS, and settles a private digest before the
-- terminal Record writer completes the receipt. Restore is partial #683; File
-- detach, permanent purge, and whole #683 acceptance remain open.

begin;

set local role vortex_record_adapter;
alter table vortex_record.record_lifecycle_command_effects
  add column restore_original_deleted_at timestamptz,
  add column restore_policy_revision bigint,
  add column restore_recovery_window_days integer,
  add column restore_request_deadline_at timestamptz,
  add constraint record_lifecycle_effect_restore_proof_complete check (
    (restore_original_deleted_at is null
      and restore_policy_revision is null
      and restore_recovery_window_days is null
      and restore_request_deadline_at is null)
    or (restore_original_deleted_at is not null
      and restore_policy_revision between 1 and 9007199254740991
      and restore_recovery_window_days between 1 and 104249991
      and restore_request_deadline_at is not null
      and restore_request_deadline_at >= restore_original_deleted_at)
  );
comment on column vortex_record.record_lifecycle_command_effects.restore_original_deleted_at is
  'Private original Record deletion timestamp captured before restore; null on non-restore effects.';
comment on column vortex_record.record_lifecycle_command_effects.restore_policy_revision is
  'Private exact current recoverable-delete policy revision bound to one restored lifecycle effect.';
comment on column vortex_record.record_lifecycle_command_effects.restore_recovery_window_days is
  'Private bounded recovery window captured from the exact current policy before Record restore.';
comment on column vortex_record.record_lifecycle_command_effects.restore_request_deadline_at is
  'Private statement-start deadline for the one same-transaction Record and File restore request.';
reset role;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter, vortex_record_inventory;
reset role;

set local role vortex_record_adapter;
create or replace function vortex_record.read_recoverable_record_for_restore(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  meta jsonb;
  storage_row vortex_record.storage_catalogue%rowtype;
  policy_value jsonb;
  loaded jsonb;
  decision jsonb;
  candidate record;
  candidate_fact jsonb;
  field_item jsonb;
  field_value jsonb;
  attachment_fields_value jsonb := '[]'::jsonb;
  attachment_file_ids uuid[];
  attachment_file_id uuid;
  attachment_file_text text;
  attachment_field_count integer;
  total_attachment_count integer;
  projected_facts jsonb;
  projected_records jsonb;
  result_rows jsonb := '[]'::jsonb;
  candidate_count integer := 0;
  organization_id_value uuid;
  application_root_id_value uuid;
  expected_application_root_id uuid;
  recovery_window_days integer;
  action_allowed boolean;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or (p_record_id is not null and p_record_id = nil_uuid)
    or (p_expected_concurrency_number is not null
      and p_expected_concurrency_number not between 1 and 9007199254740990)
    or (p_record_id is null and p_expected_concurrency_number is not null)
    or (p_record_id is not null and p_expected_concurrency_number is null) then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  meta := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, 'restore'
  );
  if meta ? 'previewInstallationId'
    or pg_catalog.jsonb_typeof(meta -> 'declaration') is distinct from 'object'
    or (meta ->> 'table') !~ '^rt_[0-9a-f]{32}$'
    or (meta ->> 'storageScope') not in ('application_contained', 'organization_shared') then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;
  select catalogue.* into storage_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = (meta ->> 'storageContractId')::uuid
    and catalogue.module_root_id = (meta ->> 'moduleRootId')::uuid
    and catalogue.record_type_id = p_record_type_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.physical_table_token = meta ->> 'table'
    and catalogue.state = 'active';
  if not found or storage_row.storage_scope is distinct from (meta ->> 'storageScope') then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;
  expected_application_root_id := case
    when storage_row.storage_scope = 'application_contained'
      then application_root_id_value else null end;
  policy_value := vortex_record.lock_record_recovery_policy_internal(
    organization_id_value, storage_row.storage_contract_id,
    expected_application_root_id
  );
  if policy_value is null
    or policy_value ->> 'action' is distinct from 'delete'
    or pg_catalog.jsonb_typeof(policy_value -> 'recoveryWindowDays') is distinct from 'number'
    or (policy_value ->> 'recoveryWindowDays') !~ '^[1-9][0-9]{0,8}$'
    or (policy_value ->> 'recoveryWindowDays')::bigint > 104249991 then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;
  recovery_window_days := (policy_value ->> 'recoveryWindowDays')::integer;

  for candidate in execute pg_catalog.format(
    'select stored.record_id, stored.concurrency_number, stored.deleted_at
     from record_data.%I as stored
     where stored.organisation_id = $1
       and stored.application_root_id is not distinct from $2
       and stored.lifecycle_state = ''soft_deleted''
       and stored.deleted_at is not null
       and ($3::uuid is null or stored.record_id = $3)
     order by stored.record_id
     limit 101',
    storage_row.physical_table_token
  ) using organization_id_value, expected_application_root_id, p_record_id
  loop
    candidate_count := candidate_count + 1;
    if p_record_id is null and candidate_count > 100 then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;
    if candidate.concurrency_number is null
      or candidate.concurrency_number not between 1 and 9007199254740990 then
      if p_record_id is not null then
        return pg_catalog.jsonb_build_object('outcome', 'unavailable');
      end if;
      continue;
    end if;
    if pg_catalog.clock_timestamp() >= candidate.deleted_at +
      pg_catalog.make_interval(days => recovery_window_days) then
      if p_record_id is not null then
        return pg_catalog.jsonb_build_object('outcome', 'unavailable');
      end if;
      continue;
    end if;

    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'restore', candidate.record_id, null
    );
    if loaded ->> 'outcome' is distinct from 'loaded'
      or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object'
      or (loaded ->> 'concurrencyNumber')::bigint <> candidate.concurrency_number
      or (p_record_id is not null
        and candidate.concurrency_number <> p_expected_concurrency_number) then
      if p_record_id is not null then
        return pg_catalog.jsonb_build_object('outcome', 'unavailable');
      end if;
      continue;
    end if;
    select item.value into candidate_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = candidate.record_id
      and (item.value -> 'recordScope' ->> 'recordTypeId')::uuid = p_record_type_id
      and item.value ->> 'lifecycleState' = 'soft_deleted';
    if candidate_fact is null then
      if p_record_id is not null then
        return pg_catalog.jsonb_build_object('outcome', 'unavailable');
      end if;
      continue;
    end if;

    projected_records := coalesce((
      select pg_catalog.jsonb_agg(
        case when (item.value -> 'recordScope' ->> 'recordId')::uuid = candidate.record_id
          and (item.value -> 'recordScope' ->> 'recordTypeId')::uuid = p_record_type_id
          then item.value || pg_catalog.jsonb_build_object('lifecycleState', 'active')
          else item.value end order by item.ordinality
      )
      from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
        with ordinality as item(value, ordinality)
    ), '[]'::jsonb);
    projected_facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'binding', loaded -> 'declaration' -> 'recordBinding',
      'records', projected_records
    );
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', candidate.record_id, projected_facts
    );
    action_allowed := decision ->> 'outcome' = 'allowed';
    if action_allowed is distinct from true then
      if p_record_id is not null then
        return pg_catalog.jsonb_build_object('outcome', 'unavailable');
      end if;
      continue;
    end if;
    attachment_fields_value := '[]'::jsonb;
    attachment_field_count := 0;
    total_attachment_count := 0;
    for field_item in
      select declared.value
      from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as declared(value)
      where declared.value ->> 'type' = 'attachment'
      order by pg_catalog.lower(declared.value ->> 'fieldId') collate "C"
    loop
      attachment_field_count := attachment_field_count + 1;
      if attachment_field_count > 500 then
        return pg_catalog.jsonb_build_object('outcome', 'unavailable');
      end if;
      attachment_file_ids := array[]::uuid[];
      field_value := loaded -> 'fieldValues' -> pg_catalog.lower(field_item ->> 'fieldId');
      if field_value is not null and pg_catalog.jsonb_typeof(field_value) <> 'null' then
        if pg_catalog.jsonb_typeof(field_value) <> 'array'
          or pg_catalog.jsonb_array_length(field_value) > 100 then
          return pg_catalog.jsonb_build_object('outcome', 'unavailable');
        end if;
        for attachment_file_text in
          select item.value
          from pg_catalog.jsonb_array_elements_text(field_value) as item(value)
        loop
          if total_attachment_count >= 1000 then
            return pg_catalog.jsonb_build_object('outcome', 'unavailable');
          end if;
          begin
            attachment_file_id := attachment_file_text::uuid;
          exception when invalid_text_representation then
            return pg_catalog.jsonb_build_object('outcome', 'unavailable');
          end;
          if not vortex_context.is_non_nil_uuid(attachment_file_id::text)
            or attachment_file_id = any (attachment_file_ids) then
            return pg_catalog.jsonb_build_object('outcome', 'unavailable');
          end if;
          attachment_file_ids := pg_catalog.array_append(attachment_file_ids, attachment_file_id);
          total_attachment_count := total_attachment_count + 1;
        end loop;
      end if;
      select coalesce(pg_catalog.array_agg(item.file_id order by item.file_id), array[]::uuid[])
      into attachment_file_ids
      from pg_catalog.unnest(attachment_file_ids) as item(file_id);
      attachment_fields_value := attachment_fields_value || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'fieldId', pg_catalog.lower(field_item ->> 'fieldId'),
          'fileIds', pg_catalog.to_jsonb(attachment_file_ids)
        )
      );
    end loop;
    result_rows := result_rows || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'recordId', candidate.record_id,
        'revision', candidate.concurrency_number
      )
    );
    if p_record_id is not null then
      if pg_catalog.clock_timestamp() >= candidate.deleted_at +
        pg_catalog.make_interval(days => recovery_window_days) then
        return pg_catalog.jsonb_build_object('outcome', 'unavailable');
      end if;
      return pg_catalog.jsonb_build_object(
        'outcome', 'available', 'record', result_rows -> 0,
        'inventory', pg_catalog.jsonb_build_object(
          'storageContractId', meta -> 'storageContractId',
          'moduleRootId', meta -> 'moduleRootId',
          'moduleReleaseRevision', meta -> 'moduleReleaseRevision',
          'storageScope', meta -> 'storageScope',
          'table', meta -> 'table',
          'originalDeletedAt', candidate.deleted_at,
          'recoveryPolicyRevision', policy_value -> 'policyRevision',
          'recoveryWindowDays', policy_value -> 'recoveryWindowDays',
          'attachmentFields', attachment_fields_value
        )
      );
    end if;
  end loop;
  if p_record_id is not null or pg_catalog.jsonb_array_length(result_rows) = 0 then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'available', 'records', result_rows);
end
$function$;

alter function vortex_record.read_recoverable_record_for_restore(uuid,uuid,bigint)
  owner to vortex_record_adapter;

revoke all on function vortex_record.read_recoverable_record_for_restore(uuid,uuid,bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_recoverable_record_for_restore(uuid,uuid,bigint)
  to vortex_runtime, vortex_record_owner;
comment on function vortex_record.read_recoverable_record_for_restore(uuid,uuid,bigint) is
  'Current HUMAN installed-Application restore selection: returns only bounded content-free eligible record UUID/revision candidates, or the exact selected current candidate, after current restore authority and deletion-window checks.';

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

create or replace function vortex_record.read_record_restore_inventory_command_internal(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint
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
  fingerprint_value text;
  effect_count integer;
  selected_record jsonb;
  authority jsonb;
  target_effect jsonb;
  inventory_value jsonb;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id is null
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    raise exception using errcode = '22023',
      message = 'Record restore inventory command is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record restore inventory requires an Application context';
  end if;
  fingerprint_value := vortex_record.record_lifecycle_command_fingerprint_internal(
    p_command_id, 'restore', p_record_type_id, p_record_id,
    p_expected_concurrency_number
  );

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
    or receipt.operation is distinct from 'restore'
    or receipt.command_fingerprint is distinct from fingerprint_value
    or receipt.record_type_id is distinct from p_record_type_id
    or receipt.record_id is distinct from p_record_id
    or receipt.expected_concurrency_number is distinct from p_expected_concurrency_number then
    raise exception using errcode = '42501',
      message = 'Record restore inventory receipt is unavailable';
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

  if effect_count = 0 then
    selected_record := vortex_record.read_recoverable_record_for_restore(
      p_record_type_id, p_record_id, p_expected_concurrency_number
    );
    if selected_record ->> 'outcome' is distinct from 'available'
      or (selected_record #>> '{record,recordId}')::uuid is distinct from p_record_id
      or (selected_record #>> '{record,revision}')::bigint
        is distinct from p_expected_concurrency_number
      or pg_catalog.jsonb_typeof(selected_record -> 'inventory') is distinct from 'object' then
      raise exception using errcode = '42501',
        message = 'Record restore inventory selection is unavailable';
    end if;
    inventory_value := selected_record -> 'inventory';
    authority := pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'effects', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'storageContractId', inventory_value -> 'storageContractId',
        'moduleRootId', inventory_value -> 'moduleRootId',
        'moduleReleaseRevision', inventory_value -> 'moduleReleaseRevision',
        'storageScope', inventory_value -> 'storageScope',
        'recordTypeId', p_record_type_id,
        'recordId', p_record_id,
        'preConcurrencyNumber', p_expected_concurrency_number,
        'postConcurrencyNumber', p_expected_concurrency_number + 1,
        'attachmentFields', inventory_value -> 'attachmentFields'
      ))
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'available', 'phase', 'before_restore',
      'inventory', inventory_value, 'authority', authority
    );
  elsif effect_count = 1 then
    authority := vortex_record.read_record_owned_file_restore_authority_internal(
      p_command_id
    );
    if authority ->> 'outcome' is distinct from 'prepared'
      or pg_catalog.jsonb_typeof(authority -> 'effects') is distinct from 'array'
      or pg_catalog.jsonb_array_length(authority -> 'effects') <> 1 then
      raise exception using errcode = '42501',
        message = 'Record restore inventory effect is unavailable';
    end if;
    select item.value into strict target_effect
    from pg_catalog.jsonb_array_elements(authority -> 'effects') as item(value)
    limit 1;
    if (target_effect ->> 'recordTypeId')::uuid is distinct from p_record_type_id
      or (target_effect ->> 'recordId')::uuid is distinct from p_record_id
      or (target_effect ->> 'preConcurrencyNumber')::bigint
        is distinct from p_expected_concurrency_number then
      raise exception using errcode = '42501',
        message = 'Record restore inventory effect is unavailable';
    end if;
    inventory_value := pg_catalog.jsonb_build_object(
      'storageContractId', target_effect -> 'storageContractId',
      'moduleRootId', target_effect -> 'moduleRootId',
      'moduleReleaseRevision', target_effect -> 'moduleReleaseRevision',
      'storageScope', target_effect -> 'storageScope',
      'originalDeletedAt', target_effect -> 'originalDeletedAt',
      'recoveryPolicyRevision', target_effect -> 'recoveryPolicyRevision',
      'recoveryWindowDays', target_effect -> 'recoveryWindowDays',
      'attachmentFields', target_effect -> 'attachmentFields'
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'available', 'phase', 'after_restore',
      'inventory', inventory_value, 'authority', authority
    );
  end if;

  raise exception using errcode = '55000',
    message = 'Record restore inventory effects are incomplete';
end
$function$;

alter function vortex_record.read_record_restore_inventory_command_internal(uuid,uuid,uuid,bigint)
  owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_restore_inventory_command_internal(uuid,uuid,uuid,bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_file_owner, vortex_record_inventory, vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_record_restore_inventory_command_internal(uuid,uuid,uuid,bigint)
  to vortex_record_owner;
comment on function vortex_record.read_record_restore_inventory_command_internal(uuid,uuid,uuid,bigint) is
  'Adapter-owned proof bridge for the protected Record restore inventory lock: it binds the current HUMAN organization, Application and account to the pending command fingerprint and exact target, then returns only the pretransition restore selection or the existing verified posttransition authority.';


reset role;

set local role vortex_record_owner;
create or replace function vortex_record.lock_record_restore_file_inventory_internal(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority jsonb;
  selected_after jsonb;
  command_evidence jsonb;
  target_effect jsonb;
  inventory_value jsonb;
  context_value jsonb;
  restored_authority_after jsonb;
  relation_row record;
  storage_row vortex_record.storage_catalogue%rowtype;
  relation_oid oid;
  owner_role_oid oid := 'vortex_record_owner'::regrole::oid;
  adapter_role_oid oid := 'vortex_record_adapter'::regrole::oid;
  contract_id_value uuid;
  token_value text;
  reader_schema_value text;
  reader_function_value text;
  reader_function_oid oid;
  request_timeout interval;
  request_lock_timeout interval;
  request_deadline_at timestamptz;
  storage_count integer := 0;
  relation_count integer := 0;
  attachment_mapping_count integer;
  restored_effect_count integer;
  has_attachment_candidates boolean;
  attachment_mappings jsonb := '[]'::jsonb;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id is null
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    raise exception using errcode = '22023',
      message = 'Record File inventory command is invalid';
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
      message = 'Record File inventory request is unavailable';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record restore inventory requires an Application context';
  end if;
  command_evidence := vortex_record.read_record_restore_inventory_command_internal(
    p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if command_evidence ->> 'outcome' is distinct from 'available'
    or pg_catalog.jsonb_typeof(command_evidence -> 'inventory') is distinct from 'object'
    or pg_catalog.jsonb_typeof(command_evidence -> 'authority') is distinct from 'object' then
    raise exception using errcode = '55000',
      message = 'Record restore inventory evidence is incomplete';
  end if;
  if command_evidence ->> 'phase' = 'before_restore' then
    restored_effect_count := 0;
  elsif command_evidence ->> 'phase' = 'after_restore' then
    restored_effect_count := 1;
  else
    raise exception using errcode = '55000',
      message = 'Record restore inventory phase is unavailable';
  end if;
  inventory_value := command_evidence -> 'inventory';
  authority := command_evidence -> 'authority';
  if authority ->> 'outcome' is distinct from 'prepared'
    or pg_catalog.jsonb_typeof(authority -> 'effects') is distinct from 'array'
    or pg_catalog.jsonb_array_length(authority -> 'effects') <> 1 then
    raise exception using errcode = '42501',
      message = 'Record restore inventory authority is unavailable';
  end if;
  select item.value into strict target_effect
  from pg_catalog.jsonb_array_elements(authority -> 'effects') as item(value)
  limit 1;
  if (target_effect ->> 'recordTypeId')::uuid is distinct from p_record_type_id
    or (target_effect ->> 'recordId')::uuid is distinct from p_record_id
    or (target_effect ->> 'preConcurrencyNumber')::bigint
      is distinct from p_expected_concurrency_number then
    raise exception using errcode = '42501',
      message = 'Record restore inventory authority is unavailable';
  end if;
  if pg_catalog.jsonb_typeof(authority -> 'effects') is distinct from 'array'
    or pg_catalog.jsonb_array_length(authority -> 'effects') <> 1
    or pg_catalog.jsonb_typeof(inventory_value -> 'attachmentFields') is distinct from 'array'
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(inventory_value -> 'attachmentFields') as field(value)
      where pg_catalog.jsonb_typeof(field.value -> 'fileIds') is distinct from 'array'
    ) then
    raise exception using errcode = '42501',
      message = 'Record restore inventory authority is unavailable';
  end if;
  select exists (
    select 1
    from pg_catalog.jsonb_array_elements(inventory_value -> 'attachmentFields') as field(value)
    cross join lateral pg_catalog.jsonb_array_elements_text(field.value -> 'fileIds') as file(value)
  ) into has_attachment_candidates;
  if not has_attachment_candidates then
    if restored_effect_count = 0 then
      selected_after := vortex_record.read_recoverable_record_for_restore(
        p_record_type_id, p_record_id, p_expected_concurrency_number
      );
      if selected_after ->> 'outcome' is distinct from 'available'
        or selected_after -> 'inventory' is distinct from inventory_value then
        raise exception using errcode = '40001',
          message = 'Record restore inventory selection became stale';
      end if;
    else
      command_evidence := vortex_record.read_record_restore_inventory_command_internal(
        p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number
      );
      restored_authority_after := command_evidence -> 'authority';
      if command_evidence ->> 'outcome' is distinct from 'available'
        or command_evidence ->> 'phase' is distinct from 'after_restore'
        or command_evidence -> 'inventory' is distinct from inventory_value
        or restored_authority_after ->> 'outcome' is distinct from 'prepared'
        or pg_catalog.jsonb_array_length(restored_authority_after -> 'effects') <> 1
        or (restored_authority_after #>> '{effects,0,recordProofDigest}') is distinct from
          (authority #>> '{effects,0,recordProofDigest}')
        or restored_authority_after #> '{effects,0,attachmentFields}' is distinct from
          authority #> '{effects,0,attachmentFields}'
        or (restored_authority_after #>> '{effects,0,requestDeadlineAt}') is distinct from
          (authority #>> '{effects,0,requestDeadlineAt}') then
        raise exception using errcode = '40001',
          message = 'Record restore inventory proof became stale';
      end if;
      authority := restored_authority_after;
    end if;
    if request_deadline_at <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '57014',
        message = 'Record File inventory request deadline expired';
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'locked', 'relationCount', 0, 'attachmentMappings', '[]'::jsonb,
      'storageContractId', inventory_value -> 'storageContractId',
      'moduleRootId', inventory_value -> 'moduleRootId',
      'moduleReleaseRevision', inventory_value -> 'moduleReleaseRevision',
      'storageScope', inventory_value -> 'storageScope',
      'originalDeletedAt', inventory_value -> 'originalDeletedAt',
      'recoveryPolicyRevision', inventory_value -> 'recoveryPolicyRevision',
      'recoveryWindowDays', inventory_value -> 'recoveryWindowDays',
      'attachmentFields', inventory_value -> 'attachmentFields'
    );
  end if;
  -- Freeze catalogue membership before enumerating tables, then take SHARE
  -- locks in one bytewise order so no concurrent Record writer can add or
  -- redirect an attachment reference during the organization-wide scan.
  lock table vortex_record.storage_catalogue,
    vortex_record.field_storage_mappings in share mode;
  if request_deadline_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '57014',
      message = 'Record File inventory request deadline expired';
  end if;
  if restored_effect_count = 0 then
    selected_after := vortex_record.read_recoverable_record_for_restore(
      p_record_type_id, p_record_id, p_expected_concurrency_number
    );
    if selected_after ->> 'outcome' is distinct from 'available'
      or selected_after -> 'inventory' is distinct from inventory_value then
      raise exception using errcode = '40001',
        message = 'Record restore inventory selection became stale';
    end if;
  else
    command_evidence := vortex_record.read_record_restore_inventory_command_internal(
      p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number
    );
    restored_authority_after := command_evidence -> 'authority';
    if command_evidence ->> 'outcome' is distinct from 'available'
      or command_evidence ->> 'phase' is distinct from 'after_restore'
      or command_evidence -> 'inventory' is distinct from inventory_value
      or restored_authority_after ->> 'outcome' is distinct from 'prepared'
      or pg_catalog.jsonb_array_length(restored_authority_after -> 'effects') <> 1
      or (restored_authority_after #>> '{effects,0,recordProofDigest}') is distinct from
        (authority #>> '{effects,0,recordProofDigest}')
      or restored_authority_after #> '{effects,0,attachmentFields}' is distinct from
        authority #> '{effects,0,attachmentFields}'
      or (restored_authority_after #>> '{effects,0,requestDeadlineAt}') is distinct from
        (authority #>> '{effects,0,requestDeadlineAt}') then
      raise exception using errcode = '40001',
        message = 'Record restore inventory proof became stale';
    end if;
    authority := restored_authority_after;
  end if;

  if exists (
    select 1
    from vortex_record.storage_catalogue as catalogue
    where catalogue.state = 'active'
      and (catalogue.physical_schema_token is null
        or catalogue.physical_schema_token not in ('record_data', 'system_projection'))
  ) then
    raise exception using errcode = '55000',
      message = 'Record File inventory has an unsupported storage scope';
  end if;

  for storage_row in
    select bounded.*
    from (
      select stored.*
      from vortex_record.storage_catalogue as stored
      where stored.physical_schema_token in ('record_data', 'system_projection')
      order by stored.physical_table_token collate "C", stored.storage_contract_id
      limit 513
    ) as bounded
  loop
    storage_count := storage_count + 1;
    if storage_count > 512 or request_deadline_at <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '57014',
        message = 'Record File inventory storage limit exceeded';
    end if;
    if storage_row.physical_table_token !~ '^rt_[0-9a-f]{32}$'
      or storage_row.physical_table_token <> 'rt_' ||
        pg_catalog.replace(pg_catalog.lower(storage_row.storage_contract_id::text), '-', '') then
      raise exception using errcode = '55000',
        message = 'Record File inventory catalogue is incomplete';
    end if;
    relation_oid := pg_catalog.to_regclass(pg_catalog.format(
      '%I.%I', 'record_data', storage_row.physical_table_token
    ))::oid;
    if storage_row.physical_schema_token = 'record_data' then
      if relation_oid is null
        or not exists (
          select 1 from pg_catalog.pg_class as relation
          where relation.oid = relation_oid
            and relation.relkind = 'r'
            and relation.relpersistence = 'p'
            and not relation.relispartition
            and relation.relowner = owner_role_oid
            and relation.relrowsecurity
            and relation.relforcerowsecurity
        ) then
        raise exception using errcode = '55000',
          message = 'Record File inventory storage is unavailable';
      end if;
    else
      select registered.reader_schema, registered.reader_function
      into reader_schema_value, reader_function_value
      from vortex_record.protected_read_model_views as registered
      where registered.protected_read_model_key = storage_row.protected_read_model_key;
      reader_function_oid := case when reader_schema_value is not null
        then pg_catalog.to_regprocedure(pg_catalog.format(
          '%I.%I(uuid,integer)', reader_schema_value, reader_function_value
        ))::oid else null end;
      if relation_oid is null
        or reader_function_oid is null
        or not exists (
          select 1 from pg_catalog.pg_class as relation
          where relation.oid = relation_oid
            and relation.relkind = 'v'
            and relation.relpersistence = 'p'
            and relation.relowner = owner_role_oid
        )
        or not exists (
          select 1 from pg_catalog.pg_proc as reader
          where reader.oid = reader_function_oid and reader.prosecdef
        )
        or not exists (
          select 1 from pg_catalog.pg_rewrite as rule
          join pg_catalog.pg_depend as dependency
            on dependency.classid = 'pg_rewrite'::regclass
            and dependency.objid = rule.oid
            and dependency.refclassid = 'pg_proc'::regclass
            and dependency.refobjid = reader_function_oid
          where rule.ev_class = relation_oid and rule.rulename = '_RETURN'
        )
        or exists (
          select 1 from pg_catalog.pg_trigger as trigger
          where trigger.tgrelid = relation_oid and not trigger.tgisinternal
        )
        or exists (
          select 1 from pg_catalog.pg_rewrite as rule
          where rule.ev_class = relation_oid and rule.rulename <> '_RETURN'
        )
        or exists (
          select 1
          from pg_catalog.pg_rewrite as rule
          join pg_catalog.pg_depend as dependency
            on dependency.classid = 'pg_rewrite'::regclass
            and dependency.objid = rule.oid
            and dependency.refclassid = 'pg_class'::regclass
          where rule.ev_class = relation_oid and rule.rulename = '_RETURN'
            and dependency.refobjid <> relation_oid
        )
        or (
          select pg_catalog.count(*)
          from pg_catalog.pg_rewrite as rule
          where rule.ev_class = relation_oid and rule.rulename = '_RETURN'
        ) <> 1
        or not exists (
          select 1
          from pg_catalog.pg_class as relation
          cross join lateral pg_catalog.aclexplode(coalesce(
            relation.relacl, pg_catalog.acldefault('r', relation.relowner)
          )) as privilege
          where relation.oid = relation_oid
            and privilege.grantee = adapter_role_oid
            and privilege.privilege_type = 'SELECT'
            and not privilege.is_grantable
        )
        or exists (
          select 1
          from pg_catalog.pg_class as relation
          cross join lateral pg_catalog.aclexplode(coalesce(
            relation.relacl, pg_catalog.acldefault('r', relation.relowner)
          )) as privilege
          where relation.oid = relation_oid
            and (privilege.grantee not in (owner_role_oid, adapter_role_oid)
              or (privilege.grantee = adapter_role_oid
                and (privilege.privilege_type <> 'SELECT' or privilege.is_grantable)))
        )
        or exists (
          select 1 from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = relation_oid and attribute.attacl is not null
        )
        or not exists (
          select 1 from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = relation_oid and attribute.attname = 'record_id'
            and attribute.attnum > 0 and not attribute.attisdropped
        )
        or not exists (
          select 1 from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = relation_oid and attribute.attname = 'organisation_id'
            and attribute.attnum > 0 and not attribute.attisdropped
        )
        or not exists (
          select 1 from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = relation_oid and attribute.attname = 'application_root_id'
            and attribute.attnum > 0 and not attribute.attisdropped
        )
        or not exists (
          select 1 from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = relation_oid and attribute.attname = 'lifecycle_state'
            and attribute.attnum > 0 and not attribute.attisdropped
        ) then
        raise exception using errcode = '55000',
          message = 'Record File protected projection is unavailable';
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(storage_row.record_type_definition -> 'fields')
          as item(value)
        where not exists (
          select 1 from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = relation_oid
            and attribute.attname = 'f_' || pg_catalog.replace(
              pg_catalog.lower(item.value ->> 'fieldId'), '-', ''
            )
            and attribute.attnum > 0 and not attribute.attisdropped
        )
      ) then
        raise exception using errcode = '55000',
          message = 'Record File protected projection fields are incomplete';
      end if;
    end if;
  end loop;

  -- Every physical rt_/cp_ relation must have one exact contract lineage.
  -- Missing or unexpected inventory fails closed instead of becoming an empty
  -- owner set. All rows are scanned only by the current-organisation role.
  for relation_row in
    select bounded.oid, bounded.relname
    from (
      select relation.oid, relation.relname
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      where namespace.nspname = 'record_data'
        and relation.relkind = 'r'
        and relation.relpersistence = 'p'
        and not relation.relispartition
        and (relation.relname ~ '^rt_[0-9a-f]{32}$'
          or relation.relname ~ '^cp_[0-9a-f]{32}$')
      order by relation.relname collate "C", relation.oid
      limit 1025
    ) as bounded
  loop
    relation_count := relation_count + 1;
    if relation_count > 1024 or request_deadline_at <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '57014',
        message = 'Record File inventory relation limit exceeded';
    end if;
    if not exists (
      select 1 from pg_catalog.pg_class as relation
      where relation.oid = relation_row.oid
        and relation.relowner = owner_role_oid
        and relation.relrowsecurity
        and relation.relforcerowsecurity
    ) then
      raise exception using errcode = '55000',
        message = 'Record File inventory relation is incompatible';
    end if;
    token_value := pg_catalog.substr(relation_row.relname, 4);
    contract_id_value := (
      pg_catalog.substr(token_value, 1, 8) || '-' ||
      pg_catalog.substr(token_value, 9, 4) || '-' ||
      pg_catalog.substr(token_value, 13, 4) || '-' ||
      pg_catalog.substr(token_value, 17, 4) || '-' ||
      pg_catalog.substr(token_value, 21, 12)
    )::uuid;
    if pg_catalog.starts_with(relation_row.relname, 'rt_') then
      if not exists (
        select 1 from vortex_record.storage_catalogue as catalogue
        where catalogue.storage_contract_id = contract_id_value
          and catalogue.physical_table_token = relation_row.relname
          and catalogue.physical_schema_token in ('record_data', 'system_projection')
      ) then
        raise exception using errcode = '55000',
          message = 'Record File inventory Record lineage is unavailable';
      end if;
    else
      if not exists (
        select 1
        from vortex_record.storage_catalogue as catalogue
        join vortex_record.field_storage_mappings as mapping
          on mapping.storage_contract_id = catalogue.storage_contract_id
        where catalogue.storage_contract_id = contract_id_value
          and catalogue.physical_table_token = 'rt_' || token_value
          and mapping.introduced_by_module_root_id <> catalogue.module_root_id
          and mapping.state in ('active', 'retired')
      ) then
        raise exception using errcode = '55000',
          message = 'Record File inventory companion lineage is unavailable';
      end if;
    end if;
    execute pg_catalog.format(
      'lock table record_data.%I in share mode', relation_row.relname
    );
  end loop;

  if relation_count = 0 then
    raise exception using errcode = '55000',
      message = 'Record File inventory is unavailable';
  end if;
  select coalesce(pg_catalog.jsonb_agg(mapping.value order by
    (mapping.value ->> 'storage_contract_id')::uuid,
    (mapping.value ->> 'field_id')::uuid
  ), '[]'::jsonb)
  into attachment_mappings
  from (
    select pg_catalog.jsonb_build_object(
      'storage_contract_id', catalogue.storage_contract_id,
      'module_root_id', catalogue.module_root_id,
      'record_type_id', catalogue.record_type_id,
      'storage_scope', catalogue.storage_scope,
      'physical_schema_token', catalogue.physical_schema_token,
      'base_table_token', catalogue.physical_table_token,
      'table_token', case
        when mapping.introduced_by_module_root_id = catalogue.module_root_id
          then catalogue.physical_table_token
        else 'cp_' || pg_catalog.replace(
          pg_catalog.lower(catalogue.storage_contract_id::text), '-', ''
        ) end,
      'field_id', mapping.field_id,
      'column_token', mapping.physical_column_token,
      'database_value_type', mapping.database_value_type,
      'introduced_by_module_root_id', mapping.introduced_by_module_root_id
    ) as value
    from vortex_record.storage_catalogue as catalogue
    join vortex_record.field_storage_mappings as mapping
      on mapping.storage_contract_id = catalogue.storage_contract_id
    where mapping.state in ('active', 'retired')
      and mapping.field_definition ->> 'type' = 'attachment'
      and catalogue.physical_schema_token in ('record_data', 'system_projection')
    order by catalogue.storage_contract_id, mapping.field_id
    limit 4097
  ) as mapping;
  attachment_mapping_count := pg_catalog.jsonb_array_length(attachment_mappings);
  if attachment_mapping_count > 4096
    or request_deadline_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '57014',
      message = 'Record File inventory field limit exceeded';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(attachment_mappings) as item(value)
    where not exists (
      select 1
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = relation.oid
      where namespace.nspname = 'record_data'
        and relation.relname = item.value ->> 'table_token'
        and relation.relowner = owner_role_oid
        and relation.relkind = 'r'
        and relation.relpersistence = 'p'
        and relation.relrowsecurity
        and relation.relforcerowsecurity
        and attribute.attname = item.value ->> 'column_token'
        and attribute.attnum > 0
        and not attribute.attisdropped
        and attribute.atttypid = 'jsonb'::regtype
        and item.value ->> 'physical_schema_token' in ('record_data', 'system_projection')
        and not (
          item.value ->> 'physical_schema_token' = 'system_projection'
          and item.value ->> 'table_token' = item.value ->> 'base_table_token'
        )
    )
  ) then
    raise exception using errcode = '55000',
      message = 'Record File attachment catalogue is incomplete';
  end if;
  if request_deadline_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '57014',
      message = 'Record File inventory request deadline expired';
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'locked', 'relationCount', relation_count,
    'attachmentMappings', attachment_mappings,
    'storageContractId', inventory_value -> 'storageContractId',
    'moduleRootId', inventory_value -> 'moduleRootId',
    'moduleReleaseRevision', inventory_value -> 'moduleReleaseRevision',
    'storageScope', inventory_value -> 'storageScope',
    'originalDeletedAt', inventory_value -> 'originalDeletedAt',
    'recoveryPolicyRevision', inventory_value -> 'recoveryPolicyRevision',
    'recoveryWindowDays', inventory_value -> 'recoveryWindowDays',
    'attachmentFields', inventory_value -> 'attachmentFields'
  );
end
$function$;

alter function vortex_record.lock_record_restore_file_inventory_internal(uuid,uuid,uuid,bigint)
  owner to vortex_record_owner;

revoke all on function vortex_record.lock_record_restore_file_inventory_internal(uuid,uuid,uuid,bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_file_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.lock_record_restore_file_inventory_internal(uuid,uuid,uuid,bigint)
  to vortex_record_adapter, vortex_record_inventory;
comment on function vortex_record.lock_record_restore_file_inventory_internal(uuid,uuid,uuid,bigint) is
  'Privately locks the complete mapped Record and companion-table inventory for one current HUMAN restore candidate before mutation and cross-Application attachment membership is derived.';

reset role;

set local role vortex_record_inventory;
create or replace function vortex_record.read_record_file_restore_membership_internal(
  p_command_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  lock_result jsonb;
  authority jsonb;
  effect_item jsonb;
  target_effect jsonb;
  field_item jsonb;
  mapping_row record;
  match_row record;
  organization_id_value uuid;
  candidate_file_ids uuid[] := array[]::uuid[];
  candidate_file_text_value text;
  matching_count integer;
  invalid_values boolean;
  row_count integer;
  total_scope_rows integer := 0;
  total_owner_rows integer := 0;
  request_timeout interval;
  request_lock_timeout interval;
  request_deadline_at timestamptz;
  base_table_token text;
  physical_table_token text;
  physical_schema_token text;
  relation_oid oid;
  membership_values jsonb := '[]'::jsonb;
  expected boolean;
begin
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
      message = 'Record File membership request is unavailable';
  end if;
  authority := vortex_record.read_record_owned_file_restore_authority_internal(
    p_command_id
  );
  if authority ->> 'outcome' is distinct from 'prepared' then
    raise exception using errcode = '42501',
      message = 'Record File membership authority is unavailable';
  end if;
  select item.value into strict target_effect
  from pg_catalog.jsonb_array_elements(authority -> 'effects') as item(value)
  order by (item.value ->> 'effectSequence')::integer
  limit 1;
  lock_result := vortex_record.lock_record_restore_file_inventory_internal(
    p_command_id,
    (target_effect ->> 'recordTypeId')::uuid,
    (target_effect ->> 'recordId')::uuid,
    (target_effect ->> 'preConcurrencyNumber')::bigint
  );
  if lock_result ->> 'outcome' is distinct from 'locked' then
    raise exception using errcode = '55000',
      message = 'Record File restore inventory could not be confirmed';
  end if;
  authority := vortex_record.read_record_owned_file_restore_authority_internal(
    p_command_id
  );
  if authority ->> 'outcome' is distinct from 'prepared' then
    raise exception using errcode = '42501',
      message = 'Record File membership authority is unavailable';
  end if;
  select (item.value ->> 'organizationId')::uuid into strict organization_id_value
  from pg_catalog.jsonb_array_elements(authority -> 'effects') as item(value)
  order by (item.value ->> 'effectSequence')::integer
  limit 1;

  for effect_item in
    select item.value
    from pg_catalog.jsonb_array_elements(authority -> 'effects') as item(value)
    order by (item.value ->> 'effectSequence')::integer
  loop
    for field_item in
      select item.value
      from pg_catalog.jsonb_array_elements(effect_item -> 'attachmentFields') as item(value)
      order by item.value ->> 'fieldId' collate "C"
    loop
      for candidate_file_text_value in
        select item.value
        from pg_catalog.jsonb_array_elements_text(field_item -> 'fileIds') as item(value)
        order by item.value collate "C"
      loop
        if pg_catalog.cardinality(candidate_file_ids) >= 1000
          or request_deadline_at <= pg_catalog.clock_timestamp() then
          raise exception using errcode = '57014',
            message = 'Record File candidate limit exceeded';
        end if;
        candidate_file_ids := pg_catalog.array_append(
          candidate_file_ids, candidate_file_text_value::uuid
        );
      end loop;
    end loop;
  end loop;
  if pg_catalog.cardinality(candidate_file_ids) > (
    select pg_catalog.count(distinct item.value)
    from pg_catalog.unnest(candidate_file_ids) as item(value)
  ) then
    raise exception using errcode = '23514',
      message = 'File attachment has multiple Record owners';
  end if;

  if pg_catalog.cardinality(candidate_file_ids) > 0 then
    for mapping_row in
      select mapping.storage_contract_id, mapping.module_root_id,
        mapping.record_type_id, mapping.storage_scope,
        mapping.physical_schema_token, mapping.base_table_token, mapping.table_token,
        mapping.field_id, mapping.column_token,
        mapping.introduced_by_module_root_id, mapping.database_value_type
      from pg_catalog.jsonb_to_recordset(lock_result -> 'attachmentMappings') as mapping(
        storage_contract_id uuid,
        module_root_id uuid,
        record_type_id uuid,
        storage_scope text,
        physical_schema_token text,
        base_table_token text,
        table_token text,
        field_id uuid,
        column_token text,
        database_value_type text,
        introduced_by_module_root_id uuid
      )
      order by mapping.storage_contract_id, mapping.field_id
    loop
      physical_schema_token := mapping_row.physical_schema_token;
      base_table_token := mapping_row.base_table_token;
      physical_table_token := mapping_row.table_token;
      if physical_schema_token = 'system_projection'
        and physical_table_token = base_table_token then
        raise exception using errcode = '55000',
          message = 'Record File projection attachment source is unavailable';
      end if;
      relation_oid := pg_catalog.to_regclass(pg_catalog.format(
        '%I.%I', 'record_data', physical_table_token
      ))::oid;
      if relation_oid is null
        or mapping_row.database_value_type is distinct from 'json'
        or not exists (
          select 1 from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = relation_oid
            and attribute.attname = mapping_row.column_token
            and attribute.attnum > 0
            and not attribute.attisdropped
            and attribute.atttypid = 'jsonb'::regtype
        ) then
        raise exception using errcode = '55000',
          message = 'Record File attachment mapping is unavailable';
      end if;

      if physical_schema_token = 'system_projection' then
        execute pg_catalog.format(
          'select pg_catalog.count(*) from (
             select 1 from record_data.%I as companion
             where companion.organisation_id = $1
             limit 10001
           ) as bounded_rows',
          physical_table_token
        ) into row_count using organization_id_value;
      elsif physical_table_token = base_table_token then
        execute pg_catalog.format(
          'select pg_catalog.count(*) from (
             select 1 from record_data.%I as stored
             where stored.organisation_id = $1
               and stored.lifecycle_state <> ''removed''
             limit 10001
           ) as bounded_rows',
          physical_table_token
        ) into row_count using organization_id_value;
      else
        execute pg_catalog.format(
          'select pg_catalog.count(*) from (
             select 1
             from record_data.%I as companion
             join record_data.%I as stored
               on stored.organisation_id = companion.organisation_id
               and stored.record_id = companion.record_id
             where companion.organisation_id = $1
               and stored.lifecycle_state <> ''removed''
             limit 10001
           ) as bounded_rows',
          physical_table_token, base_table_token
        ) into row_count using organization_id_value;
      end if;
      if row_count > 10000 or total_scope_rows + row_count > 50000
        or request_deadline_at <= pg_catalog.clock_timestamp() then
        raise exception using errcode = '57014',
          message = 'Record File owner scan limit exceeded';
      end if;
      total_scope_rows := total_scope_rows + row_count;

      if physical_schema_token = 'system_projection' then
        execute pg_catalog.format(
          'select exists (
             select 1 from record_data.%I as companion
             where companion.organisation_id = $1
               and case
                 when companion.%I is null
                   or pg_catalog.jsonb_typeof(companion.%I) = ''null'' then false
                 when pg_catalog.jsonb_typeof(companion.%I) <> ''array'' then true
                 when pg_catalog.jsonb_array_length(companion.%I) > 100 then true
                 else exists (
                   select 1 from pg_catalog.jsonb_array_elements_text(companion.%I) as item(value)
                   where item.value !~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''
                     or item.value = ''00000000-0000-0000-0000-000000000000''
                 ) or (
                   select pg_catalog.count(*) <> pg_catalog.count(distinct item.value)
                   from pg_catalog.jsonb_array_elements_text(companion.%I) as item(value)
                 )
               end
           )',
          physical_table_token,
          mapping_row.column_token, mapping_row.column_token,
          mapping_row.column_token, mapping_row.column_token,
          mapping_row.column_token, mapping_row.column_token
        ) into invalid_values using organization_id_value;
      elsif physical_table_token = base_table_token then
        execute pg_catalog.format(
          'select exists (
             select 1 from record_data.%I as stored
             where stored.organisation_id = $1
               and (
                 stored.lifecycle_state not in (''active'', ''soft_deleted'', ''removal_pending'', ''removed'')
                 or (stored.lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')
                   and case
                     when stored.%I is null
                       or pg_catalog.jsonb_typeof(stored.%I) = ''null'' then false
                     when pg_catalog.jsonb_typeof(stored.%I) <> ''array'' then true
                     when pg_catalog.jsonb_array_length(stored.%I) > 100 then true
                     else exists (
                       select 1 from pg_catalog.jsonb_array_elements_text(stored.%I) as item(value)
                       where item.value !~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''
                         or item.value = ''00000000-0000-0000-0000-000000000000''
                     ) or (
                       select pg_catalog.count(*) <> pg_catalog.count(distinct item.value)
                       from pg_catalog.jsonb_array_elements_text(stored.%I) as item(value)
                     )
                   end)
               )
           )',
          physical_table_token,
          mapping_row.column_token, mapping_row.column_token,
          mapping_row.column_token, mapping_row.column_token,
          mapping_row.column_token, mapping_row.column_token
        ) into invalid_values using organization_id_value;
      else
        execute pg_catalog.format(
          'select exists (
             select 1
             from record_data.%I as companion
             join record_data.%I as stored
               on stored.organisation_id = companion.organisation_id
               and stored.record_id = companion.record_id
             where companion.organisation_id = $1
               and (
                 stored.lifecycle_state not in (''active'', ''soft_deleted'', ''removal_pending'', ''removed'')
                 or (stored.lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')
                   and case
                     when companion.%I is null
                       or pg_catalog.jsonb_typeof(companion.%I) = ''null'' then false
                     when pg_catalog.jsonb_typeof(companion.%I) <> ''array'' then true
                     when pg_catalog.jsonb_array_length(companion.%I) > 100 then true
                     else exists (
                       select 1 from pg_catalog.jsonb_array_elements_text(companion.%I) as item(value)
                       where item.value !~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''
                         or item.value = ''00000000-0000-0000-0000-000000000000''
                     ) or (
                       select pg_catalog.count(*) <> pg_catalog.count(distinct item.value)
                       from pg_catalog.jsonb_array_elements_text(companion.%I) as item(value)
                     )
                   end)
               )
           )',
          physical_table_token, base_table_token,
          mapping_row.column_token, mapping_row.column_token,
          mapping_row.column_token, mapping_row.column_token,
          mapping_row.column_token, mapping_row.column_token
        ) into invalid_values using organization_id_value;
      end if;
      if invalid_values then
        raise exception using errcode = '23514',
          message = 'Record File attachment value is invalid';
      end if;
      if request_deadline_at <= pg_catalog.clock_timestamp() then
        raise exception using errcode = '57014',
          message = 'Record File owner scan deadline expired';
      end if;

      if physical_schema_token = 'system_projection' then
        -- The registered projection view is validated by the inventory locker.
        -- Its current source contract cannot declare base attachment fields;
        -- contributed attachment values live in this organization-scoped cp_
        -- table. Count every retained cp_ reference directly. If the protected
        -- source no longer emits a row, keeping its persisted reference as an
        -- owner is conservative; it must never become an empty-owner result.
        for match_row in execute pg_catalog.format(
          'select companion.record_id, null::uuid as application_root_id,
             item.value::uuid as file_id
           from record_data.%I as companion
           cross join lateral pg_catalog.jsonb_array_elements_text(
             pg_catalog.to_jsonb(companion.%I)
           ) as item(value)
           where companion.organisation_id = $1
             and pg_catalog.jsonb_typeof(companion.%I) = ''array''
             and item.value::uuid = any ($2::uuid[])',
          physical_table_token, mapping_row.column_token, mapping_row.column_token
        ) using organization_id_value, candidate_file_ids
        loop
          total_owner_rows := total_owner_rows + 1;
          if total_owner_rows > 50000
            or request_deadline_at <= pg_catalog.clock_timestamp() then
            raise exception using errcode = '57014',
              message = 'Record File owner result limit exceeded';
          end if;
          expected := exists (
            select 1
            from pg_catalog.jsonb_array_elements(authority -> 'effects') as effect(value)
            cross join lateral pg_catalog.jsonb_array_elements(
              effect.value -> 'attachmentFields'
            ) as field(value)
            where (effect.value ->> 'storageContractId')::uuid =
                mapping_row.storage_contract_id
              and (effect.value ->> 'recordId')::uuid = match_row.record_id
              and (effect.value ->> 'recordTypeId')::uuid = mapping_row.record_type_id
              and (field.value ->> 'fieldId')::uuid = mapping_row.field_id
              and field.value -> 'fileIds' ? (match_row.file_id::text)
          );
          if not expected then
            raise exception using errcode = '23514',
              message = 'File attachment has another Record owner';
          end if;
          membership_values := membership_values || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'fileId', match_row.file_id::uuid,
              'storageContractId', mapping_row.storage_contract_id,
              'recordTypeId', mapping_row.record_type_id,
              'recordId', match_row.record_id,
              'fieldId', mapping_row.field_id,
              'applicationRootId', null
            )
          );
        end loop;
      elsif physical_table_token = base_table_token then
        for match_row in execute pg_catalog.format(
          'select stored.record_id, stored.application_root_id,
             item.value::uuid as file_id
           from record_data.%I as stored
           cross join lateral pg_catalog.jsonb_array_elements_text(
             pg_catalog.to_jsonb(stored.%I)
           ) as item(value)
           where stored.organisation_id = $1
             and stored.lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')
             and pg_catalog.jsonb_typeof(stored.%I) = ''array''
             and item.value::uuid = any ($2::uuid[])',
          physical_table_token, mapping_row.column_token, mapping_row.column_token
        ) using organization_id_value, candidate_file_ids
        loop
          total_owner_rows := total_owner_rows + 1;
          if total_owner_rows > 50000
            or request_deadline_at <= pg_catalog.clock_timestamp() then
            raise exception using errcode = '57014',
              message = 'Record File owner result limit exceeded';
          end if;
          expected := exists (
            select 1
            from pg_catalog.jsonb_array_elements(authority -> 'effects') as effect(value)
            cross join lateral pg_catalog.jsonb_array_elements(
              effect.value -> 'attachmentFields'
            ) as field(value)
            where (effect.value ->> 'storageContractId')::uuid =
                mapping_row.storage_contract_id
              and (effect.value ->> 'recordId')::uuid = match_row.record_id
              and (effect.value ->> 'recordTypeId')::uuid = mapping_row.record_type_id
              and (field.value ->> 'fieldId')::uuid = mapping_row.field_id
              and field.value -> 'fileIds' ? (match_row.file_id::text)
          );
          if not expected then
            raise exception using errcode = '23514',
              message = 'File attachment has another Record owner';
          end if;
          membership_values := membership_values || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'fileId', match_row.file_id::uuid,
              'storageContractId', mapping_row.storage_contract_id,
              'recordTypeId', mapping_row.record_type_id,
              'recordId', match_row.record_id,
              'fieldId', mapping_row.field_id,
              'applicationRootId', match_row.application_root_id
            )
          );
        end loop;
      else
        for match_row in execute pg_catalog.format(
          'select stored.record_id, stored.application_root_id,
             item.value::uuid as file_id
           from record_data.%I as companion
           join record_data.%I as stored
             on stored.organisation_id = companion.organisation_id
             and stored.record_id = companion.record_id
           cross join lateral pg_catalog.jsonb_array_elements_text(
             pg_catalog.to_jsonb(companion.%I)
           ) as item(value)
           where companion.organisation_id = $1
             and stored.lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')
             and pg_catalog.jsonb_typeof(companion.%I) = ''array''
             and item.value::uuid = any ($2::uuid[])',
          physical_table_token, base_table_token,
          mapping_row.column_token, mapping_row.column_token
        ) using organization_id_value, candidate_file_ids
        loop
          total_owner_rows := total_owner_rows + 1;
          if total_owner_rows > 50000
            or request_deadline_at <= pg_catalog.clock_timestamp() then
            raise exception using errcode = '57014',
              message = 'Record File owner result limit exceeded';
          end if;
          expected := exists (
            select 1
            from pg_catalog.jsonb_array_elements(authority -> 'effects') as effect(value)
            cross join lateral pg_catalog.jsonb_array_elements(
              effect.value -> 'attachmentFields'
            ) as field(value)
            where (effect.value ->> 'storageContractId')::uuid =
                mapping_row.storage_contract_id
              and (effect.value ->> 'recordId')::uuid = match_row.record_id
              and (effect.value ->> 'recordTypeId')::uuid = mapping_row.record_type_id
              and (field.value ->> 'fieldId')::uuid = mapping_row.field_id
              and field.value -> 'fileIds' ? (match_row.file_id::text)
          );
          if not expected then
            raise exception using errcode = '23514',
              message = 'File attachment has another Record owner';
          end if;
          membership_values := membership_values || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'fileId', match_row.file_id::uuid,
              'storageContractId', mapping_row.storage_contract_id,
              'recordTypeId', mapping_row.record_type_id,
              'recordId', match_row.record_id,
              'fieldId', mapping_row.field_id,
              'applicationRootId', match_row.application_root_id
            )
          );
        end loop;
      end if;
    end loop;
  end if;

  for candidate_file_text_value in
    select distinct item.value::text
    from pg_catalog.unnest(candidate_file_ids) as item(value)
  loop
    select pg_catalog.count(*) into matching_count
    from pg_catalog.jsonb_array_elements(membership_values) as membership(value)
    where membership.value ->> 'fileId' = candidate_file_text_value;
    if matching_count <> 1 then
      raise exception using errcode = '23514',
        message = 'File attachment ownership is incomplete';
    end if;
  end loop;

  if request_deadline_at <= pg_catalog.clock_timestamp()
    or pg_catalog.jsonb_array_length(membership_values) > 50000 then
    raise exception using errcode = '57014',
      message = 'Record File owner scan is incomplete';
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'complete',
    'effects', authority -> 'effects',
    'memberships', membership_values
  );
end
$function$;

alter function vortex_record.read_record_file_restore_membership_internal(uuid)
  owner to vortex_record_inventory;

revoke all on function vortex_record.read_record_file_restore_membership_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_file_owner, vortex_record_adapter, vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_record_file_restore_membership_internal(uuid)
  to vortex_file_owner, vortex_record_inventory;
comment on function vortex_record.read_record_file_restore_membership_internal(uuid) is
  'Organization-complete content-free restored-attachment membership reader over forced-RLS Record and companion storage, callable only by the File owner and inventory owner.';

reset role;

set local role vortex_record_adapter;
create or replace function vortex_record.settle_record_owned_file_restore_cascade_internal(
  p_command_id uuid,
  p_settlements jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.record_lifecycle_command_receipts%rowtype;
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  settlement jsonb;
  settlement_count integer;
  effect_count integer;
  changed_rows integer;
  request_deadline_at timestamptz;
  request_timeout interval;
  request_lock_timeout interval;
  authority jsonb;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_settlements) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Record File cascade settlement is invalid';
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
      message = 'Record File settlement request is unavailable';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record File restore settlement requires an Application context';
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
      message = 'Record File restore settlement receipt is unavailable';
  end if;

  select pg_catalog.count(*) into effect_count
  from (
    select 1
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id
      and effect.effect_kind = 'restored'
    limit 101
  ) as bounded_effects;
  select pg_catalog.count(*) into settlement_count
  from pg_catalog.jsonb_array_elements(p_settlements) as item(value);
  if effect_count <> 1 or settlement_count <> 1
    or settlement_count <> effect_count
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_settlements) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or item.value - array['effectSequence', 'proofDigest'] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(item.value -> 'effectSequence') is distinct from 'number'
        or (item.value ->> 'effectSequence') !~ '^[1-9][0-9]*$'
        or pg_catalog.jsonb_typeof(item.value -> 'proofDigest') is distinct from 'string'
        or (item.value ->> 'proofDigest') !~ '^[0-9a-f]{64}$'
    )
    or (
      select pg_catalog.count(distinct (item.value ->> 'effectSequence')::integer)
      from pg_catalog.jsonb_array_elements(p_settlements) as item(value)
    ) <> effect_count then
    raise exception using errcode = '55000',
      message = 'Record File restore settlement is incomplete';
  end if;

  authority := vortex_record.read_record_owned_file_restore_authority_internal(
    p_command_id
  );
  if authority ->> 'outcome' is distinct from 'prepared'
    or authority #> '{effects,0,recordProofDigest}' is null
    or request_deadline_at <= pg_catalog.clock_timestamp()
    or (authority #>> '{effects,0,requestDeadlineAt}')::timestamptz
      <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '42501',
      message = 'Record File restore settlement authority is unavailable';
  end if;

  for effect_row in
    select effect.*
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id
      and effect.effect_kind = 'restored'
    order by effect.effect_sequence
    for update
  loop
    if request_deadline_at <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '57014',
        message = 'Record File settlement request deadline expired';
    end if;
    select item.value into strict settlement
    from pg_catalog.jsonb_array_elements(p_settlements) as item(value)
    where (item.value ->> 'effectSequence')::integer = effect_row.effect_sequence;
    if effect_row.file_cascade_settled
      or effect_row.file_cascade_proof_digest is null
      or effect_row.file_cascade_proof_digest !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '55000',
        message = 'Record File restore proof is unavailable';
    end if;
    update vortex_record.record_lifecycle_command_effects as effect
    set file_cascade_proof_digest = settlement ->> 'proofDigest',
      file_cascade_settled = true
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id
      and effect.effect_sequence = effect_row.effect_sequence
      and effect.effect_kind = 'restored'
      and effect.file_cascade_settled = false
      and effect.file_cascade_proof_digest = effect_row.file_cascade_proof_digest;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001',
        message = 'Record File restore settlement is stale';
    end if;
    if effect_row.restore_request_deadline_at is null
      or effect_row.restore_request_deadline_at <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '57014',
        message = 'Record File restore settlement deadline expired';
    end if;
  end loop;
  if exists (
    select 1
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id
      and effect.effect_kind = 'restored'
      and (not effect.file_cascade_settled
        or effect.file_cascade_proof_digest !~ '^[0-9a-f]{64}$')
  ) then
    raise exception using errcode = '55000',
      message = 'Record File restore settlement is incomplete';
  end if;
  if request_deadline_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '57014',
      message = 'Record File restore settlement request deadline expired';
  end if;
end
$function$;

alter function vortex_record.settle_record_owned_file_restore_cascade_internal(uuid,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.settle_record_owned_file_restore_cascade_internal(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.settle_record_owned_file_restore_cascade_internal(uuid,jsonb)
  to vortex_file_owner, vortex_record_owner;
comment on function vortex_record.settle_record_owned_file_restore_cascade_internal(uuid,jsonb) is
  'Privately settles the exact pending restored lifecycle effect after the File owner completes the same-transaction CAS, storing only a SHA-256 proof and settled marker.';

reset role;

set local role vortex_file_owner;
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

reset role;

set local role vortex_record_adapter;
create or replace function vortex_record.prepare_protected_record_restore(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  request_started_at timestamptz := pg_catalog.statement_timestamp();
  request_timeout interval;
  request_lock_timeout interval;
  request_deadline_at timestamptz;
  context_value jsonb;
  correlation_value jsonb;
  fingerprint_value text;
  receipt_claim jsonb;
  capability_value jsonb;
  inventory_value jsonb;
  restore_result jsonb;
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  proof_value jsonb;
  proof_digest text;
  original_deleted_at timestamptz;
  expected_policy_revision bigint;
  recovery_window_days integer;
  changed_rows integer;
  refusal_reason text;
begin
  if p_command_id is null or p_command_id = nil_uuid
    or p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_activity_id is null or p_activity_id = nil_uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;
  begin
    request_timeout := pg_catalog.current_setting('statement_timeout')::interval;
    request_lock_timeout := pg_catalog.current_setting('lock_timeout')::interval;
  exception when invalid_text_representation then
    request_timeout := interval '0';
    request_lock_timeout := interval '0';
  end;
  request_deadline_at := request_started_at + request_timeout;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record restore requires an Application context';
  end if;
  correlation_value := context_value -> 'correlationId';
  if request_timeout <= interval '0' or request_timeout > interval '30 seconds'
    or request_lock_timeout <= interval '0'
    or request_lock_timeout > interval '5 seconds'
    or request_deadline_at <= pg_catalog.clock_timestamp()
    or pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_value
    );
  end if;
  fingerprint_value := vortex_record.record_lifecycle_command_fingerprint_internal(
    p_command_id, 'restore', p_record_type_id, p_record_id,
    p_expected_concurrency_number
  );
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_lifecycle', p_command_id, 'restore', fingerprint_value,
    p_record_type_id, p_record_id, '{}'::jsonb,
    pg_catalog.jsonb_build_object(
      'expectedConcurrencyNumber', p_expected_concurrency_number,
      'recoveryPolicyRevision', null,
      'activityId', p_activity_id,
      'occurrenceId', null
    ), false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_value
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', correlation_value
      );
    end if;
    capability_value := vortex_record.read_record_capabilities(
      p_record_type_id, p_record_id
    );
    if capability_value is null
      or not coalesce((capability_value -> 'actions') ? 'restore', false) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', correlation_value
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'restored',
      'recordId', receipt_claim -> 'recordId',
      'concurrencyNumber', receipt_claim -> 'concurrencyNumber',
      'correlationId', correlation_value,
      'replayed', true
    );
  end if;

  if request_deadline_at <= pg_catalog.clock_timestamp() then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_value
    );
  end if;
  inventory_value := vortex_record.lock_record_restore_file_inventory_internal(
    p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if inventory_value ->> 'outcome' is distinct from 'locked'
    or pg_catalog.jsonb_typeof(inventory_value -> 'attachmentFields') is distinct from 'array'
    or pg_catalog.jsonb_typeof(inventory_value -> 'originalDeletedAt') is distinct from 'string'
    or pg_catalog.jsonb_typeof(inventory_value -> 'recoveryPolicyRevision') is distinct from 'number'
    or pg_catalog.jsonb_typeof(inventory_value -> 'recoveryWindowDays') is distinct from 'number' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_value
    );
  end if;
  original_deleted_at := (inventory_value ->> 'originalDeletedAt')::timestamptz;
  expected_policy_revision := (inventory_value ->> 'recoveryPolicyRevision')::bigint;
  recovery_window_days := (inventory_value ->> 'recoveryWindowDays')::integer;
  if recovery_window_days not between 1 and 104249991 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_value
    );
  end if;
  refusal_reason := case
    when original_deleted_at is null then 'malformed_input'
    when pg_catalog.clock_timestamp() >= original_deleted_at
      + pg_catalog.make_interval(days => recovery_window_days)
      then 'recovery_window_expired'
    else null end;
  if refusal_reason is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'recovery_ineligible',
      'recoveryReason', refusal_reason,
      'governingPolicyRevision', expected_policy_revision,
      'correlationId', correlation_value
    );
  end if;

  if request_deadline_at <= pg_catalog.clock_timestamp() then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_value
    );
  end if;
  perform pg_catalog.set_config(
    'vortex_record.lifecycle_command_id', p_command_id::text, true
  );
  restore_result := vortex_record.restore_record_internal(
    p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  perform pg_catalog.set_config('vortex_record.lifecycle_command_id', '', true);
  if restore_result ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', correlation_value
    ) || case when pg_catalog.jsonb_typeof(restore_result -> 'concurrencyNumber') = 'number'
      then pg_catalog.jsonb_build_object(
        'concurrencyNumber', restore_result -> 'concurrencyNumber'
      ) else '{}'::jsonb end;
  end if;
  if restore_result ->> 'outcome' is distinct from 'completed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', coalesce(restore_result ->> 'reasonCode', 'record_unavailable'),
      'correlationId', correlation_value
    );
  end if;

  select effect.* into strict effect_row
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = (context_value ->> 'organizationId')::uuid
    and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and effect.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and effect.command_id = p_command_id
    and effect.effect_kind = 'restored'
    and effect.record_type_id = p_record_type_id
    and effect.record_id = p_record_id
    and effect.pre_concurrency_number = p_expected_concurrency_number
  for update;
  if (
    select pg_catalog.count(*)
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = effect_row.organization_id
      and effect.application_root_id = effect_row.application_root_id
      and effect.actor_organization_account_id = effect_row.actor_organization_account_id
      and effect.command_id = effect_row.command_id
  ) <> 1 then
    raise exception using errcode = '55000',
      message = 'Protected record restore effect is incomplete';
  end if;
  proof_value := pg_catalog.jsonb_build_object(
    'version', 1,
    'commandId', effect_row.command_id,
    'organizationId', effect_row.organization_id,
    'applicationRootId', effect_row.application_root_id,
    'actorOrganizationAccountId', effect_row.actor_organization_account_id,
    'storageContractId', effect_row.storage_contract_id,
    'moduleRootId', (inventory_value ->> 'moduleRootId')::uuid,
    'moduleReleaseRevision', (inventory_value ->> 'moduleReleaseRevision')::bigint,
    'recordTypeId', effect_row.record_type_id,
    'recordId', effect_row.record_id,
    'preConcurrencyNumber', effect_row.pre_concurrency_number,
    'postConcurrencyNumber', effect_row.post_concurrency_number,
    'originalDeletedAt', vortex_context.format_timestamp_utc(original_deleted_at),
    'recoveryPolicyRevision', expected_policy_revision,
    'recoveryWindowDays', recovery_window_days,
    'requestDeadlineAt', vortex_context.format_timestamp_utc(request_deadline_at),
    'attachmentFields', inventory_value -> 'attachmentFields'
  );
  proof_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(proof_value::text, 'UTF8')),
    'hex'
  );
  update vortex_record.record_lifecycle_command_effects as effect
  set file_cascade_proof_digest = proof_digest,
    file_cascade_settled = false,
    restore_original_deleted_at = original_deleted_at,
    restore_policy_revision = expected_policy_revision,
    restore_recovery_window_days = recovery_window_days,
    restore_request_deadline_at = request_deadline_at
  where effect.organization_id = effect_row.organization_id
    and effect.application_root_id = effect_row.application_root_id
    and effect.actor_organization_account_id = effect_row.actor_organization_account_id
    and effect.command_id = effect_row.command_id
    and effect.effect_sequence = effect_row.effect_sequence
    and effect.effect_kind = 'restored'
    and effect.file_cascade_settled = false
    and effect.file_cascade_proof_digest is null
    and effect.restore_original_deleted_at is null
    and effect.restore_policy_revision is null
    and effect.restore_recovery_window_days is null
    and effect.restore_request_deadline_at is null;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 or request_deadline_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '40001',
      message = 'Protected record restore proof became stale';
  end if;
  return vortex_record.prepare_record_lifecycle_totals_internal(
    'restore', p_record_type_id, p_record_id, p_command_id, null
  );
end
$function$;

alter function vortex_record.prepare_protected_record_restore(uuid,uuid,uuid,bigint,uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_protected_record_restore(
  uuid, uuid, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.prepare_protected_record_restore(
  uuid, uuid, uuid, bigint, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_protected_record_restore(
  uuid, uuid, uuid, bigint, uuid
) is
  'Protected restore preflight: current authorized replay, original bounded deadline, complete restore File inventory locks, restore primitive, private original-policy proof and dependency-total closure.';

create or replace function vortex_record.apply_lifecycle_record_changes_internal(
  p_operation text,
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.command_receipts%rowtype;
  preparation jsonb;
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  event_kind text;
  event_result jsonb;
  subject_ids uuid[];
  revisions jsonb;
  restored_revision bigint;
  target_kind text;
  target_id uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  command_fingerprint_value text;
  receipt_claim jsonb;
  restore_authority jsonb;
  installation jsonb;
  loaded jsonb;
  decision jsonb;
  record_fact jsonb;
  record_type_fact jsonb;
  ownership_mode text;
  previous_owner_id uuid;
  updated_record_id uuid;
  updated_concurrency_number bigint;
  changed_rows integer;
  notice_sequence bigint;
  context_after jsonb;
  shared_consumers_initial jsonb;
  shared_consumers_final jsonb;
  target_item jsonb;
  module_item jsonb;
  target_application_root_id uuid;
  previous_target_application_root_id uuid;
  target_module_root_id uuid;
  previous_target_module_root_id uuid;
  target_module_binding_count integer;
  origin_application_is_consumer boolean;
  request_deadline_at timestamptz;
  request_timeout interval;
  request_lock_timeout interval;
  effect_count integer;
begin
  -- The terminal delete, restore and ownership-transfer writes now run inside the
  -- one protected apply_record_changes operation. Each branch is the exact body
  -- its own writer used to carry, so its receipt, fingerprint, Activity and
  -- Events are unchanged; only the entry point moved. The delete and restore
  -- branches complete the record_lifecycle receipt the protected preflight
  -- already claimed and, for a delete, already soft-deleted behind; the transfer
  -- branch owns and claims its own record_save receipt as before.
  if p_operation = 'delete' then
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
        message = 'Protected record delete request deadline expired';
    end if;
    context_value := vortex_access.validated_human_request_context();
    receipt := vortex_record.lock_command_receipt_internal('record_lifecycle', p_command_id);
    if receipt.command_id is null
      or receipt.state is distinct from 'pending'
      or receipt.operation is distinct from 'delete'
      or receipt.record_type_id is distinct from p_record_type_id
      or receipt.record_id is distinct from p_record_id
      or receipt.expected_concurrency_number is distinct from p_expected_concurrency_number then
      raise exception using errcode = '55000',
        message = 'Protected record delete is not prepared';
    end if;

    select pg_catalog.count(*) into effect_count
    from (
      select 1
      from vortex_record.record_lifecycle_command_effects as effect
      where effect.organization_id = receipt.organization_id
        and effect.application_root_id = receipt.application_root_id
        and effect.actor_organization_account_id = receipt.actor_organization_account_id
        and effect.command_id = receipt.command_id
      limit 101
    ) as bounded_effects;
    if effect_count < 1 or effect_count > 100 then
      raise exception using errcode = '57014',
        message = 'Protected record delete effect limit exceeded';
    end if;

    if not exists (
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
    ) or exists (
      select 1
      from vortex_record.record_lifecycle_command_effects as effect
      where effect.organization_id = receipt.organization_id
        and effect.application_root_id = receipt.application_root_id
        and effect.actor_organization_account_id = receipt.actor_organization_account_id
        and effect.command_id = receipt.command_id
        and effect.effect_kind = 'soft_deleted'
        and (not effect.file_cascade_settled
          or effect.file_cascade_proof_digest is null
          or effect.file_cascade_proof_digest !~ '^[0-9a-f]{64}$')
    ) then
      raise exception using errcode = '55000',
        message = 'Protected record delete File cascade is not settled';
    end if;

    -- Closure identity and revisions are re-derived under the held locks rather
    -- than taken from the caller.
    preparation := vortex_record.prepare_record_lifecycle_totals_internal(
      'delete', p_record_type_id, p_record_id, p_command_id, null
    );
    if preparation ->> 'outcome' is distinct from 'prepared' then
      raise exception using errcode = '40001',
        message = 'Protected record delete closure changed';
    end if;
    perform vortex_record.apply_record_lifecycle_generated_values_internal(
      preparation, false, p_mutations
    );

    for effect_row in
      select effect.*
      from vortex_record.record_lifecycle_command_effects as effect
      where effect.organization_id = receipt.organization_id
        and effect.application_root_id = receipt.application_root_id
        and effect.actor_organization_account_id = receipt.actor_organization_account_id
        and effect.command_id = receipt.command_id
      order by effect.effect_sequence
    loop
      if effect_row.effect_kind = 'soft_deleted' then
        event_kind := 'deleted';
      else
        event_kind := 'unlinked';
      end if;
      event_result := vortex_event.append_record_occurrences(
        effect_row.storage_contract_id, effect_row.record_id,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', case
            when event_kind = 'deleted' and effect_row.record_id = p_record_id
              and effect_row.record_type_id = p_record_type_id
              then receipt.occurrence_id
            else pg_catalog.gen_random_uuid() end,
          'descriptor', pg_catalog.jsonb_build_object(
            'kind', 'standard', 'eventKind', event_kind,
            'recordTypeId', effect_row.record_type_id
          ),
          'payload', pg_catalog.jsonb_build_object('kind', event_kind)
        ))
      );
      if pg_catalog.jsonb_array_length(event_result) <> 1 then
        raise exception using errcode = '55000',
          message = 'Protected record delete Event append failed';
      end if;
    end loop;

    select pg_catalog.array_agg(distinct effect.record_id order by effect.record_id)
      into subject_ids
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id;
    if subject_ids is null or not (p_record_id = any (subject_ids)) then
      raise exception using errcode = '55000',
        message = 'Protected record delete effects are unavailable';
    end if;
    perform vortex_record.append_record_lifecycle_activity_internal(
      receipt.activity_id, 'delete', subject_ids
    );

    if request_deadline_at <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '57014',
        message = 'Protected record delete request deadline expired';
    end if;

    perform vortex_record.complete_command_receipt_internal(
      'record_lifecycle', p_command_id, null, p_expected_concurrency_number + 1,
      'Protected record delete receipt is stale'
    );

    return pg_catalog.jsonb_build_object(
      'outcome', 'deleted',
      'recordId', p_record_id,
      'concurrencyNumber', p_expected_concurrency_number + 1,
      'correlationId', context_value -> 'correlationId',
      'replayed', false
    );
  elsif p_operation = 'restore' then
    context_value := vortex_access.validated_human_request_context();
    receipt := vortex_record.lock_command_receipt_internal('record_lifecycle', p_command_id);
    if receipt.command_id is null
      or receipt.state is distinct from 'pending'
      or receipt.operation is distinct from 'restore'
      or receipt.record_type_id is distinct from p_record_type_id
      or receipt.record_id is distinct from p_record_id
      or receipt.expected_concurrency_number is distinct from p_expected_concurrency_number then
      raise exception using errcode = '55000',
        message = 'Protected record restore is not prepared';
    end if;

    select effect.* into strict effect_row
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id
      and effect.effect_kind = 'restored'
      and effect.record_type_id = p_record_type_id
      and effect.record_id = p_record_id
      and effect.pre_concurrency_number = p_expected_concurrency_number
    for update;
    if (
      select pg_catalog.count(*)
      from vortex_record.record_lifecycle_command_effects as effect
      where effect.organization_id = receipt.organization_id
        and effect.application_root_id = receipt.application_root_id
        and effect.actor_organization_account_id = receipt.actor_organization_account_id
        and effect.command_id = receipt.command_id
    ) <> 1
      or effect_row.restore_original_deleted_at is null
      or effect_row.restore_policy_revision is null
      or effect_row.restore_recovery_window_days is null
      or effect_row.restore_request_deadline_at is null
      or effect_row.restore_request_deadline_at <= pg_catalog.clock_timestamp()
      or not effect_row.file_cascade_settled
      or effect_row.file_cascade_proof_digest is null
      or effect_row.file_cascade_proof_digest !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '55000',
        message = 'Protected record restore proof is unavailable';
    end if;
    restore_authority := vortex_record.read_record_owned_file_restore_authority_internal(
      p_command_id
    );
    if restore_authority ->> 'outcome' is distinct from 'prepared'
      or (restore_authority ->> 'requestDeadlineAt')::timestamptz
        is distinct from effect_row.restore_request_deadline_at
      or effect_row.restore_request_deadline_at <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '42501',
        message = 'Protected record restore authority is unavailable';
    end if;

    preparation := vortex_record.prepare_record_lifecycle_totals_internal(
      'restore', p_record_type_id, p_record_id, p_command_id, null
    );
    if preparation ->> 'outcome' is distinct from 'prepared'
      or (
        select (item.value ->> 'concurrencyNumber')::bigint
        from pg_catalog.jsonb_array_elements(preparation -> 'records') as item(value)
        where item.value ->> 'recordKey' = 'root'
      ) is distinct from p_expected_concurrency_number + 1 then
      raise exception using errcode = '40001',
        message = 'Protected record restore closure changed';
    end if;
    revisions := vortex_record.apply_record_lifecycle_generated_values_internal(
      preparation, true, p_mutations
    );
    select (item.value ->> 'concurrencyNumber')::bigint into strict restored_revision
    from pg_catalog.jsonb_array_elements(revisions) as item(value)
    where item.value ->> 'recordKey' = 'root';

    perform vortex_record.append_record_lifecycle_activity_internal(
      receipt.activity_id, 'restore', array[p_record_id]::uuid[]
    );

    if effect_row.restore_original_deleted_at
        + pg_catalog.make_interval(days => effect_row.restore_recovery_window_days)
        <= pg_catalog.clock_timestamp()
      or effect_row.restore_request_deadline_at <= pg_catalog.clock_timestamp()
      or request_deadline_at <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '57014',
        message = 'Protected record restore deadline expired before receipt completion';
    end if;

    perform vortex_record.complete_command_receipt_internal(
      'record_lifecycle', p_command_id, null, restored_revision,
      'Protected record restore receipt is stale'
    );

    return pg_catalog.jsonb_build_object(
      'outcome', 'restored',
      'recordId', p_record_id,
      'concurrencyNumber', restored_revision,
      'correlationId', context_value -> 'correlationId',
      'replayed', false
    );
  elsif p_operation = 'transfer_ownership' then
    -- The transfer's target is the command's ordered mutation list; it carries
    -- one transfer_ownership mutation with the exact installed target kind and
    -- identifier, never an authority.
    if pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_mutations) <> 1
      or pg_catalog.jsonb_typeof(p_mutations -> 0) is distinct from 'object'
      or not ((p_mutations -> 0) ?& array['kind', 'targetKind', 'targetId'])
      or (p_mutations -> 0) - array['kind', 'targetKind', 'targetId']::text[] <> '{}'::jsonb
      or (p_mutations -> 0 ->> 'kind') is distinct from 'transfer_ownership'
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'targetKind') is distinct from 'string'
      or (p_mutations -> 0 ->> 'targetKind') not in ('organization_account', 'group')
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'targetId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_mutations -> 0 ->> 'targetId', 'uuid') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    target_kind := p_mutations -> 0 ->> 'targetKind';
    target_id := (p_mutations -> 0 ->> 'targetId')::uuid;
    if p_command_id is null or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_record_type_id is null or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_record_id is null or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_concurrency_number is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or target_kind is null
      or target_kind not in ('organization_account', 'group')
      or target_id is null or target_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;

    context_value := vortex_access.lock_human_request_access_version_internal();
    if not context_value ? 'applicationRootId' then
      raise exception using errcode = '42501', message = 'Record ownership transfer requires an Application context';
    end if;
    organization_id_value := (context_value ->> 'organizationId')::uuid;
    application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
    actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
    command_fingerprint_value := vortex_record.ownership_transfer_command_fingerprint_internal(
      p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
      target_kind, target_id, 'public', null
    );

    receipt_claim := vortex_record.claim_command_receipt_internal(
      'record_save', p_command_id, 'transfer_ownership', command_fingerprint_value,
      p_record_type_id, null, '{}'::jsonb, '{}'::jsonb, false
    );
    if receipt_claim ->> 'status' is distinct from 'claimed' then
      if receipt_claim ->> 'status' = 'identity_conflict' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      if receipt_claim ->> 'status' is distinct from 'completed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
        );
      end if;
      -- A replay reprojects from current access and intentionally never returns
      -- owner metadata (including the prior target).
      loaded := vortex_record.read_record(
        p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      );
      if loaded ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      return pg_catalog.jsonb_build_object(
        'outcome', 'transferred', 'recordId', loaded -> 'recordId',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', context_value -> 'correlationId', 'replayed', true
      );
    end if;
    -- The closed transfer authority is its own exact record permission decision;
    -- it is evaluated under the record lock, while owner columns remain
    -- unavailable to the ordinary update writer.
    -- Public transfer is active-installation-only.  It deliberately never calls
    -- the retained/detached reader, so a detached record cannot leak its current
    -- revision through the ordinary conflict response.
    begin
      installation := vortex_module.read_current_active_installation();
    exception
      when no_data_found then
        perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', context_value -> 'correlationId'
        );
    end;
    loaded := vortex_record.load_record_access_facts_for_transfer_installation_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number, installation
    );
    if loaded ->> 'outcome' = 'conflict' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded' or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
    select item.value into record_type_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
    where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
    if record_fact is null or record_type_fact is null
      or record_fact ->> 'lifecycleState' <> 'active' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    ownership_mode := record_type_fact ->> 'ownershipMode';
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' = 'refused' then
      perform vortex_record.append_ownership_transfer_activity_internal(
        p_activity_id, organization_id_value, 'refused'
      );
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    elsif decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501', message = 'Record ownership transfer authority is unavailable';
    end if;
    if ownership_mode = 'organization_account' then
      previous_owner_id := (record_fact ->> 'ownerOrganizationAccountId')::uuid;
    elsif ownership_mode = 'group' then
      previous_owner_id := (record_fact ->> 'ownerGroupId')::uuid;
    else
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'ownership_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if (ownership_mode = 'organization_account' and target_kind <> 'organization_account')
      or (ownership_mode = 'group' and target_kind <> 'group')
      or previous_owner_id is null or previous_owner_id = target_id
      or not vortex_access.lock_active_record_ownership_target_internal(target_kind, target_id) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'owner_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    execute pg_catalog.format(
      'update record_data.%I as stored set owner_organisation_account_id = $3,
         owner_group_id = $4, concurrency_number = concurrency_number + 1,
         updated_at = pg_catalog.statement_timestamp(), updated_by = $5
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.concurrency_number = $6 returning stored.record_id, stored.concurrency_number',
      loaded ->> 'table'
    ) into updated_record_id, updated_concurrency_number using organization_id_value, p_record_id,
      case when target_kind = 'organization_account' then target_id else null end,
      case when target_kind = 'group' then target_id else null end,
      actor_id_value, p_expected_concurrency_number;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001', message = 'Record ownership transfer revision changed';
    end if;
    if updated_record_id is distinct from p_record_id
      or updated_concurrency_number is null
      or updated_concurrency_number not between 1 and 9007199254740991 then
      raise exception using errcode = '55000', message = 'Record ownership transfer saved identity is unavailable';
    end if;
    perform vortex_record.append_ownership_transfer_activity_internal(p_activity_id, p_record_id, 'completed');
    event_result := vortex_event.append_record_occurrences(
      (record_type_fact ->> 'storageContractId')::uuid,
      p_record_id, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', p_occurrence_id,
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', 'reassigned', 'recordTypeId', p_record_type_id
        ), 'payload', pg_catalog.jsonb_build_object('kind', 'reassigned')
      ))
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
      raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
    end if;
    perform vortex_record.complete_command_receipt_internal(
      'record_save', p_command_id, p_record_id, updated_concurrency_number,
      'Record ownership transfer receipt is stale'
    );
    if record_fact #>> '{recordScope,storageScope}' = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::regclass);
        perform vortex_invalidation.publish_change_notice(
          organization_id_value, application_root_id_value, p_record_type_id,
          updated_record_id, updated_concurrency_number, 'changed',
          notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
        );
      exception when others then
        -- Invalidation is advisory after the protected transfer is complete.
        null;
      end;
    elsif record_fact #>> '{recordScope,storageScope}' = 'organization_shared' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::regclass);
        if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
          raise exception using errcode = '22003',
            message = 'Shared ownership transfer notice sequence is unavailable';
        end if;

        if record_fact -> 'recordScope' ->> 'moduleRootId'
            is distinct from record_type_fact ->> 'moduleRootId'
          or record_fact -> 'recordScope' ->> 'storageContractId'
            is distinct from record_type_fact ->> 'storageContractId'
          or not vortex_context.is_non_nil_uuid(record_fact -> 'recordScope' ->> 'moduleRootId')
          or not vortex_context.is_non_nil_uuid(record_type_fact ->> 'storageContractId') then
          raise exception using errcode = '55000',
            message = 'Shared ownership transfer record lineage is unavailable';
        end if;

        shared_consumers_initial := vortex_module.read_active_shared_record_consumers_internal(
          (record_fact -> 'recordScope' ->> 'moduleRootId')::uuid,
          p_record_type_id,
          (record_type_fact ->> 'storageContractId')::uuid
        );
        if pg_catalog.jsonb_typeof(shared_consumers_initial) is distinct from 'object'
          or not (shared_consumers_initial ?& array['organizationId', 'accessVersion', 'targets'])
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(shared_consumers_initial)) <> 3
          or shared_consumers_initial ->> 'organizationId' is distinct from organization_id_value::text
          or not pg_catalog.pg_input_is_valid(shared_consumers_initial ->> 'accessVersion', 'bigint')
          or (shared_consumers_initial ->> 'accessVersion')::bigint
            is distinct from (context_value ->> 'accessVersion')::bigint
          or pg_catalog.jsonb_typeof(shared_consumers_initial -> 'targets') is distinct from 'array'
          or pg_catalog.jsonb_array_length(shared_consumers_initial -> 'targets') = 0 then
          raise exception using errcode = '55000',
            message = 'Shared ownership transfer consumer selection is malformed';
        end if;

        previous_target_application_root_id := null;
        origin_application_is_consumer := false;
        for target_item in
          select item.value
          from pg_catalog.jsonb_array_elements(shared_consumers_initial -> 'targets') as item(value)
          order by (item.value ->> 'applicationRootId')::uuid
        loop
          if pg_catalog.jsonb_typeof(target_item) is distinct from 'object'
            or not (target_item ?& array[
              'applicationRootId', 'applicationReleaseRevision', 'moduleRootId',
              'moduleReleaseRevision', 'bindingRevision', 'recordTypeId',
              'storageContractId', 'registrationRevision', 'definitionKey',
              'releaseVersion', 'validationContractVersion', 'contentFingerprint',
              'resolutionFingerprint', 'catalogueFingerprint', 'moduleBindings'
            ])
            or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(target_item)) <> 15
            or not vortex_context.is_non_nil_uuid(target_item ->> 'applicationRootId')
            or not vortex_context.is_non_nil_uuid(target_item ->> 'moduleRootId')
            or not vortex_context.is_non_nil_uuid(target_item ->> 'storageContractId')
            or not pg_catalog.pg_input_is_valid(target_item ->> 'applicationReleaseRevision', 'bigint')
            or (target_item ->> 'applicationReleaseRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'moduleRootId' is distinct from record_fact -> 'recordScope' ->> 'moduleRootId'
            or not pg_catalog.pg_input_is_valid(target_item ->> 'moduleReleaseRevision', 'bigint')
            or (target_item ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
            or not pg_catalog.pg_input_is_valid(target_item ->> 'bindingRevision', 'bigint')
            or (target_item ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'recordTypeId' is distinct from p_record_type_id::text
            or target_item ->> 'storageContractId'
              is distinct from record_type_fact ->> 'storageContractId'
            or not pg_catalog.pg_input_is_valid(target_item ->> 'registrationRevision', 'bigint')
            or (target_item ->> 'registrationRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'definitionKey' is null or target_item ->> 'definitionKey' = ''
            or target_item ->> 'releaseVersion' is null or target_item ->> 'releaseVersion' = ''
            or target_item ->> 'validationContractVersion' is null
            or target_item ->> 'validationContractVersion' = ''
            or target_item ->> 'contentFingerprint' is null
            or target_item ->> 'contentFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or target_item ->> 'resolutionFingerprint' is null
            or target_item ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or target_item ->> 'catalogueFingerprint' is null
            or target_item ->> 'catalogueFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or pg_catalog.jsonb_typeof(target_item -> 'moduleBindings') is distinct from 'array'
            or pg_catalog.jsonb_array_length(target_item -> 'moduleBindings') = 0 then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer consumer evidence is malformed';
          end if;

          target_application_root_id := (target_item ->> 'applicationRootId')::uuid;
          if previous_target_application_root_id is not null
            and target_application_root_id <= previous_target_application_root_id then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer consumer set is not unique and ordered';
          end if;
          previous_target_application_root_id := target_application_root_id;
          if target_application_root_id = application_root_id_value then
            origin_application_is_consumer := true;
          end if;

          previous_target_module_root_id := null;
          target_module_binding_count := 0;
          for module_item in
            select binding.value
            from pg_catalog.jsonb_array_elements(target_item -> 'moduleBindings') as binding(value)
            order by (binding.value ->> 'moduleRootId')::uuid
          loop
            if pg_catalog.jsonb_typeof(module_item) is distinct from 'object'
              or not (module_item ?& array[
                'moduleRootId', 'bindingRevision', 'applicationReleaseRevision',
                'moduleReleaseRevision', 'state', 'contentFingerprint',
                'resolutionFingerprint', 'generatorContractVersion', 'storageContractIds'
              ])
              or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(module_item)) <> 9
              or not vortex_context.is_non_nil_uuid(module_item ->> 'moduleRootId')
              or not pg_catalog.pg_input_is_valid(module_item ->> 'bindingRevision', 'bigint')
              or (module_item ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
              or not pg_catalog.pg_input_is_valid(module_item ->> 'applicationReleaseRevision', 'bigint')
              or (module_item ->> 'applicationReleaseRevision')::bigint
                is distinct from (target_item ->> 'applicationReleaseRevision')::bigint
              or not pg_catalog.pg_input_is_valid(module_item ->> 'moduleReleaseRevision', 'bigint')
              or (module_item ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
              or module_item ->> 'state' is distinct from 'active'
              or module_item ->> 'contentFingerprint' is null
              or module_item ->> 'contentFingerprint' !~ '^sha256:[a-f0-9]{64}$'
              or module_item ->> 'resolutionFingerprint' is null
              or module_item ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
              or module_item ->> 'generatorContractVersion' is distinct from '1.0.0'
              or pg_catalog.jsonb_typeof(module_item -> 'storageContractIds') is distinct from 'array'
              or pg_catalog.jsonb_array_length(module_item -> 'storageContractIds') = 0
              or exists (
                select 1
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                where pg_catalog.jsonb_typeof(contract.value) is distinct from 'string'
                  or not vortex_context.is_non_nil_uuid(contract.value #>> '{}')
              )
              or exists (
                select contract.value
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                group by contract.value having pg_catalog.count(*) <> 1
              )
              or module_item -> 'storageContractIds' is distinct from (
                select pg_catalog.jsonb_agg(contract.value order by (contract.value #>> '{}')::uuid)
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
              ) then
              raise exception using errcode = '55000',
                message = 'Shared ownership transfer Module binding evidence is malformed';
            end if;

            target_module_root_id := (module_item ->> 'moduleRootId')::uuid;
            if previous_target_module_root_id is not null
              and target_module_root_id <= previous_target_module_root_id then
              raise exception using errcode = '55000',
                message = 'Shared ownership transfer Module bindings are not unique and ordered';
            end if;
            previous_target_module_root_id := target_module_root_id;
            if target_module_root_id = (target_item ->> 'moduleRootId')::uuid then
              target_module_binding_count := target_module_binding_count + 1;
              if (module_item ->> 'moduleReleaseRevision')::bigint
                  is distinct from (target_item ->> 'moduleReleaseRevision')::bigint
                or (module_item ->> 'bindingRevision')::bigint
                  is distinct from (target_item ->> 'bindingRevision')::bigint
                or not exists (
                  select 1
                  from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                  where contract.value #>> '{}' = target_item ->> 'storageContractId'
                ) then
                raise exception using errcode = '55000',
                  message = 'Shared ownership transfer target binding does not match its complete Module lineage';
              end if;
            end if;
          end loop;
          if target_module_binding_count <> 1 then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer target Module binding is ambiguous';
          end if;
        end loop;

        if not origin_application_is_consumer then
          raise exception using errcode = '42501',
            message = 'Origin Application is not a proved shared record consumer';
        end if;

        shared_consumers_final := vortex_module.read_active_shared_record_consumers_internal(
          (record_fact -> 'recordScope' ->> 'moduleRootId')::uuid,
          p_record_type_id,
          (record_type_fact ->> 'storageContractId')::uuid
        );
        if shared_consumers_final is distinct from shared_consumers_initial then
          raise exception using errcode = '40001',
            message = 'Shared ownership transfer consumer snapshot changed before publication';
        end if;
        context_after := vortex_access.validated_human_request_context();
        if context_after is distinct from context_value then
          raise exception using errcode = '40001',
            message = 'Human ownership transfer context changed before publication';
        end if;

        for target_item in
          select item.value
          from pg_catalog.jsonb_array_elements(shared_consumers_initial -> 'targets') as item(value)
          order by (item.value ->> 'applicationRootId')::uuid
        loop
          perform vortex_invalidation.publish_change_notice(
            organization_id_value, (target_item ->> 'applicationRootId')::uuid,
            p_record_type_id, updated_record_id, updated_concurrency_number, 'changed',
            notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
          );
        end loop;
      exception when others then
        -- The completed transfer is structural. All App-scoped notices are one
        -- advisory subtransaction, so a failure rolls back every send together.
        null;
      end;
    else
      raise exception using errcode = '55000',
        message = 'Ownership transfer storage scope is unavailable';
    end if;
    -- This is deliberately an undisclosed result: an authorised transfer may
    -- remove the operator's read path.  A post-write projection would turn that
    -- valid committed mutation into a rollback.  Exact replay still applies
    -- current disclosure separately above.
    return pg_catalog.jsonb_build_object(
      'outcome', 'transferred', 'recordId', updated_record_id,
      'concurrencyNumber', updated_concurrency_number,
      'correlationId', context_value -> 'correlationId', 'replayed', false
    );
  end if;

  return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
end
$function$;

alter function vortex_record.apply_lifecycle_record_changes_internal(text,uuid,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_record_adapter;
comment on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'The terminal delete, restore and ownership-transfer record-change writes, applied inside the one protected operation: each keeps its own receipt kind, fingerprint, Activity and Event, and completes the preflight its protected preflight (delete and restore) or itself (ownership transfer) claimed.';

reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter, vortex_record_inventory;
reset role;

commit;
