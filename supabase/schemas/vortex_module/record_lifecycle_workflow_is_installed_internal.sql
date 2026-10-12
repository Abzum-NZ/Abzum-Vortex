CREATE FUNCTION vortex_module.record_lifecycle_workflow_is_installed_internal(p_organization_id uuid, p_application_root_id uuid, p_storage_contract_id uuid, p_workflow_id uuid, p_expected_workflow_revision bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  active_release_revision bigint;
  matched boolean;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_workflow_id is null
    or p_workflow_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_workflow_revision is null
    or p_expected_workflow_revision not between 1 and 9007199254740991 then
    return false;
  end if;

  select binding.application_release_revision into active_release_revision
  from vortex_module.installation_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.application_root_id = p_application_root_id
    and binding.state = 'active'
    and p_storage_contract_id = any (binding.storage_contract_ids)
  order by binding.module_root_id
  limit 1
  for share;
  if not found or active_release_revision <> p_expected_workflow_revision then
    return false;
  end if;

  select true into matched
  from vortex_definition.releases as application_release
  join vortex_definition.roots as application_root
    on application_root.root_id = application_release.root_id
  where application_release.root_id = p_application_root_id
    and application_release.release_revision = active_release_revision
    and application_root.organization_id = p_organization_id
    and application_root.kind = 'application'
    and application_release.compilation_output #>> '{kind}' = 'application'
    and application_release.compilation_output #>> '{canonical,envelope,rootId}'
      = p_application_root_id::text
    and application_release.compilation_output #>> '{validationContractVersion}'
      = application_release.validation_contract_version
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(
            application_release.compilation_output #> '{canonical,content,workflows}'
          ) = 'array'
            then application_release.compilation_output #> '{canonical,content,workflows}'
          else '[]'::jsonb
        end
      ) as workflow(value)
      where pg_catalog.jsonb_typeof(workflow.value) = 'object'
        and workflow.value ->> 'workflowId' = p_workflow_id::text
    )
  for share of application_release, application_root;

  return coalesce(matched, false);
end
$$;

COMMENT ON FUNCTION vortex_module.record_lifecycle_workflow_is_installed_internal(p_organization_id uuid, p_application_root_id uuid, p_storage_contract_id uuid, p_workflow_id uuid, p_expected_workflow_revision bigint) IS 'Private exact-active-Application workflow fact for record lifecycle policy administration; locks the matching installation and immutable Application release.';

REVOKE ALL ON FUNCTION vortex_module.record_lifecycle_workflow_is_installed_internal(p_organization_id uuid, p_application_root_id uuid, p_storage_contract_id uuid, p_workflow_id uuid, p_expected_workflow_revision bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_module.record_lifecycle_workflow_is_installed_internal(p_organization_id uuid, p_application_root_id uuid, p_storage_contract_id uuid, p_workflow_id uuid, p_expected_workflow_revision bigint) TO vortex_record_owner;
