CREATE FUNCTION vortex_record.relationship_edge_record_identity_internal(p_relationship_id uuid, p_storage_contract_id uuid, p_record_id uuid) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
begin
  if p_relationship_id is null or p_storage_contract_id is null or p_record_id is null
    or p_relationship_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Relationship edge participant identity is invalid';
  end if;
  return pg_catalog.concat_ws(
    ':',
    'vortex_record.relationship_edge',
    pg_catalog.lower(p_relationship_id::text),
    pg_catalog.lower(p_storage_contract_id::text),
    pg_catalog.lower(p_record_id::text)
  );
end
$$;

COMMENT ON FUNCTION vortex_record.relationship_edge_record_identity_internal(p_relationship_id uuid, p_storage_contract_id uuid, p_record_id uuid) IS 'Permanent identity of one participant of one relationship edge: relationship, storage contract and record. Malformed or sentinel identities raise.';

REVOKE ALL ON FUNCTION vortex_record.relationship_edge_record_identity_internal(p_relationship_id uuid, p_storage_contract_id uuid, p_record_id uuid) FROM PUBLIC;
