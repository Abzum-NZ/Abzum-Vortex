create or replace function vortex_record.installed_record_type_action_contributions_internal(
  p_organization_id uuid,
  p_target_module_root_id uuid,
  p_target_module_release_revision bigint,
  p_target_record_type_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  target_content jsonb;
  target_storage_contract_id uuid;
  field_contributions jsonb;
  contributor record;
  contributor_content jsonb;
  contribution jsonb;
  point jsonb;
  action_definition jsonb;
  action_flow jsonb;
  contributed_field_ids text[];
  result jsonb := '[]'::jsonb;
begin
  if p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_target_module_root_id is null
    or not vortex_platform.is_non_nil_uuid(p_target_module_root_id::text)
    or p_target_module_release_revision is null
    or p_target_module_release_revision not between 1 and 9007199254740991
    or p_target_record_type_id is null
    or not vortex_platform.is_non_nil_uuid(p_target_record_type_id::text) then
    raise exception using errcode = '22023',
      message = 'Installed contribution selector is invalid';
  end if;

  -- The owner Module release the calling application binds declares the extension points a
  -- contribution must resolve against; it counts only while the organisation actively binds it.
  select release.compilation_output #> '{canonical,content}' into target_content
  from vortex_definition.releases as release
  where release.root_id = p_target_module_root_id
    and release.release_revision = p_target_module_release_revision
    and exists (
      select 1
      from vortex_definition.installation_bindings as binding
      where binding.organization_id = p_organization_id
        and binding.module_root_id = p_target_module_root_id
        and binding.module_release_revision = p_target_module_release_revision
        and binding.state = 'active'
    );
  if target_content is null then
    return result;
  end if;
  select (record_type.value ->> 'storageContractId')::uuid into target_storage_contract_id
  from pg_catalog.jsonb_array_elements(target_content -> 'recordTypes') as record_type(value)
  where pg_catalog.lower(record_type.value ->> 'recordTypeId')
    = pg_catalog.lower(p_target_record_type_id::text)
    and not record_type.value ? 'systemProjection';
  if target_storage_contract_id is null then
    return result;
  end if;
  -- The fields contributed to this record type, resolved once for every contributor below.
  field_contributions := vortex_record.installed_record_type_contributions_internal(
    p_organization_id, p_target_module_root_id, target_storage_contract_id
  );

  -- Only Modules that depend on the owner can contribute to it, so only their releases are read.
  for contributor in
    select binding.module_root_id,
      pg_catalog.max(binding.module_release_revision) as release_revision,
      pg_catalog.jsonb_agg(distinct binding.application_root_id) as application_root_ids
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = p_organization_id
      and binding.state = 'active'
      and binding.module_root_id <> p_target_module_root_id
      and exists (
        select 1
        from vortex_definition.release_dependencies as dependency
        where dependency.root_id = binding.module_root_id
          and dependency.release_revision = binding.module_release_revision
          and dependency.dependency_kind = 'module'
          and dependency.target_root_id = p_target_module_root_id
      )
    group by binding.module_root_id
    order by binding.module_root_id
  loop
    select release.compilation_output #> '{canonical,content}' into contributor_content
    from vortex_definition.releases as release
    where release.root_id = contributor.module_root_id
      and release.release_revision = contributor.release_revision;
    if contributor_content is null then
      continue;
    end if;
    select coalesce(pg_catalog.array_agg(pg_catalog.lower(field_entry.value ->> 'contributionId')), array[]::text[])
    into contributed_field_ids
    from pg_catalog.jsonb_array_elements(field_contributions) as field_entry(value)
    where (field_entry.value ->> 'contributorModuleRootId')::uuid = contributor.module_root_id;

    for contribution in
      select item.value
      from pg_catalog.jsonb_array_elements(coalesce(contributor_content -> 'contributions', '[]'::jsonb))
        as item(value)
      where item.value ->> 'kind' = 'action'
        and pg_catalog.lower(item.value #>> '{targetModule,moduleRootId}')
          = pg_catalog.lower(p_target_module_root_id::text)
    loop
      select extension_point.value into point
      from pg_catalog.jsonb_array_elements(target_content -> 'extensionPoints') as extension_point(value)
      where pg_catalog.lower(extension_point.value ->> 'extensionPointId')
        = pg_catalog.lower(contribution ->> 'targetExtensionPointId');
      if point is null
        or pg_catalog.lower(point ->> 'recordTypeId') <> pg_catalog.lower(p_target_record_type_id::text)
        or not (point -> 'accepts') ? 'action' then
        continue;
      end if;
      select action.value into action_definition
      from pg_catalog.jsonb_array_elements(contributor_content -> 'actions') as action(value)
      where pg_catalog.lower(action.value ->> 'actionId') = pg_catalog.lower(contribution ->> 'actionId');
      if action_definition is null then
        continue;
      end if;
      -- The action's behaviour is its compiled transaction flow, which the record service runs.
      select flow.value into action_flow
      from pg_catalog.jsonb_array_elements(coalesce(contributor_content -> 'flows', '[]'::jsonb)) as flow(value)
      where pg_catalog.lower(flow.value ->> 'id') = pg_catalog.lower(contribution ->> 'actionId')
        and flow.value ->> 'execution' = 'transaction';
      if action_flow is null then
        continue;
      end if;
      -- A contributed action is a plain value change: it takes no inputs, runs only
      -- record.set_fields tasks, and sets only fields its own Module contributed to this record
      -- type. Anything else would act on the owner's record beyond what the owner admitted.
      if pg_catalog.jsonb_array_length(coalesce(action_definition -> 'inputs', '[]'::jsonb)) <> 0
        or pg_catalog.jsonb_typeof(action_definition -> 'tasks') is distinct from 'array'
        or pg_catalog.jsonb_array_length(action_definition -> 'tasks') = 0
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements(action_definition -> 'tasks') as task(value)
          where task.value ->> 'type' <> 'record.set_fields'
            or pg_catalog.jsonb_typeof(task.value #> '{properties,values}') is distinct from 'object'
            or exists (
              select 1
              from pg_catalog.jsonb_object_keys(task.value #> '{properties,values}') as set_key(value)
              where pg_catalog.lower(set_key.value) <> all (contributed_field_ids)
            )
        ) then
        continue;
      end if;
      result := result || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind', 'action',
        'contributionId', contribution ->> 'actionId',
        'extensionPointId', contribution ->> 'targetExtensionPointId',
        'contributorModuleRootId', contributor.module_root_id,
        'contributorReleaseRevision', contributor.release_revision,
        'contributorApplicationRootIds', contributor.application_root_ids,
        'action', action_definition,
        'flow', action_flow
      ));
    end loop;
  end loop;
  return result;
end
$function$;

alter function vortex_record.installed_record_type_action_contributions_internal(uuid,uuid,bigint,uuid) owner to vortex_owner;

revoke all on function vortex_record.installed_record_type_action_contributions_internal(uuid, uuid, bigint, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.installed_record_type_action_contributions_internal(uuid, uuid, bigint, uuid)
  to vortex_record_adapter, vortex_owner;

comment on function vortex_record.installed_record_type_action_contributions_internal(uuid, uuid, bigint, uuid) is
  'Private exact installed action contributions of one owner record type in one organisation: the contributor Module''s declared actions, resolved against the extension point of the exact owner release the calling application binds, that take no inputs and only set fields the contributor itself contributed to that record type. Owner-only except for the fixed record adapter; it decides no access.';
