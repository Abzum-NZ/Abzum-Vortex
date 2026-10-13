CREATE OR REPLACE FUNCTION vortex_definition.count_storage_adoption_dependents_internal(p_module_root_id uuid, p_storage_contract_id uuid, p_dependent_release_revisions bigint[]) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  dependent_count bigint;
begin
  if p_module_root_id is null
    or p_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_dependent_release_revisions is null
    or pg_catalog.array_position(p_dependent_release_revisions, null) is not null then
    raise exception using errcode = '22023',
      message = 'Storage adoption dependent count command is invalid';
  end if;

  -- Every organisation's binding counts: the mappings are shared by every
  -- installation of the Module. A provisioned binding is counted with an active
  -- one because activation does not recheck storage, so it could otherwise
  -- activate over a retired field; only a detached binding stops depending on
  -- the source field. The caller holds the storage-lineage lock, which every
  -- provision of these releases takes before it writes a binding, so no new
  -- dependent can appear unseen.
  select pg_catalog.count(*) into dependent_count
  from vortex_definition.installation_bindings as binding
  where binding.module_root_id = p_module_root_id
    and binding.state in ('provisioned', 'active')
    and p_storage_contract_id = any (binding.storage_contract_ids)
    and binding.module_release_revision = any (p_dependent_release_revisions);
  return dependent_count;
end
$$;
alter function vortex_definition.count_storage_adoption_dependents_internal(uuid,uuid,bigint[]) owner to vortex_owner;


COMMENT ON FUNCTION vortex_definition.count_storage_adoption_dependents_internal(p_module_root_id uuid, p_storage_contract_id uuid, p_dependent_release_revisions bigint[]) IS 'Private storage adoption fact: counts every organisation''s provisioned and active bindings of the Module that install one of the named releases needing the source storage.';

REVOKE ALL ON FUNCTION vortex_definition.count_storage_adoption_dependents_internal(p_module_root_id uuid, p_storage_contract_id uuid, p_dependent_release_revisions bigint[]) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_definition.count_storage_adoption_dependents_internal(p_module_root_id uuid, p_storage_contract_id uuid, p_dependent_release_revisions bigint[]) TO vortex_owner;
