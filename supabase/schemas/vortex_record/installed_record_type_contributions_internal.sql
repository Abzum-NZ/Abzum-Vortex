create or replace function vortex_record.installed_record_type_contributions_internal(
  p_organization_id uuid,
  p_target_module_root_id uuid,
  p_target_storage_contract_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_target_module_root_id is null
    or not vortex_platform.is_non_nil_uuid(p_target_module_root_id::text)
    or p_target_storage_contract_id is null
    or not vortex_platform.is_non_nil_uuid(p_target_storage_contract_id::text) then
    raise exception using errcode = '22023',
      message = 'Installed contribution selector is invalid';
  end if;

  -- The exact installed field contributions of one owner record type: the active field mappings
  -- that a contributor Module release introduced on the owner's storage, kept only while a
  -- contributor release the organisation actively binds still declares the field as a contribution
  -- to this owner Module, through an extension point of an owner release the organisation actively
  -- binds that is on this record type and accepts fields. The field definition is the one that
  -- bound contributor release compiled, never the definition stored with the shared mapping, so an
  -- organisation on another contributor release never receives a field only a release it does not
  -- bind declares. When several bound contributor releases declare it, the newest one is served.
  -- Only optional value fields are contributed: a link or a produced value needs relationships and
  -- calculation context the owner record does not carry.
  return coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'kind', 'field',
        'contributionId', mapping.field_id,
        'contributorModuleRootId', mapping.introduced_by_module_root_id,
        'contributorReleaseRevision', declared.release_revision,
        'contributorApplicationRootIds', declared.application_root_ids,
        'field', declared.field_definition
      ) order by mapping.field_id
    )
    from vortex_record.field_storage_mappings as mapping
    join vortex_record.storage_catalogue as catalogue
      on catalogue.storage_contract_id = mapping.storage_contract_id
      and catalogue.module_root_id = p_target_module_root_id
      and catalogue.state = 'active'
    cross join lateral (
      select bound.release_revision, bound.application_root_ids, declared_field.field_definition
      from (
        select binding.module_release_revision as release_revision,
          pg_catalog.jsonb_agg(distinct binding.application_root_id) as application_root_ids
        from vortex_definition.installation_bindings as binding
        where binding.organization_id = p_organization_id
          and binding.module_root_id = mapping.introduced_by_module_root_id
          and binding.state = 'active'
        group by binding.module_release_revision
      ) as bound
      join vortex_definition.releases as release
        on release.root_id = mapping.introduced_by_module_root_id
        and release.release_revision = bound.release_revision
      cross join lateral (
        select field.value as field_definition
        from pg_catalog.jsonb_array_elements(
            coalesce(release.compilation_output #> '{canonical,content,contributions}', '[]'::jsonb)
          ) as contribution(value)
        join pg_catalog.jsonb_array_elements(
            coalesce(release.compilation_output #> '{canonical,content,recordTypes}', '[]'::jsonb)
          ) as record_type(value)
          on pg_catalog.lower(record_type.value ->> 'recordTypeId')
            = pg_catalog.lower(contribution.value ->> 'recordTypeId')
        cross join lateral pg_catalog.jsonb_array_elements(
            coalesce(record_type.value -> 'fields', '[]'::jsonb)
          ) as field(value)
        where contribution.value ->> 'kind' = 'field'
          and pg_catalog.lower(contribution.value ->> 'fieldId')
            = pg_catalog.lower(mapping.field_id::text)
          and pg_catalog.lower(contribution.value #>> '{targetModule,moduleRootId}')
            = pg_catalog.lower(p_target_module_root_id::text)
          and pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(mapping.field_id::text)
          and exists (
            select 1
            from vortex_definition.installation_bindings as owner_binding
            join vortex_definition.releases as owner_release
              on owner_release.root_id = owner_binding.module_root_id
              and owner_release.release_revision = owner_binding.module_release_revision
            cross join lateral pg_catalog.jsonb_array_elements(
                coalesce(owner_release.compilation_output #> '{canonical,content,extensionPoints}', '[]'::jsonb)
              ) as point(value)
            where owner_binding.organization_id = p_organization_id
              and owner_binding.module_root_id = p_target_module_root_id
              and owner_binding.state = 'active'
              and pg_catalog.lower(point.value ->> 'extensionPointId')
                = pg_catalog.lower(contribution.value ->> 'targetExtensionPointId')
              and pg_catalog.lower(point.value ->> 'recordTypeId')
                = pg_catalog.lower(catalogue.record_type_id::text)
              and coalesce((point.value -> 'accepts') ? 'field', false)
          )
        limit 1
      ) as declared_field
      order by bound.release_revision desc
      limit 1
    ) as declared
    where mapping.storage_contract_id = p_target_storage_contract_id
      and mapping.state = 'active'
      and mapping.introduced_by_module_root_id <> p_target_module_root_id
      and declared.field_definition ->> 'type' not in (
        'link', 'link_to_one_of_several', 'calculation', 'total'
      )
      and declared.field_definition -> 'required' = 'false'::jsonb
  ), '[]'::jsonb);
end
$function$;

alter function vortex_record.installed_record_type_contributions_internal(uuid,uuid,uuid) owner to vortex_owner;

revoke all on function vortex_record.installed_record_type_contributions_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.installed_record_type_contributions_internal(uuid, uuid, uuid)
  to vortex_record_adapter, vortex_owner;

comment on function vortex_record.installed_record_type_contributions_internal(uuid, uuid, uuid) is
  'Private exact installed field contributions of one owner record type in one organisation: the active contributor field mappings on the owner''s storage that a contributor release the organisation actively binds still declares for this owner, through an accepting extension point of an actively bound owner release, with that bound release''s exact field definition. Owner-only except for the fixed record adapter; it decides no access.';
