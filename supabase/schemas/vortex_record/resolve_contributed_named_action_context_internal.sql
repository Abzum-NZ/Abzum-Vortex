create or replace function vortex_record.resolve_contributed_named_action_context_internal(
  p_base_context jsonb,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  contribution jsonb;
  action_content jsonb;
  permission_keys jsonb;
  set_field_ids jsonb;
  declaration jsonb;
begin
  -- A contributed action belongs to a Module installed beside this application, so it is found
  -- only among the installed contributions of this exact record type, by the contributor's exact
  -- release and the action's permanent identity.
  select entry.value into contribution
  from pg_catalog.jsonb_array_elements(
    vortex_record.installed_record_type_action_contributions_internal(
      (p_base_context #>> '{context,organizationId}')::uuid,
      (p_base_context ->> 'moduleRootId')::uuid,
      p_record_type_id
    )
  ) as entry(value)
  where (entry.value ->> 'contributorModuleRootId')::uuid = p_action_owner_id
    and (entry.value ->> 'contributorReleaseRevision')::bigint = p_action_release_revision
    and (entry.value ->> 'contributionId')::uuid = p_action_id;
  if contribution is null then
    raise exception using errcode = '55000', message = 'Named action owner is not installed';
  end if;

  -- The owner's own update declaration is the target authority: the person must be allowed to
  -- change this exact owner record. The contributor's named permission is a second requirement,
  -- decided by the same eligibility core.
  declaration := p_base_context -> 'declaration';
  if declaration is null or declaration #>> '{authority,kind}' is distinct from 'permission' then
    raise exception using errcode = '55000', message = 'Named action permission is unavailable';
  end if;
  action_content := (contribution -> 'action')
    || pg_catalog.jsonb_build_object('subjectRecordTypeId', p_record_type_id);
  permission_keys := case when action_content ? 'permissionKeys'
    then action_content -> 'permissionKeys'
    else pg_catalog.jsonb_build_array(action_content -> 'permissionKey') end;
  if pg_catalog.jsonb_typeof(permission_keys) <> 'array'
    or pg_catalog.jsonb_array_length(permission_keys) = 0 then
    raise exception using errcode = '55000', message = 'Named action permission is unavailable';
  end if;
  select coalesce(pg_catalog.jsonb_agg(distinct pg_catalog.lower(set_key.value)), '[]'::jsonb)
  into set_field_ids
  from pg_catalog.jsonb_array_elements(action_content -> 'tasks') as task(value)
  cross join lateral pg_catalog.jsonb_object_keys(task.value #> '{properties,values}') as set_key(value);

  return p_base_context || pg_catalog.jsonb_build_object(
    'actionOwner', pg_catalog.jsonb_build_object(
      'ownerKind', 'module',
      'ownerId', p_action_owner_id,
      'releaseRevision', p_action_release_revision
    ),
    'action', action_content,
    'validationContractVersion', (
      select release.validation_contract_version
      from vortex_definition.releases as release
      where release.root_id = (p_base_context ->> 'moduleRootId')::uuid
        and release.release_revision = (p_base_context ->> 'moduleReleaseRevision')::bigint
    ),
    'eventDescriptors', '[]'::jsonb,
    'declaration', declaration || pg_catalog.jsonb_build_object(
      'contributorRequirements', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'moduleRootId', p_action_owner_id,
          'applicationRootIds', contribution -> 'contributorApplicationRootIds',
          'recordTypeId', action_content ->> 'subjectRecordTypeId',
          'permissionKeys', permission_keys,
          'changeableFieldIds', set_field_ids
        )
      )
    )
  );
end
$function$;

alter function vortex_record.resolve_contributed_named_action_context_internal(jsonb,uuid,bigint,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.resolve_contributed_named_action_context_internal(
  jsonb, uuid, bigint, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.resolve_contributed_named_action_context_internal(
  jsonb, uuid, bigint, uuid, uuid
) to vortex_record_adapter;

comment on function vortex_record.resolve_contributed_named_action_context_internal(
  jsonb, uuid, bigint, uuid, uuid
) is
  'Private exact installed contributed-action resolver for protected named actions: the contributor''s action re-bound to the owner record type under the owner''s own update declaration, with the contributor''s named permission as a second requirement.';
