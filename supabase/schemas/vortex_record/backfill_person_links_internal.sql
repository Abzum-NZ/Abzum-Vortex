create or replace function vortex_record.backfill_person_links_internal(
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  pair record;
  source_row record;
  table_token text;
  old_column text;
  new_column text;
  account_id uuid;
  target_storage_id uuid;
  expected_link jsonb;
  has_legacy_values boolean;
  changed_count integer := 0;
  changed_rows integer;
begin
  for pair in
    select (record_type.value ->> 'storageContractId')::uuid as storage_id,
      (field.value ->> 'fieldId')::uuid as new_field_id,
      (field.value #>> '{settings,legacyPersonFieldId}')::uuid as old_field_id,
      relationship.relationship_id,
      relationship.target_record_type_ids[1] as target_type_id
    from vortex_definition.releases as release
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,recordTypes}'
    ) as record_type(value)
    cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
    join vortex_record.relationship_storage_mappings as relationship
      on relationship.source_storage_contract_id = (record_type.value ->> 'storageContractId')::uuid
      and relationship.source_field_id = (field.value ->> 'fieldId')::uuid
    where release.root_id = p_module_root_id
      and release.release_revision = p_module_release_revision
      and field.value ->> 'type' = 'link'
      and field.value #>> '{settings,legacyPersonFieldId}' is not null
      and pg_catalog.cardinality(relationship.target_record_type_ids) = 1
    order by (record_type.value ->> 'storageContractId')::uuid,
      (field.value ->> 'fieldId')::uuid
  loop
    select catalogue.physical_table_token into table_token
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = pair.storage_id
      and catalogue.physical_schema_token = 'record_data';
    if table_token is null or not exists (
      select 1 from vortex_record.field_storage_mappings as old_mapping
      join vortex_record.field_storage_mappings as new_mapping
        on new_mapping.storage_contract_id = old_mapping.storage_contract_id
      where old_mapping.storage_contract_id = pair.storage_id
        and old_mapping.field_id = pair.old_field_id
        and old_mapping.field_definition ->> 'type' = 'link_to_person'
        and new_mapping.field_id = pair.new_field_id
        and new_mapping.field_definition #>> '{settings,legacyPersonFieldId}' = pair.old_field_id::text
    ) then
      raise exception using errcode = '55000', message = 'Person link backfill storage is incompatible';
    end if;
    old_column := 'f_' || pg_catalog.replace(pair.old_field_id::text, '-', '');
    new_column := 'f_' || pg_catalog.replace(pair.new_field_id::text, '-', '');
    select catalogue.storage_contract_id into target_storage_id
    from vortex_record.storage_catalogue as catalogue
    where catalogue.record_type_id = pair.target_type_id
      and catalogue.physical_schema_token = 'system_projection';
    if target_storage_id is null then
      -- A new installation can provision the source before its projection dependency.
      -- There is nothing to backfill until a legacy value exists.
      execute pg_catalog.format(
        'select exists (select 1 from record_data.%I where %I is not null)',
        table_token, old_column
      ) into has_legacy_values;
      if has_legacy_values then
        raise exception using errcode = '55000',
          message = 'Person link backfill target storage is unavailable';
      end if;
      continue;
    end if;
    for source_row in execute pg_catalog.format(
      'select stored.organisation_id, stored.application_root_id, stored.record_id,
         stored.%I as old_value, stored.%I as new_value
       from record_data.%I as stored where stored.%I is not null
       order by stored.organisation_id, stored.record_id',
      old_column, new_column, table_token, old_column
    ) loop
      if not vortex_record.canonical_record_value_matches(
        source_row.old_value, 'link_to_person', 'json'
      ) then
        raise exception using errcode = '55000', message = 'Stored person reference is invalid';
      end if;
      account_id := (source_row.old_value ->> 'organizationAccountId')::uuid;
      if not exists (
        select 1 from vortex_identity.organization_accounts as account
        where account.organization_id = source_row.organisation_id
          and account.organization_account_id = account_id
      ) then
        raise log 'Person link backfill skipped vanished account for storage %, field %',
          pair.storage_id, pair.old_field_id;
        continue;
      end if;
      expected_link := pg_catalog.jsonb_build_object(
        'recordTypeId', pair.target_type_id, 'recordId', account_id
      );
      if source_row.new_value is not null and source_row.new_value <> expected_link then
        raise exception using errcode = '55000', message = 'Stored person link disagrees with legacy value';
      end if;
      if source_row.new_value is null then
        execute pg_catalog.format(
          'update record_data.%I as stored set %I = $3
           where stored.organisation_id = $1 and stored.record_id = $2 and stored.%I is null',
          table_token, new_column, new_column
        ) using source_row.organisation_id, source_row.record_id, expected_link;
        get diagnostics changed_rows = row_count;
        changed_count := changed_count + changed_rows;
      end if;
      if not exists (
        select 1 from vortex_record.relationship_edges as edge
        where edge.relationship_id = pair.relationship_id
          and edge.from_organisation_id = source_row.organisation_id
          and edge.from_storage_contract_id = pair.storage_id
          and edge.from_record_id = source_row.record_id
          and edge.to_storage_contract_id = target_storage_id
          and edge.to_record_id = account_id
      ) then
        if exists (
          select 1 from vortex_record.relationship_edges as edge
          where edge.relationship_id = pair.relationship_id
            and edge.from_organisation_id = source_row.organisation_id
            and edge.from_storage_contract_id = pair.storage_id
            and edge.from_record_id = source_row.record_id
        ) then
          raise exception using errcode = '55000', message = 'Stored person link edge disagrees with legacy value';
        end if;
        insert into vortex_record.relationship_edges (
          relationship_id, from_organisation_id, to_organisation_id,
          from_application_root_id, to_application_root_id,
          from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
        ) values (
          pair.relationship_id, source_row.organisation_id, source_row.organisation_id,
          source_row.application_root_id, null, pair.storage_id, source_row.record_id,
          target_storage_id, account_id
        );
        changed_count := changed_count + 1;
      end if;
    end loop;
  end loop;
  return changed_count;
end
$function$;

alter function vortex_record.backfill_person_links_internal(uuid,bigint) owner to vortex_owner;
revoke all on function vortex_record.backfill_person_links_internal(uuid,bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
grant execute on function vortex_record.backfill_person_links_internal(uuid,bigint)
  to vortex_owner;
