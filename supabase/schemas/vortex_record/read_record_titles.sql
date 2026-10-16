create or replace function vortex_record.read_record_titles(
  p_record_type_id uuid,
  p_record_ids uuid[],
  p_title_field_id uuid
)
returns table (record_id uuid, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_record_ids is null then
    return;
  end if;

  -- This registered projection has its own fixed account-read visibility:
  -- account administrators see suspended members, while other live members
  -- see active members only. A role-template permission cannot express that
  -- fixed authority, so titles use the same protected reader as legacy links.
  if exists (
    select 1
    from vortex_record.storage_catalogue as storage
    join vortex_record.protected_read_model_views as registered
      on registered.protected_read_model_key = storage.protected_read_model_key
    cross join lateral pg_catalog.jsonb_array_elements(
      storage.record_type_definition -> 'fields'
    ) as field(value)
    where storage.record_type_id = p_record_type_id
      and storage.state = 'active'
      and storage.protected_read_model_key = 'organization_accounts'
      and registered.reader_schema = 'vortex_access'
      and registered.reader_function = 'list_organization_accounts_projection'
      and storage.record_type_definition ->> 'titleFieldId' = p_title_field_id::text
      and field.value ->> 'fieldId' = p_title_field_id::text
      and field.value ->> 'key' = 'display_name'
  ) then
    return query
    with visible as materialized (
      select person.record_id, person.revision,
        person.attribute_values ->> 'display_name' as display_name
      from vortex_access.list_organization_accounts_projection(
        null::uuid, null::integer, p_record_ids
      ) as person
    )
    select requested.id,
      case when pg_catalog.length(pg_catalog.btrim(visible.display_name)) > 0
        then pg_catalog.jsonb_build_object(
          'outcome', 'allowed', 'recordId', requested.id,
          'concurrencyNumber', visible.revision,
          'values', pg_catalog.jsonb_build_object(
            pg_catalog.lower(p_title_field_id::text), visible.display_name
          )
        )
        else pg_catalog.jsonb_build_object('outcome', 'refused')
      end
    from pg_catalog.unnest(p_record_ids) as requested(id)
    left join visible on visible.record_id = requested.id;
    return;
  end if;

  return query select titles.record_id, titles.result
  from vortex_record.read_record_titles_internal(
    p_record_type_id, p_record_ids, p_title_field_id
  ) as titles;
end
$function$;

alter function vortex_record.read_record_titles(uuid,uuid[],uuid) owner to vortex_owner;

revoke all on function vortex_record.read_record_titles(uuid,uuid[],uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_record.read_record_titles(uuid,uuid[],uuid) to vortex_request;

comment on function vortex_record.read_record_titles(uuid,uuid[],uuid) is
  'Protected batch of record titles; the registered organisation-account projection applies its fixed viewer visibility for Person display names, while the restricted adapter applies exact-record access to other types.';
