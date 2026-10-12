CREATE FUNCTION vortex_record.lock_storage_adoption_internal(p_conversion_contract_id uuid, p_organization_id uuid, p_application_root_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  conversion vortex_record.storage_conversion_catalogue%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  target_record_types jsonb;
  lineage record;
  lineage_id uuid;
  converted_lineage_locked boolean := false;
begin
  select entry.* into strict conversion
  from vortex_record.storage_conversion_catalogue as entry
  where entry.conversion_contract_id = p_conversion_contract_id;
  select catalogue.* into strict catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = conversion.source_storage_contract_id;

  perform vortex_module.lock_storage_adoption_binding_internal(
    p_organization_id, p_application_root_id, catalogue_row.module_root_id,
    conversion.source_storage_contract_id, conversion.source_release_revision
  );

  select release.compilation_output #> '{canonical,content,recordTypes}'
  into strict target_record_types
  from vortex_definition.releases as release
  where release.root_id = catalogue_row.module_root_id
    and release.release_revision = conversion.target_release_revision;
  if pg_catalog.jsonb_typeof(target_record_types) is distinct from 'array' then
    raise exception using errcode = '55000',
      message = 'Storage adoption target release is incompatible';
  end if;

  -- The provisioner's exact loop order (by the published storage identity).
  for lineage in
    select item.value ->> 'storageContractId' as storage_contract_text
    from pg_catalog.jsonb_array_elements(target_record_types) as item(value)
    order by item.value ->> 'storageContractId'
  loop
    lineage_id := lineage.storage_contract_text::uuid;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex_record.storage:' || lineage_id::text, 0)
    );
    if lineage_id = conversion.source_storage_contract_id then
      converted_lineage_locked := true;
      exit;
    end if;
  end loop;
  if not converted_lineage_locked then
    raise exception using errcode = '55000',
      message = 'Storage adoption target release does not carry the converted storage';
  end if;
exception
  when no_data_found or too_many_rows or invalid_text_representation then
    raise exception using errcode = '55000',
      message = 'Storage adoption evidence is unavailable';
end
$$;

COMMENT ON FUNCTION vortex_record.lock_storage_adoption_internal(p_conversion_contract_id uuid, p_organization_id uuid, p_application_root_id uuid) IS 'Private helper: locks the caller''s own binding for one conversion, requires it detached at the exact source release, then takes the target release''s storage-lineage locks in the provisioner''s canonical order up to the converted lineage.';

REVOKE ALL ON FUNCTION vortex_record.lock_storage_adoption_internal(p_conversion_contract_id uuid, p_organization_id uuid, p_application_root_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.lock_storage_adoption_internal(p_conversion_contract_id uuid, p_organization_id uuid, p_application_root_id uuid) TO vortex_record_adapter;
