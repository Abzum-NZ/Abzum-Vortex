CREATE OR REPLACE FUNCTION vortex_definition.lock_storage_adoption_binding_internal(p_organization_id uuid, p_application_root_id uuid, p_module_root_id uuid, p_storage_contract_id uuid, p_source_release_revision bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  own_binding vortex_definition.installation_bindings%rowtype;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_module_root_id is null
    or p_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_source_release_revision is null
    or p_source_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Storage adoption binding command is invalid';
  end if;

  -- The same identity and order every binding writer uses, so this never
  -- interleaves with a provision, activation or detach of the same binding.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'vortex_definition.binding:' || p_organization_id::text || ':' ||
        p_application_root_id::text || ':' || p_module_root_id::text,
      0
    )
  );

  select binding.* into own_binding
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = p_module_root_id
  for update;
  if not found
    or own_binding.module_release_revision <> p_source_release_revision
    or not (p_storage_contract_id = any (own_binding.storage_contract_ids)) then
    raise exception using errcode = '55000',
      message = 'Storage adoption installation does not install the source release';
  end if;
  -- An installation still using the source field cannot lose it.
  if own_binding.state <> 'detached' then
    raise exception using errcode = '55006',
      message = 'Storage adoption installation is still using the source storage';
  end if;
end
$$;
alter function vortex_definition.lock_storage_adoption_binding_internal(uuid,uuid,uuid,uuid,bigint) owner to vortex_owner;


COMMENT ON FUNCTION vortex_definition.lock_storage_adoption_binding_internal(p_organization_id uuid, p_application_root_id uuid, p_module_root_id uuid, p_storage_contract_id uuid, p_source_release_revision bigint) IS 'Private storage adoption fact: locks the caller''s own binding in canonical order and requires it detached at the exact source release.';

REVOKE ALL ON FUNCTION vortex_definition.lock_storage_adoption_binding_internal(p_organization_id uuid, p_application_root_id uuid, p_module_root_id uuid, p_storage_contract_id uuid, p_source_release_revision bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_definition.lock_storage_adoption_binding_internal(p_organization_id uuid, p_application_root_id uuid, p_module_root_id uuid, p_storage_contract_id uuid, p_source_release_revision bigint) TO vortex_owner;
