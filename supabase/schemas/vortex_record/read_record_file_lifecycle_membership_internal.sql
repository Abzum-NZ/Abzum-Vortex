create or replace function vortex_record.read_record_file_lifecycle_membership_internal(
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
  field_item jsonb;
  mapping_row record;
  match_row record;
  organization_id_value uuid;
  candidate_file_ids uuid[] := array[]::uuid[];
  candidate_file_text text[] := array[]::text[];
  candidate_file_text_value text;
  matching_count integer;
  invalid_values boolean;
  base_table_token text;
  physical_table_token text;
  relation_oid oid;
  membership_values jsonb := '[]'::jsonb;
  expected boolean;
begin
  lock_result := vortex_record.lock_record_file_lifecycle_inventory_internal(
    p_command_id
  );
  if lock_result ->> 'outcome' is distinct from 'locked' then
    raise exception using errcode = '55000',
      message = 'Record File inventory could not be locked';
  end if;
  authority := vortex_record.read_record_owned_file_lifecycle_authority_internal(
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
        candidate_file_ids := pg_catalog.array_append(
          candidate_file_ids, candidate_file_text_value::uuid
        );
        candidate_file_text := pg_catalog.array_append(
          candidate_file_text, candidate_file_text_value
        );
      end loop;
    end loop;
  end loop;
  if pg_catalog.cardinality(candidate_file_ids) > (
    select pg_catalog.count(distinct item.value)
    from pg_catalog.unnest(candidate_file_text) as item(value)
  ) then
    raise exception using errcode = '23514',
      message = 'File attachment has multiple Record owners';
  end if;

  if pg_catalog.cardinality(candidate_file_ids) > 0 then
    for mapping_row in
      select mapping.storage_contract_id, mapping.module_root_id,
        mapping.record_type_id, mapping.storage_scope,
        mapping.base_table_token, mapping.table_token,
        mapping.field_id, mapping.column_token,
        mapping.introduced_by_module_root_id, mapping.database_value_type
      from pg_catalog.jsonb_to_recordset(lock_result -> 'attachmentMappings') as mapping(
        storage_contract_id uuid,
        module_root_id uuid,
        record_type_id uuid,
        storage_scope text,
        base_table_token text,
        table_token text,
        field_id uuid,
        column_token text,
        database_value_type text,
        introduced_by_module_root_id uuid
      )
      order by mapping.storage_contract_id, mapping.field_id
    loop
      base_table_token := mapping_row.base_table_token;
      physical_table_token := mapping_row.table_token;
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

      if physical_table_token = base_table_token then
        execute pg_catalog.format(
          'select exists (
             select 1 from record_data.%I as stored
             where stored.organisation_id = $1
               and stored.lifecycle_state not in (''active'', ''soft_deleted'', ''removed'')
               and pg_catalog.to_jsonb(stored.%I) is not null
               and pg_catalog.jsonb_typeof(pg_catalog.to_jsonb(stored.%I))
                 not in (''array'', ''null'')
           )',
          physical_table_token, mapping_row.column_token,
          mapping_row.column_token
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
               and stored.lifecycle_state not in (''active'', ''soft_deleted'', ''removed'')
               and pg_catalog.to_jsonb(companion.%I) is not null
               and pg_catalog.jsonb_typeof(pg_catalog.to_jsonb(companion.%I))
                 not in (''array'', ''null'')
           )',
          physical_table_token, base_table_token,
          mapping_row.column_token, mapping_row.column_token
        ) into invalid_values using organization_id_value;
      end if;
      if invalid_values then
        raise exception using errcode = '23514',
          message = 'Record File attachment value is invalid';
      end if;

      if physical_table_token = base_table_token then
        for match_row in execute pg_catalog.format(
          'select stored.record_id, stored.application_root_id, item.value as file_id
           from record_data.%I as stored
           cross join lateral pg_catalog.jsonb_array_elements_text(
             pg_catalog.to_jsonb(stored.%I)
           ) as item(value)
           where stored.organisation_id = $1
             and stored.lifecycle_state in (''active'', ''soft_deleted'')
             and item.value = any ($2::text[])',
          physical_table_token, mapping_row.column_token
        ) using organization_id_value, candidate_file_text
        loop
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
              and field.value -> 'fileIds' ? match_row.file_id
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
          'select stored.record_id, stored.application_root_id, item.value as file_id
           from record_data.%I as companion
           join record_data.%I as stored
             on stored.organisation_id = companion.organisation_id
             and stored.record_id = companion.record_id
           cross join lateral pg_catalog.jsonb_array_elements_text(
             pg_catalog.to_jsonb(companion.%I)
           ) as item(value)
           where companion.organisation_id = $1
             and stored.lifecycle_state in (''active'', ''soft_deleted'')
             and item.value = any ($2::text[])',
          physical_table_token, base_table_token, mapping_row.column_token
        ) using organization_id_value, candidate_file_text
        loop
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
              and field.value -> 'fileIds' ? match_row.file_id
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
    select distinct item.value from pg_catalog.unnest(candidate_file_text) as item(value)
  loop
    select pg_catalog.count(*) into matching_count
    from pg_catalog.jsonb_array_elements(membership_values) as membership(value)
    where membership.value ->> 'fileId' = candidate_file_text_value;
    if matching_count <> 1 then
      raise exception using errcode = '23514',
        message = 'File attachment ownership is incomplete';
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'complete',
    'effects', authority -> 'effects',
    'memberships', membership_values
  );
end
$function$;

alter function vortex_record.read_record_file_lifecycle_membership_internal(uuid)
  owner to vortex_record_inventory;

revoke all on function vortex_record.read_record_file_lifecycle_membership_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_file_owner, vortex_record_adapter, vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_record_file_lifecycle_membership_internal(uuid)
  to vortex_file_owner, vortex_record_inventory;
comment on function vortex_record.read_record_file_lifecycle_membership_internal(uuid) is
  'Organization-complete content-free attachment membership reader over forced-RLS Record and companion storage, callable only by the File owner and inventory owner.';
