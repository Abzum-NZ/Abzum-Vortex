create or replace function vortex_record.with_installed_record_contributions_internal(
  p_content jsonb,
  p_organization_id uuid,
  p_module_root_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  record_type_item jsonb;
  record_types jsonb := '[]'::jsonb;
  contributed jsonb;
begin
  if p_content is null or pg_catalog.jsonb_typeof(p_content -> 'recordTypes') is distinct from 'array' then
    return p_content;
  end if;

  -- The one place an installed Module release's record types gain the fields other installed
  -- Modules contributed to them: every reader and writer of an owner record builds its record
  -- type from the release content through here, so an owner record has one effective field list.
  -- A contributed field whose identity or key the owner already uses is left out.
  for record_type_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_content -> 'recordTypes')
      with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    contributed := '[]'::jsonb;
    if not record_type_item ? 'systemProjection' then
      select coalesce(pg_catalog.jsonb_agg(entry.value -> 'field' order by entry.ordinality), '[]'::jsonb)
      into contributed
      from pg_catalog.jsonb_array_elements(
        vortex_record.installed_record_type_contributions_internal(
          p_organization_id, p_module_root_id, (record_type_item ->> 'storageContractId')::uuid
        )
      ) with ordinality as entry(value, ordinality)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as own(value)
        where pg_catalog.lower(own.value ->> 'fieldId') = pg_catalog.lower(entry.value #>> '{field,fieldId}')
          or own.value ->> 'key' = entry.value #>> '{field,key}'
      );
    end if;
    record_types := record_types || pg_catalog.jsonb_build_array(
      case when contributed = '[]'::jsonb then record_type_item
        else pg_catalog.jsonb_set(
          record_type_item, '{fields}', (record_type_item -> 'fields') || contributed
        ) end
    );
  end loop;
  return pg_catalog.jsonb_set(p_content, '{recordTypes}', record_types);
end
$function$;

alter function vortex_record.with_installed_record_contributions_internal(jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.with_installed_record_contributions_internal(jsonb, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.with_installed_record_contributions_internal(jsonb, uuid, uuid)
  to vortex_record_adapter, vortex_owner, postgres;

comment on function vortex_record.with_installed_record_contributions_internal(jsonb, uuid, uuid) is
  'Private installed Module content with each record type''s fields extended by the fields other installed Modules of the organisation contributed to it. The one effective field list every record reader and writer builds from.';
