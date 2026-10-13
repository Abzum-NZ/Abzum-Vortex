CREATE OR REPLACE FUNCTION vortex_definition.read_current_offboarding_inventory_installation_internal() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  installation jsonb;
  installation_state text;
  context_value jsonb;
  storage_contract_ids jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '22023',
      message = 'Offboarding inventory requires an application context';
  end if;

  begin
    installation := vortex_definition.read_current_active_installation();
    installation_state := 'active';
  exception
    when no_data_found then
      installation := vortex_definition.read_current_detached_installation_for_transfer_internal();
      installation_state := 'detached';
  end;

  select coalesce(pg_catalog.jsonb_agg(contract_id order by contract_id), '[]'::jsonb)
  into storage_contract_ids
  from (
    select distinct unnest(binding.storage_contract_ids) as contract_id
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = (context_value ->> 'organizationId')::uuid
      and binding.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and binding.state = installation_state
      and binding.application_release_revision =
        (installation ->> 'applicationReleaseRevision')::bigint
  ) as contracts;

  if storage_contract_ids = '[]'::jsonb then
    raise exception using errcode = '55000',
      message = 'Offboarding inventory installation bindings are unavailable';
  end if;

  return installation || pg_catalog.jsonb_build_object(
    'installationState', installation_state,
    'storageContractIds', storage_contract_ids
  );
end
$$;
alter function vortex_definition.read_current_offboarding_inventory_installation_internal() owner to vortex_owner;


COMMENT ON FUNCTION vortex_definition.read_current_offboarding_inventory_installation_internal() IS 'Private exact active-or-detached installation reader with the bound storage contracts for account-offboarding inventory.';

REVOKE ALL ON FUNCTION vortex_definition.read_current_offboarding_inventory_installation_internal() FROM PUBLIC;

GRANT ALL ON FUNCTION vortex_definition.read_current_offboarding_inventory_installation_internal() TO vortex_record_adapter;
