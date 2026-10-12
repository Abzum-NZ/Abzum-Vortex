CREATE FUNCTION vortex_record.switch_storage_conversion_mappings_internal(p_conversion_contract_id uuid, p_owns_module boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  conversion vortex_record.storage_conversion_catalogue%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  source_mapping vortex_record.field_storage_mappings%rowtype;
  target_mapping vortex_record.field_storage_mappings%rowtype;
  mapping_lock record;
  dependent_release_revisions bigint[];
  dependent_count bigint;
  index_purpose text;
begin
  if p_owns_module is null then
    raise exception using errcode = '22023',
      message = 'Storage adoption switch command is invalid';
  end if;

  select entry.* into strict conversion
  from vortex_record.storage_conversion_catalogue as entry
  where entry.conversion_contract_id = p_conversion_contract_id;
  select catalogue.* into strict catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = conversion.source_storage_contract_id;
  if catalogue_row.state <> 'active' then
    raise exception using errcode = '55000',
      message = 'Storage adoption contract is unavailable';
  end if;

  -- Both mappings, in canonical field-id order, the same order the provisioner
  -- and the #625 staging use.
  for mapping_lock in
    select mapping.field_id
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = conversion.source_storage_contract_id
      and mapping.field_id in (conversion.source_field_id, conversion.target_field_id)
    order by mapping.field_id
    for update
  loop
    null;
  end loop;

  select mapping.* into strict source_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = conversion.source_storage_contract_id
    and mapping.field_id = conversion.source_field_id;
  select mapping.* into strict target_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = conversion.source_storage_contract_id
    and mapping.field_id = conversion.target_field_id;

  -- A completed switch is an unchanged replay, for the Module owner and for
  -- any other organisation adopting its own converted plan afterwards.
  if source_mapping.state = 'retired'
    and source_mapping.retired_at_release_revision = conversion.target_release_revision
    and target_mapping.state = 'active'
    and target_mapping.introduced_at_release_revision = conversion.target_release_revision then
    return pg_catalog.jsonb_build_object('changed', false, 'dependentCount', 0);
  end if;

  -- Making the switch changes the Module's shared storage for every
  -- installation, so only the organisation that owns the Module may do it.
  if not p_owns_module then
    raise exception using errcode = '42501',
      message = 'Storage adoption switch requires the Module owner';
  end if;

  if source_mapping.state <> 'active'
    or source_mapping.database_value_type <> conversion.source_database_value_type
    or target_mapping.state <> 'planned'
    or target_mapping.database_value_type <> conversion.target_database_value_type
    or target_mapping.physical_column_token <> 'f_' || pg_catalog.replace(
      pg_catalog.lower(conversion.target_field_id::text), '-', ''
    )
    or target_mapping.introduced_at_release_revision <> conversion.target_release_revision
    or vortex_record.field_storage_meaning(target_mapping.field_definition)
      is distinct from vortex_record.field_storage_meaning(conversion.target_field_definition)
  then
    raise exception using errcode = '55000',
      message = 'Storage adoption mappings are incompatible';
  end if;

  -- Every published release of the Module whose content still carries the
  -- source field in this storage, whatever its revision: an older release
  -- provisioned after a newer one introduced the field, and a later release
  -- that kept it, both need the source column.
  select coalesce(
    pg_catalog.array_agg(release.release_revision order by release.release_revision),
    array[]::bigint[]
  )
  into dependent_release_revisions
  from vortex_definition.releases as release
  where release.root_id = catalogue_row.module_root_id
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(
            release.compilation_output #> '{canonical,content,recordTypes}'
          ) = 'array'
            then release.compilation_output #> '{canonical,content,recordTypes}'
          else '[]'::jsonb
        end
      ) as record_item(value)
      cross join lateral pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(record_item.value -> 'fields') = 'array'
            then record_item.value -> 'fields'
          else '[]'::jsonb
        end
      ) as field_item(value)
      where pg_catalog.lower(record_item.value ->> 'storageContractId')
          = conversion.source_storage_contract_id::text
        and pg_catalog.lower(field_item.value ->> 'fieldId')
          = conversion.source_field_id::text
    );

  -- Any installation of such a release keeps the whole storage in place:
  -- retiring it would strip an installation of a required column.
  dependent_count := vortex_module.count_storage_adoption_dependents_internal(
    catalogue_row.module_root_id, conversion.source_storage_contract_id,
    dependent_release_revisions
  );
  if dependent_count > 0 then
    raise exception using errcode = '55006',
      message = 'Storage adoption is blocked while installations still use the source storage';
  end if;

  update vortex_record.field_storage_mappings as mapping
  set state = 'retired',
      retired_by_module_root_id = catalogue_row.module_root_id,
      retired_at_release_revision = conversion.target_release_revision
  where mapping.storage_contract_id = conversion.source_storage_contract_id
    and mapping.field_id = conversion.source_field_id
    and mapping.state = 'active';
  if not found then
    raise exception using errcode = '40001',
      message = 'Storage adoption source mapping changed';
  end if;

  update vortex_record.field_storage_mappings as mapping
  set state = 'active'
  where mapping.storage_contract_id = conversion.source_storage_contract_id
    and mapping.field_id = conversion.target_field_id
    and mapping.state = 'planned';
  if not found then
    raise exception using errcode = '40001',
      message = 'Storage adoption target mapping changed';
  end if;

  -- The activation gate reads the recorded index of every active field, and
  -- the provisioner only indexes a field it creates, so the switched target
  -- field's index is created here with the provisioner's branch order. A
  -- duplicate converted value refuses the uniqueness index and rolls the whole
  -- adoption back.
  index_purpose := case
    when coalesce((target_mapping.field_definition ->> 'unique')::boolean, false)
      then 'uniqueness'
    when coalesce((target_mapping.field_definition ->> 'filterable')::boolean, false)
      or coalesce((target_mapping.field_definition ->> 'sortable')::boolean, false)
      then 'performance'
    else null
  end;
  if index_purpose is not null then
    begin
      perform vortex_record.ensure_field_index_internal(
        conversion.source_storage_contract_id, conversion.target_field_id, index_purpose,
        catalogue_row.storage_scope, catalogue_row.physical_table_token,
        vortex_record.index_scope_columns(catalogue_row.storage_scope),
        target_mapping.physical_column_token
      );
    exception
      when unique_violation then
        raise exception using errcode = '55000',
          message = 'Storage adoption converted values are not unique';
    end;
  end if;

  return pg_catalog.jsonb_build_object('changed', true, 'dependentCount', dependent_count);
exception
  when no_data_found or too_many_rows then
    raise exception using errcode = '55000',
      message = 'Storage adoption evidence is unavailable';
end
$$;

COMMENT ON FUNCTION vortex_record.switch_storage_conversion_mappings_internal(p_conversion_contract_id uuid, p_owns_module boolean) IS 'Private helper: refuses while any installation of a release carrying the source field remains, then (Module owner only) switches the target mapping to active, the source mapping to retired and records the target field''s index; a completed switch is an unchanged replay; never drops a column.';

REVOKE ALL ON FUNCTION vortex_record.switch_storage_conversion_mappings_internal(p_conversion_contract_id uuid, p_owns_module boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.switch_storage_conversion_mappings_internal(p_conversion_contract_id uuid, p_owns_module boolean) TO vortex_record_adapter;
