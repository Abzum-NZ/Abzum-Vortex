create or replace function vortex_record.resolve_named_action_context_internal(
  p_action_owner_kind text,
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
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  base_context jsonb;
  context_value jsonb;
  installation jsonb;
  binding_value jsonb;
  release_content jsonb;
  release_validation_version text;
  application_content jsonb;
  action_content jsonb;
  action_owner_content jsonb;
  permission_value jsonb;
  permission_candidates jsonb := '[]'::jsonb;
  permission_keys jsonb;
  permission_key text;
  matched_permission jsonb;
  required_permissions jsonb := '[]'::jsonb;
  named_action_value text;
  event_value jsonb;
  event_descriptor jsonb;
  event_descriptors jsonb := '[]'::jsonb;
  task_value jsonb;
  rules_unsupported boolean := false;
  matched_count integer;
begin
  if p_action_owner_kind is null
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_owner_id = nil_uuid
    or p_action_release_revision is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_action_id is null or p_action_id = nil_uuid
    or p_record_type_id is null or p_record_type_id = nil_uuid then
    raise exception using errcode = '22023', message = 'Named action selector is invalid';
  end if;

  -- This existing fixed resolver owns active installation, target Module,
  -- storage/provision and field-map agreement. It decides no update authority.
  base_context := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, 'update'
  );
  context_value := base_context -> 'context';
  installation := vortex_module.read_current_active_installation();

  if p_action_owner_kind = 'application' then
    if p_action_owner_id <> (context_value ->> 'applicationRootId')::uuid
      or p_action_release_revision <>
        (installation ->> 'applicationReleaseRevision')::bigint then
      raise exception using errcode = '55000', message = 'Named action owner is not installed';
    end if;
    select release.compilation_output #> '{canonical,content}',
      release.validation_contract_version
    into strict action_owner_content, release_validation_version
    from vortex_definition.releases as release
    where release.root_id = p_action_owner_id
      and release.release_revision = p_action_release_revision;
  else
    select item.value into strict binding_value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
    where (item.value ->> 'moduleRootId')::uuid = p_action_owner_id
      and (item.value ->> 'moduleReleaseRevision')::bigint = p_action_release_revision;
    select release.compilation_output #> '{canonical,content}',
      release.validation_contract_version
    into strict action_owner_content, release_validation_version
    from vortex_definition.releases as release
    where release.root_id = p_action_owner_id
      and release.release_revision = p_action_release_revision;
  end if;

  select item.value into strict action_content
  from pg_catalog.jsonb_array_elements(
    coalesce(action_owner_content -> 'actions', '[]'::jsonb)
  ) as item(value)
  where (item.value ->> 'actionId')::uuid = p_action_id
    and (item.value ->> 'subjectRecordTypeId')::uuid = p_record_type_id;

  permission_keys := case when action_content ? 'permissionKeys'
    then action_content -> 'permissionKeys'
    else pg_catalog.jsonb_build_array(action_content -> 'permissionKey') end;
  if pg_catalog.jsonb_typeof(permission_keys) <> 'array'
    or pg_catalog.jsonb_array_length(permission_keys) = 0 then
    raise exception using errcode = '55000', message = 'Named action permission is unavailable';
  end if;

  -- Collect the exact permission declarations of the active pin set. Access
  -- remains authoritative for current registrations, assignments and scopes.
  for binding_value in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  loop
    select release.compilation_output #> '{canonical,content}' into strict release_content
    from vortex_definition.releases as release
    where release.root_id = (binding_value ->> 'moduleRootId')::uuid
      and release.release_revision = (binding_value ->> 'moduleReleaseRevision')::bigint;
    for permission_value in
      select item.value from pg_catalog.jsonb_array_elements(
        coalesce(release_content -> 'permissions', '[]'::jsonb)
      ) as item(value)
      where pg_catalog.jsonb_typeof(item.value -> 'recordScope') = 'object'
    loop
      permission_candidates := permission_candidates || pg_catalog.jsonb_build_array(
        permission_value || pg_catalog.jsonb_build_object(
          'ownerKind', 'module',
          'ownerId', (binding_value ->> 'moduleRootId')::uuid
        )
      );
    end loop;
    -- #578: the owning Module release's rules are evaluated by Record
    -- (`beforeSaveRules`); a rule for the subject in any other release is not.
    if (binding_value ->> 'moduleRootId')::uuid <>
        (base_context ->> 'moduleRootId')::uuid
      and exists (
        select 1 from pg_catalog.jsonb_array_elements(
          coalesce(release_content -> 'rules', '[]'::jsonb)
        ) as item(value)
        where pg_catalog.lower(item.value ->> 'subjectRecordTypeId') =
          pg_catalog.lower(p_record_type_id::text)
      ) then
      rules_unsupported := true;
    end if;
  end loop;

  select release.compilation_output #> '{canonical,content}' into strict application_content
  from vortex_definition.releases as release
  where release.root_id = (context_value ->> 'applicationRootId')::uuid
    and release.release_revision = (installation ->> 'applicationReleaseRevision')::bigint;
  for permission_value in
    select item.value from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'permissions', '[]'::jsonb)
    ) as item(value)
    where pg_catalog.jsonb_typeof(item.value -> 'recordScope') = 'object'
  loop
    permission_candidates := permission_candidates || pg_catalog.jsonb_build_array(
      permission_value || pg_catalog.jsonb_build_object(
        'ownerKind', 'application',
        'ownerId', (context_value ->> 'applicationRootId')::uuid
      )
    );
  end loop;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'rules', '[]'::jsonb)
    ) as item(value)
    where pg_catalog.lower(item.value ->> 'subjectRecordTypeId') =
      pg_catalog.lower(p_record_type_id::text)
  ) then
    rules_unsupported := true;
  end if;

  for permission_key in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(permission_keys) as item(value)
  loop
    select pg_catalog.count(*), pg_catalog.min(item.value::text)::jsonb
    into matched_count, matched_permission
    from pg_catalog.jsonb_array_elements(permission_candidates) as item(value)
    where item.value ->> 'key' = permission_key;
    if matched_count <> 1
      or matched_permission ->> 'actionKind' <> 'named'
      or (matched_permission ->> 'recordTypeId')::uuid <> p_record_type_id
      or (matched_permission ->> 'namedAction') is null then
      raise exception using errcode = '55000', message = 'Named action permission is ambiguous';
    end if;
    if named_action_value is null then
      named_action_value := matched_permission ->> 'namedAction';
    elsif named_action_value is distinct from matched_permission ->> 'namedAction' then
      raise exception using errcode = '55000', message = 'Named action permission alternatives disagree';
    end if;
    required_permissions := required_permissions || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId', (context_value ->> 'applicationRootId')::uuid,
        'ownerKind', matched_permission ->> 'ownerKind',
        'ownerId', (matched_permission ->> 'ownerId')::uuid,
        'permissionId', (matched_permission ->> 'permissionId')::uuid
      )
    );
  end loop;
  select pg_catalog.jsonb_agg(item.value order by
    item.value ->> 'ownerKind' collate "C",
    item.value ->> 'ownerId' collate "C",
    item.value ->> 'permissionId' collate "C")
  into required_permissions
  from pg_catalog.jsonb_array_elements(required_permissions) as item(value);

  for task_value in
    select item.value from pg_catalog.jsonb_array_elements(action_content -> 'tasks')
      with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    if task_value ->> 'type' <> 'event.announce' then continue; end if;
    select item.value into strict event_value
    from pg_catalog.jsonb_array_elements(
      coalesce(action_owner_content -> 'events', '[]'::jsonb)
    ) as item(value)
    where item.value ->> 'key' = task_value #>> '{properties,eventKey}'
      and (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
    event_descriptor := pg_catalog.jsonb_build_object(
      'kind', 'declared',
      'owner', case when p_action_owner_kind = 'application'
        then pg_catalog.jsonb_build_object(
          'kind', 'application', 'applicationRootId', p_action_owner_id
        )
        else pg_catalog.jsonb_build_object(
          'kind', 'module', 'moduleRootId', p_action_owner_id
        ) end,
      'declarationId', event_value -> 'eventId',
      'key', event_value -> 'key',
      'recordTypeId', event_value -> 'recordTypeId',
      'carriedFieldIds', event_value -> 'carriedFieldIds'
    );
    event_descriptors := event_descriptors || pg_catalog.jsonb_build_array(event_descriptor);
  end loop;

  return base_context || pg_catalog.jsonb_build_object(
    'actionOwner', pg_catalog.jsonb_build_object(
      'ownerKind', p_action_owner_kind,
      'ownerId', p_action_owner_id,
      'releaseRevision', p_action_release_revision
    ),
    'action', action_content,
    -- Action values follow the subject Record's owning Module contract. An
    -- Application version cannot reinterpret exact Module field values.
    'validationContractVersion', (
      select release.validation_contract_version
      from vortex_definition.releases as release
      where release.root_id = (base_context ->> 'moduleRootId')::uuid
        and release.release_revision = (base_context ->> 'moduleReleaseRevision')::bigint
    ),
    'eventDescriptors', event_descriptors,
    'rulesUnsupported', rules_unsupported,
    'declaration', pg_catalog.jsonb_build_object(
      'operationKey', action_content -> 'key',
      'action', pg_catalog.jsonb_build_object(
        'actionKind', 'named', 'namedAction', named_action_value
      ),
      'target', pg_catalog.jsonb_build_object(
        'kind', 'application',
        'applicationRootId', (context_value ->> 'applicationRootId')::uuid
      ),
      'requiredPermissions', required_permissions,
      'recordBinding', pg_catalog.jsonb_build_object(
        'moduleRootId', (base_context ->> 'moduleRootId')::uuid,
        'recordTypeId', p_record_type_id,
        'storageContractId', (base_context ->> 'storageContractId')::uuid,
        'storageScope', base_context ->> 'storageScope'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  );
exception
  when no_data_found then
    raise exception using errcode = '55000', message = 'Installed named action is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Installed named action is ambiguous';
end
$function$;

revoke all on function vortex_record.resolve_named_action_context_internal(
  text, uuid, bigint, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.resolve_named_action_context_internal(
  text, uuid, bigint, uuid, uuid
) to vortex_record_adapter;

comment on function vortex_record.resolve_named_action_context_internal(
  text, uuid, bigint, uuid, uuid
) is
  'Private exact active installed action, permission-alternative and declared-Event resolver for protected named actions.';
