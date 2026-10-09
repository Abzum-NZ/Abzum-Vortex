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
