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
