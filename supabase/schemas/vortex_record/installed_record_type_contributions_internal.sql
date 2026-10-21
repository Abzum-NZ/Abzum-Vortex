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
  -- that a contributor Module release introduced on the owner's storage (written only by the
  -- exact contribution provisioner after the declaration was resolved against the owner's
  -- extension point), kept only while that contributor Module is bound by an active installation
  -- in this organisation. The mapping carries the contributor's exact field definition. A
  -- contribution neither of those two facts vouches for is never returned. Only optional value
  -- fields are contributed: a link or a produced value needs relationships and calculation
  -- context the owner record does not carry.
  return coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'kind', 'field',
        'contributionId', mapping.field_id,
        'contributorModuleRootId', mapping.introduced_by_module_root_id,
        'contributorReleaseRevision', pins.release_revision,
        'contributorApplicationRootIds', pins.application_root_ids,
        'field', mapping.field_definition
      ) order by mapping.field_id
    )
    from vortex_record.field_storage_mappings as mapping
    cross join lateral (
      select pg_catalog.max(binding.module_release_revision) as release_revision,
        pg_catalog.jsonb_agg(distinct binding.application_root_id) as application_root_ids
      from vortex_definition.installation_bindings as binding
      where binding.organization_id = p_organization_id
        and binding.module_root_id = mapping.introduced_by_module_root_id
        and binding.state = 'active'
      having pg_catalog.count(*) > 0
    ) as pins
    where mapping.storage_contract_id = p_target_storage_contract_id
      and mapping.state = 'active'
      and mapping.introduced_by_module_root_id <> p_target_module_root_id
      and mapping.field_definition ->> 'type' not in (
        'link', 'link_to_one_of_several', 'calculation', 'total'
      )
      and mapping.field_definition -> 'required' = 'false'::jsonb
  ), '[]'::jsonb);
end
$function$;

alter function vortex_record.installed_record_type_contributions_internal(uuid,uuid,uuid) owner to vortex_owner;

revoke all on function vortex_record.installed_record_type_contributions_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.installed_record_type_contributions_internal(uuid, uuid, uuid)
  to vortex_record_adapter, vortex_owner;

comment on function vortex_record.installed_record_type_contributions_internal(uuid, uuid, uuid) is
  'Private exact installed field contributions of one owner record type in one organisation: the active contributor field mappings on the owner''s storage whose contributor Module is bound by an active installation of that organisation, with the contributor''s exact field definition. Owner-only except for the fixed record adapter; it decides no access.';
