CREATE OR REPLACE FUNCTION vortex_record.enforce_relationship_edge_scope() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  relationship_value jsonb;
  source_row vortex_record.storage_catalogue%rowtype;
  target_row vortex_record.storage_catalogue%rowtype;
begin
  select catalogue.* into strict source_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = new.from_storage_contract_id;
  select catalogue.* into strict target_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = new.to_storage_contract_id;
  -- Each storage identity carries its declared record type, including an isolated preview.
  -- Validate the edge against that source's own relationship rather than an installed mapping
  -- of the same relationship identity that belongs to another storage contract.
  select relationship.value into strict relationship_value
  from pg_catalog.jsonb_array_elements(source_row.record_type_definition -> 'relationships')
    as relationship(value)
  where (relationship.value ->> 'relationshipId')::uuid = new.relationship_id;
  if not vortex_record.relationship_declares_target_internal(
      relationship_value, target_row.record_type_id
    )
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
alter function vortex_record.enforce_relationship_edge_scope() owner to vortex_owner;


REVOKE ALL ON FUNCTION vortex_record.enforce_relationship_edge_scope() FROM PUBLIC;
