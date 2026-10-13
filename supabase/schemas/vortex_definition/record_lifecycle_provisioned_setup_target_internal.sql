CREATE OR REPLACE FUNCTION vortex_definition.record_lifecycle_provisioned_setup_target_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_binding_revision bigint, p_storage_contract_id uuid, p_workflow_id uuid, p_expected_workflow_revision bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  provisioned_release_revision bigint;
  matched boolean;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_binding_revision is null
    or p_expected_binding_revision not between 1 and 9007199254740991
    or p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    -- A workflow reference is either completely absent or completely present.
    or (p_workflow_id is null) <> (p_expected_workflow_revision is null)
    or (p_workflow_id is not null
      and p_workflow_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_expected_workflow_revision is not null
      and p_expected_workflow_revision not between 1 and 9007199254740991) then
    return false;
  end if;

  select binding.application_release_revision into provisioned_release_revision
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.application_root_id = p_application_root_id
    and binding.state = 'provisioned'
    and binding.binding_revision = p_expected_binding_revision
    and p_storage_contract_id = any (binding.storage_contract_ids)
  order by binding.module_root_id
  limit 1
  for share;
  if not found then
    return false;
  end if;

  if p_workflow_id is null then
    return true;
  end if;

  -- There is no free-standing workflow revision in a compiled definition: the
  -- Application release revision is the workflow revision runtime pins.
  if provisioned_release_revision <> p_expected_workflow_revision then
    return false;
  end if;

  select true into matched
  from vortex_definition.releases as application_release
  join vortex_definition.roots as application_root
    on application_root.root_id = application_release.root_id
  where application_release.root_id = p_application_root_id
    and application_release.release_revision = provisioned_release_revision
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
alter function vortex_definition.record_lifecycle_provisioned_setup_target_internal(uuid,uuid,bigint,uuid,uuid,bigint) owner to vortex_owner;


COMMENT ON FUNCTION vortex_definition.record_lifecycle_provisioned_setup_target_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_binding_revision bigint, p_storage_contract_id uuid, p_workflow_id uuid, p_expected_workflow_revision bigint) IS 'Private provisioned-setup installation fact for one exact Application binding revision and, optionally, one workflow of that exact immutable release; never used by the #566 administration save.';

REVOKE ALL ON FUNCTION vortex_definition.record_lifecycle_provisioned_setup_target_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_binding_revision bigint, p_storage_contract_id uuid, p_workflow_id uuid, p_expected_workflow_revision bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_definition.record_lifecycle_provisioned_setup_target_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_binding_revision bigint, p_storage_contract_id uuid, p_workflow_id uuid, p_expected_workflow_revision bigint) TO vortex_owner;
