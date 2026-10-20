create or replace function vortex_record.read_installed_record_contributions()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_id_value uuid;
  installation jsonb;
  binding_item jsonb;
  module_content jsonb;
  effective_content jsonb;
  record_type_item jsonb;
  effective_type jsonb;
  contributions jsonb;
  result jsonb := '[]'::jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Installed contributions require an application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;

  -- A preview runs its own storage and receives no contributions.
  if nullif(pg_catalog.current_setting('vortex_record.preview_installation_id', true), '') is not null then
    return result;
  end if;

  -- The exact installed contributions on the record types of the Modules this application's active
  -- installation binds, resolved through the one effective-field builder every record reader and
  -- writer uses, so what the page is told is exactly what the record paths will serve.
  installation := vortex_definition.read_current_active_installation();
  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
    order by item.value ->> 'moduleRootId'
  loop
    select release.record_content into strict module_content
    from vortex_definition.runtime_releases as release
    where release.root_id = (binding_item ->> 'moduleRootId')::uuid
      and release.release_revision = (binding_item ->> 'moduleReleaseRevision')::bigint;
    effective_content := vortex_record.with_installed_record_contributions_internal(
      module_content, organization_id_value, (binding_item ->> 'moduleRootId')::uuid
    );
    for record_type_item in
      select item.value
      from pg_catalog.jsonb_array_elements(module_content -> 'recordTypes') as item(value)
      where not item.value ? 'systemProjection'
    loop
      select item.value into effective_type
      from pg_catalog.jsonb_array_elements(effective_content -> 'recordTypes') as item(value)
      where item.value ->> 'recordTypeId' = record_type_item ->> 'recordTypeId';
      select coalesce(pg_catalog.jsonb_agg(entry.value order by entry.ordinality), '[]'::jsonb)
      into contributions
      from pg_catalog.jsonb_array_elements(
        vortex_record.installed_record_type_contributions_internal(
          organization_id_value, (binding_item ->> 'moduleRootId')::uuid,
          (record_type_item ->> 'storageContractId')::uuid
        )
      ) with ordinality as entry(value, ordinality)
      where exists (
        select 1
        from pg_catalog.jsonb_array_elements(effective_type -> 'fields') as field(value)
        where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(entry.value ->> 'contributionId')
      );
      if contributions <> '[]'::jsonb then
        result := result || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'moduleRootId', binding_item -> 'moduleRootId',
            'recordTypeId', record_type_item -> 'recordTypeId',
            'contributions', contributions
          )
        );
      end if;
    end loop;
  end loop;
  return result;
exception
  when no_data_found then
    raise exception using errcode = '55000', message = 'Installed definition evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Installed definition evidence is ambiguous';
end
$function$;

alter function vortex_record.read_installed_record_contributions() owner to vortex_record_adapter;

revoke all on function vortex_record.read_installed_record_contributions()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_record.read_installed_record_contributions() to vortex_request;
grant execute on function vortex_record.read_installed_record_contributions() to vortex_owner;

comment on function vortex_record.read_installed_record_contributions() is
  'The fields other installed Modules of the organisation contributed to the record types of the Modules the current application binds, as the record paths serve them: owner Module, owner record type and each contributing Module with its exact field definition. Reads under the validated human request context; a preview receives none.';
