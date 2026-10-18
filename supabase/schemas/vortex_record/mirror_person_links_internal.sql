create or replace function vortex_record.mirror_person_links_internal(
  p_storage_contract_id uuid,
  p_organization_id uuid,
  p_record_id uuid,
  p_values jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  pair record;
  old_value jsonb;
  new_value jsonb;
  account_id uuid;
  mirror_to_link boolean;
  table_token text;
  target_storage_id uuid;
  source_application_id uuid;
  source_exists boolean;
begin
  if pg_catalog.jsonb_typeof(p_values) <> 'object' then
    raise exception using errcode = '22023', message = 'Person link mirror values are invalid';
  end if;
  select catalogue.physical_table_token into table_token
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id
    and catalogue.physical_schema_token = 'record_data';
  if table_token is null then
    raise exception using errcode = '55000', message = 'Person link mirror storage is unavailable';
  end if;

  for pair in
    select newer.field_id as new_field_id,
      (newer.field_definition #>> '{settings,legacyPersonFieldId}')::uuid as old_field_id,
      relationship.relationship_id,
      relationship.target_record_type_ids[1] as target_type_id
    from vortex_record.field_storage_mappings as newer
    join vortex_record.relationship_storage_mappings as relationship
      on relationship.source_storage_contract_id = newer.storage_contract_id
      and relationship.source_field_id = newer.field_id
    where newer.storage_contract_id = p_storage_contract_id
      and newer.state = 'active'
      and newer.field_definition #>> '{settings,legacyPersonFieldId}' is not null
      and pg_catalog.cardinality(relationship.target_record_type_ids) = 1
    order by newer.field_id
  loop
    if not (p_values ? pair.old_field_id::text or p_values ? pair.new_field_id::text) then
      continue;
    end if;
    if not exists (
      select 1 from vortex_record.field_storage_mappings as older
      where older.storage_contract_id = p_storage_contract_id
        and older.field_id = pair.old_field_id
        and older.field_definition ->> 'type' = 'link_to_person'
    ) then
      raise exception using errcode = '55000', message = 'Person link mirror declaration is incompatible';
    end if;
    mirror_to_link := p_values ? pair.old_field_id::text;
    if mirror_to_link then
      old_value := p_values -> pair.old_field_id::text;
      if pg_catalog.jsonb_typeof(old_value) <> 'null'
        and not vortex_record.canonical_record_value_matches(old_value, 'link_to_person', 'json') then
        raise exception using errcode = '22023', message = 'Person link mirror source is invalid';
      end if;
      account_id := case when pg_catalog.jsonb_typeof(old_value) = 'null'
        then null else (old_value ->> 'organizationAccountId')::uuid end;
      new_value := case when account_id is null then 'null'::jsonb else
        pg_catalog.jsonb_build_object('recordTypeId', pair.target_type_id, 'recordId', account_id)
      end;
      if p_values ? pair.new_field_id::text
        and p_values -> pair.new_field_id::text is distinct from new_value then
        raise exception using errcode = '23514', message = 'Person link mirror values disagree';
      end if;
    else
      new_value := p_values -> pair.new_field_id::text;
      if pg_catalog.jsonb_typeof(new_value) <> 'null'
        and (pg_catalog.jsonb_typeof(new_value) <> 'object'
          or new_value ->> 'recordTypeId' is distinct from pair.target_type_id::text
          or not pg_catalog.pg_input_is_valid(new_value ->> 'recordId', 'uuid')) then
        raise exception using errcode = '22023', message = 'Person link mirror target is invalid';
      end if;
      account_id := case when pg_catalog.jsonb_typeof(new_value) = 'null'
        then null else (new_value ->> 'recordId')::uuid end;
      old_value := case when account_id is null then 'null'::jsonb else
        pg_catalog.jsonb_build_object('organizationAccountId', account_id) end;
    end if;

    if account_id is not null and not exists (
      select 1 from vortex_identity.organization_accounts as account
      where account.organization_id = p_organization_id
        and account.organization_account_id = account_id
    ) then
      raise exception using errcode = 'P0002', message = 'Person link mirror account is unavailable';
    end if;
    select catalogue.storage_contract_id into target_storage_id
    from vortex_record.storage_catalogue as catalogue
    where catalogue.record_type_id = pair.target_type_id
      and catalogue.physical_schema_token = 'system_projection';
    if target_storage_id is null then
      raise exception using errcode = '55000', message = 'Person link mirror target storage is unavailable';
    end if;
    execute pg_catalog.format(
      'select stored.application_root_id from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2', table_token
    ) into source_application_id using p_organization_id, p_record_id;
    source_exists := found;
    if not source_exists then
      raise exception using errcode = '40001', message = 'Person link mirror source changed';
    end if;
    if mirror_to_link then
      execute pg_catalog.format(
        'update record_data.%I as stored set %I = $3
         where stored.organisation_id = $1 and stored.record_id = $2',
        table_token, 'f_' || pg_catalog.replace(pair.new_field_id::text, '-', '')
      ) using p_organization_id, p_record_id, new_value;
      delete from vortex_record.relationship_edges as edge
      where edge.relationship_id = pair.relationship_id
        and edge.from_organisation_id = p_organization_id
        and edge.from_storage_contract_id = p_storage_contract_id
        and edge.from_record_id = p_record_id;
      if account_id is not null then
        insert into vortex_record.relationship_edges (
          relationship_id, from_organisation_id, to_organisation_id,
          from_application_root_id, to_application_root_id,
          from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
        ) values (
          pair.relationship_id, p_organization_id, p_organization_id,
          source_application_id, null, p_storage_contract_id, p_record_id,
          target_storage_id, account_id
        );
      end if;
    else
      execute pg_catalog.format(
        'update record_data.%I as stored set %I = $3
         where stored.organisation_id = $1 and stored.record_id = $2',
        table_token, 'f_' || pg_catalog.replace(pair.old_field_id::text, '-', '')
      ) using p_organization_id, p_record_id, old_value;
    end if;
  end loop;
end
$function$;

alter function vortex_record.mirror_person_links_internal(uuid,uuid,uuid,jsonb) owner to vortex_owner;
revoke all on function vortex_record.mirror_person_links_internal(uuid,uuid,uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.mirror_person_links_internal(uuid,uuid,uuid,jsonb)
  to vortex_owner, vortex_record_adapter;
