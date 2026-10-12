CREATE FUNCTION vortex_record.relationship_edge_lock_identities_internal(p_relationship_id uuid, p_from_storage_contract_id uuid, p_from_record_id uuid, p_to_storage_contract_id uuid, p_to_record_id uuid) RETURNS text[]
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
declare
  source_identity text;
  target_identity text;
begin
  if (p_to_storage_contract_id is null) <> (p_to_record_id is null) then
    raise exception using errcode = '22023',
      message = 'Relationship edge target identity is incomplete';
  end if;
  source_identity := vortex_record.relationship_edge_record_identity_internal(
    p_relationship_id, p_from_storage_contract_id, p_from_record_id
  );
  if p_to_storage_contract_id is null then
    return array[source_identity];
  end if;
  target_identity := vortex_record.relationship_edge_record_identity_internal(
    p_relationship_id, p_to_storage_contract_id, p_to_record_id
  );
  if source_identity = target_identity then
    return array[source_identity];
  end if;
  return case when source_identity collate "C" < target_identity collate "C"
    then array[source_identity, target_identity]
    else array[target_identity, source_identity] end;
end
$$;

COMMENT ON FUNCTION vortex_record.relationship_edge_lock_identities_internal(p_relationship_id uuid, p_from_storage_contract_id uuid, p_from_record_id uuid, p_to_storage_contract_id uuid, p_to_record_id uuid) IS 'Sorted participant identities one relationship edge mutation locks: the source always, and the new target when an edge is installed.';

REVOKE ALL ON FUNCTION vortex_record.relationship_edge_lock_identities_internal(p_relationship_id uuid, p_from_storage_contract_id uuid, p_from_record_id uuid, p_to_storage_contract_id uuid, p_to_record_id uuid) FROM PUBLIC;
