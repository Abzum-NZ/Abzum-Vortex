CREATE FUNCTION vortex_record.enforce_relationship_edge_scope() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  relationship_row vortex_record.relationship_storage_mappings%rowtype;
  source_row vortex_record.storage_catalogue%rowtype;
  target_row vortex_record.storage_catalogue%rowtype;
begin
  select mapping.* into strict relationship_row
  from vortex_record.relationship_storage_mappings as mapping
  where mapping.relationship_id = new.relationship_id;
  select catalogue.* into strict source_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = new.from_storage_contract_id;
  select catalogue.* into strict target_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = new.to_storage_contract_id;
  if relationship_row.source_storage_contract_id <> new.from_storage_contract_id
    or target_row.record_type_id <> all (relationship_row.target_record_type_ids)
    or (source_row.storage_scope = 'organization_shared') <> (new.from_application_root_id is null)
    or (target_row.storage_scope = 'organization_shared') <> (new.to_application_root_id is null)
    or (
      source_row.storage_scope = 'application_contained'
      and target_row.storage_scope = 'application_contained'
      and new.from_application_root_id <> new.to_application_root_id
    ) then
    raise exception using errcode = '23514', message = 'Relationship edge scope is invalid';
  end if;
  return new;
exception when no_data_found or too_many_rows then
  raise exception using errcode = '23514', message = 'Relationship edge mapping is unavailable';
end
$$;

REVOKE ALL ON FUNCTION vortex_record.enforce_relationship_edge_scope() FROM PUBLIC;
