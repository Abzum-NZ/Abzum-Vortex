CREATE OR REPLACE FUNCTION vortex_definition.read_lifecycle_activation_targets_internal(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) RETURNS TABLE(storage_contract_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  context_value jsonb;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_expected_module_bindings) = 0
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'object'
        or not item.value ?& array['moduleRootId', 'bindingRevision']
        or item.value - array['moduleRootId', 'bindingRevision'] <> '{}'::jsonb
    ) then
    raise exception using errcode = '22023',
      message = 'Lifecycle activation target command is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if (context_value ->> 'organizationId')::uuid is distinct from p_organization_id then
    raise exception using errcode = '42501',
      message = 'Lifecycle activation targets are unavailable';
  end if;

  return query
  select storage_id.value
  from vortex_definition.installation_bindings as binding
  join pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
    on expected.value ->> 'moduleRootId' = binding.module_root_id::text
    and expected.value ->> 'bindingRevision' = binding.binding_revision::text
  join pg_catalog.unnest(binding.storage_contract_ids) as storage_id(value) on true
  where binding.organization_id = p_organization_id
    and binding.application_root_id = p_application_root_id
    and binding.application_release_revision = p_application_release_revision
    -- Activation has already flipped this exact binding set to 'active' under
    -- its own advisory and row locks earlier in this transaction.
    and binding.state = 'active'
  for share of binding;
end
$$;
alter function vortex_definition.read_lifecycle_activation_targets_internal(uuid,uuid,bigint,jsonb) owner to vortex_owner;


COMMENT ON FUNCTION vortex_definition.read_lifecycle_activation_targets_internal(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) IS 'Private activation-time installation fact: the exact storage contracts of one already-activated Application binding set, shared for the transaction.';

REVOKE ALL ON FUNCTION vortex_definition.read_lifecycle_activation_targets_internal(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_definition.read_lifecycle_activation_targets_internal(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) TO vortex_owner;
