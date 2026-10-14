set local role vortex_owner;

alter table vortex_definition.releases
  add column application_experience jsonb;

alter table vortex_definition.releases disable trigger releases_append_only;

update vortex_definition.releases as release
set application_experience = pg_catalog.jsonb_build_object(
  'experiences', coalesce(
    release.compilation_output #> '{canonical,content,experiences}', '[]'::jsonb
  ),
  'resolvedExperiences', case
    when pg_catalog.jsonb_typeof(
      release.compilation_output #> '{canonical,content,experiences}'
    ) = 'array' then coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'state', experience.value ->> 'state', 'page', page.value
        ) order by experience.value ->> 'state' collate "C"
      )
      from pg_catalog.jsonb_array_elements(
        release.compilation_output #> '{canonical,content,experiences}'
      ) as experience(value)
      join pg_catalog.jsonb_array_elements(
        release.compilation_output #> '{canonical,content,pages}'
      ) as page(value)
        on page.value ->> 'pageId' = experience.value ->> 'pageId'
    ), '[]'::jsonb)
    else '[]'::jsonb
  end,
  'shells', release.compilation_output #> '{canonical,content,shells}',
  'theme', release.compilation_output #> '{canonical,content,theme}'
)
where release.application_address ->> 'kind' = 'application';

alter table vortex_definition.releases enable trigger releases_append_only;

alter table vortex_definition.releases
  add constraint releases_application_experience_object
  check (
    compilation_output ->> 'kind' is distinct from 'application'
    or (
      application_experience is not null
      and pg_catalog.jsonb_typeof(application_experience) = 'object'
      and pg_catalog.jsonb_typeof(application_experience -> 'resolvedExperiences') = 'array'
    )
  );

create or replace function vortex_definition.append_release(
  p_root_id uuid,
  p_expected_draft_revision bigint,
  p_expected_source_fingerprint text,
  p_release jsonb
)
returns table (
  root_id uuid,
  release_revision bigint,
  release_version text,
  content_fingerprint text,
  resolution_fingerprint text,
  dependency_manifest jsonb,
  published_at timestamptz,
  published_by uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  human_publication boolean;
  original_context jsonb;
  locked_access_version bigint;
  permission_key text;
  permission_id uuid;
  permission_decision record;
  checked_at timestamptz;
  permission_deadline timestamptz;
  context_organization_id uuid;
  context_actor_id uuid;
  operation_at timestamptz := pg_catalog.statement_timestamp();
  root_row vortex_definition.roots%rowtype;
  draft_row vortex_definition.drafts%rowtype;
  supplied_dependency jsonb;
  supplied_kind text;
  supplied_reference text;
  supplied_version text;
  supplied_content_fingerprint text;
  supplied_target_root_id uuid;
  supplied_target_release_revision bigint;
  supplied_catalogue_item_id uuid;
  supplied_entry jsonb;
  supplied_owner_kind text;
  supplied_owner_id_key text;
  supplied_expected_keys text[];
  dependency_count integer := 0;
  inserted_dependency_count integer := 0;
  expected_history_revision bigint;
  release_version_value text;
  compilation_output_value jsonb;
  application_address_value jsonb;
  application_experience_value jsonb;
  resolution_snapshot_value jsonb;
  content_fingerprint_value text;
  resolution_fingerprint_value text;
  validation_contract_version_value text;
  impact_reasons_value jsonb;
  release_note_value text;
  dependency_manifest_value jsonb;
  permissions_value jsonb;
begin
  human_publication := vortex_platform.current_context() ->> 'callerKind' = 'human';
  if human_publication then
    checked_context := vortex_access.validated_human_request_context();
    if checked_context ->> 'callerKind' is distinct from 'human'
      or checked_context ? 'applicationRootId'
      or checked_context ? 'delegatedContext' or checked_context ? 'supportContext' then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
    original_context := checked_context;
    permission_deadline := (checked_context ->> 'expiresAt')::timestamptz;
    -- Access precedes root/draft locks, as in ordinary draft creation and saving.
    select version.current_version into locked_access_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = (checked_context ->> 'organizationId')::uuid
    for update;
    if not found or locked_access_version
      is distinct from (checked_context ->> 'accessVersion')::bigint then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
  else
    checked_context := vortex_definition.validated_system_context();
  end if;
  context_organization_id := (checked_context ->> 'organizationId')::uuid;
  context_actor_id := case when human_publication
    then (checked_context ->> 'organizationAccountId')::uuid
    else (checked_context ->> 'systemActorId')::uuid end;

  if human_publication then
    foreach permission_key in array array[
      'platform.organization.definition_drafts.manage',
      'platform.organization.definition_releases.manage'
    ] loop
      permission_id := case permission_key
        when 'platform.organization.definition_drafts.manage'
          -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
          then '0548c061-b1a9-48e5-a04a-eb1d0dae0644'::uuid
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        else 'dfdd5aba-2b85-4169-b570-92be284e7b5c'::uuid
      end;
      select evaluated.* into strict permission_decision
      from vortex_access.evaluate_organization_permission_eligibility(
        pg_catalog.jsonb_build_object(
          'operationKey', permission_key,
          'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
          'target', pg_catalog.jsonb_build_object('kind', 'organization'),
          'requiredPermission', pg_catalog.jsonb_build_object(
            -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
            'ownerKind', 'platform', 'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
            'permissionId', permission_id
          ),
          'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
          'authority', pg_catalog.jsonb_build_object('kind', 'permission')
        )
      ) as evaluated;
      checked_at := pg_catalog.clock_timestamp();
      if permission_decision.outcome is distinct from 'eligible'
        or permission_decision.operation_key is distinct from permission_key
        or permission_decision.target_kind is distinct from 'organization'
        or permission_decision.target_application_root_id is not null
        or permission_decision.reason_code is not null
        or permission_decision.organization_id
          is distinct from (checked_context ->> 'organizationId')::uuid
        or permission_decision.organization_account_id
          is distinct from (checked_context ->> 'organizationAccountId')::uuid
        or permission_decision.access_version is distinct from locked_access_version
        or permission_decision.correlation_id
          is distinct from (checked_context ->> 'correlationId')::uuid
        or permission_decision.checked_at is null or permission_decision.checked_at > checked_at
        or permission_decision.valid_until is null or permission_decision.valid_until <= checked_at
        or (checked_context ->> 'issuedAt')::timestamptz > checked_at
        or (checked_context ->> 'expiresAt')::timestamptz <= checked_at then
        raise exception using errcode = '42501',
          message = 'Definition publication authority is unavailable';
      end if;
      permission_deadline := least(permission_deadline, permission_decision.valid_until);
    end loop;
    if permission_deadline <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
  end if;

  if p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_expected_source_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or pg_catalog.jsonb_typeof(p_release) is distinct from 'object'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_release) as supplied(key)
      where supplied.key not in (
        'releaseVersion', 'compilationOutput', 'resolutionSnapshot', 'contentFingerprint',
        'resolutionFingerprint', 'validationContractVersion',
        'impactReasons', 'releaseNote', 'dependencies'
      )
    )
    or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(p_release)
    ) <> 9 then
    raise exception using
      errcode = '22023',
      message = 'Definition release append has an invalid request shape';
  end if;

  release_version_value := p_release ->> 'releaseVersion';
  compilation_output_value := p_release -> 'compilationOutput';
  resolution_snapshot_value := p_release -> 'resolutionSnapshot';
  content_fingerprint_value := p_release ->> 'contentFingerprint';
  resolution_fingerprint_value := p_release ->> 'resolutionFingerprint';
  validation_contract_version_value := p_release ->> 'validationContractVersion';
  impact_reasons_value := p_release -> 'impactReasons';
  release_note_value := p_release ->> 'releaseNote';
  dependency_manifest_value := p_release -> 'dependencies';

  if release_version_value !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or pg_catalog.jsonb_typeof(compilation_output_value) is distinct from 'object'
    or pg_catalog.jsonb_typeof(resolution_snapshot_value) is distinct from 'object'
    or content_fingerprint_value !~ '^sha256:[a-f0-9]{64}$'
    or resolution_fingerprint_value !~ '^sha256:[a-f0-9]{64}$'
    or validation_contract_version_value !~
      '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$'
    or pg_catalog.jsonb_typeof(impact_reasons_value) is distinct from 'array'
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(impact_reasons_value) as reason(value)
      where pg_catalog.jsonb_typeof(reason.value) is distinct from 'object'
    )
    or release_note_value is null
    or release_note_value <> pg_catalog.btrim(release_note_value)
    or pg_catalog.char_length(release_note_value) not between 1 and 2000
    or pg_catalog.jsonb_typeof(dependency_manifest_value) is distinct from 'array'
    or pg_catalog.jsonb_array_length(dependency_manifest_value) > 10000 then
    raise exception using
      errcode = '22023',
      message = 'Definition release append has invalid release evidence';
  end if;

  select root.* into root_row
  from vortex_definition.roots as root
  where root.root_id = p_root_id
  for update;

  if not found then
    return;
  end if;

  select draft.* into draft_row
  from vortex_definition.drafts as draft
  where draft.root_id = p_root_id
  for update;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'A Definition root requires its current draft';
  end if;

  if root_row.organization_id <> context_organization_id then
    raise exception using
      errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;

  if human_publication and (root_row.kind not in ('application', 'module')
    or (root_row.kind = 'application'
      and root_row.application_origin_kind is distinct from 'ordinary')) then
    raise exception using errcode = '42501',
      message = 'Definition publication authority is unavailable';
  end if;

  if compilation_output_value ->> 'kind' is distinct from root_row.kind
    or compilation_output_value -> 'canonical' -> 'envelope' ->> 'kind' is distinct from root_row.kind
    or compilation_output_value -> 'canonical' -> 'envelope' ->> 'key' is distinct from root_row.key
    or compilation_output_value -> 'canonical' -> 'envelope' ->> 'rootId' is distinct from p_root_id::text
    or compilation_output_value -> 'canonical' -> 'envelope' ->> 'organizationId'
      is distinct from root_row.organization_id::text then
    raise exception using
      errcode = '23514',
      message = 'Definition canonical release content does not belong to the locked root';
  end if;

  if compilation_output_value ->> 'resolutionFingerprint' is distinct from resolution_fingerprint_value
    or compilation_output_value -> 'artifact' ->> 'kind' is distinct from root_row.kind
    or compilation_output_value -> 'artifact' ->> 'rootId' is distinct from p_root_id::text
    or compilation_output_value -> 'artifact' ->> 'definitionKey' is distinct from root_row.key
    or compilation_output_value -> 'artifact' ->> 'exactVersion' is distinct from release_version_value
    or compilation_output_value -> 'artifact' ->> 'contentFingerprint'
      is distinct from content_fingerprint_value
    or compilation_output_value -> 'artifact' ->> 'resolutionFingerprint'
      is distinct from resolution_fingerprint_value then
    raise exception using
      errcode = '23514',
      message = 'Definition compilation output does not match immutable release evidence';
  end if;

  if resolution_snapshot_value ->> 'fingerprint' is distinct from resolution_fingerprint_value
    or pg_catalog.jsonb_typeof(resolution_snapshot_value -> 'definitions') is distinct from 'array'
    or not exists (
      select 1
      from pg_catalog.jsonb_array_elements(resolution_snapshot_value -> 'definitions') as definition(value)
      where definition.value ->> 'kind' = root_row.kind
        and definition.value ->> 'key' = root_row.key
        and definition.value ->> 'rootId' = p_root_id::text
        and definition.value ->> 'exactVersion' = release_version_value
    ) then
    raise exception using
      errcode = '23514',
      message = 'Definition resolution snapshot does not match release evidence';
  end if;

  if draft_row.draft_revision <> p_expected_draft_revision
    or draft_row.source_fingerprint <> p_expected_source_fingerprint then
    raise exception using
      errcode = '40001',
      message = 'Definition release append is stale or source evidence was substituted';
  end if;

  expected_history_revision := root_row.current_release_revision;
  if expected_history_revision is null then
    if exists (select 1 from vortex_definition.releases as release where release.root_id = p_root_id) then
      raise exception using errcode = '23514', message = 'Definition root current release pointer does not match immutable release history';
    end if;
  elsif not exists (
    select 1 from vortex_definition.releases as release
    where release.root_id = p_root_id and release.release_revision = expected_history_revision
  ) or exists (
    select 1 from vortex_definition.releases as release
    where release.root_id = p_root_id and release.release_revision > expected_history_revision
  ) then
    raise exception using errcode = '23514', message = 'Definition root current release pointer does not match immutable release history';
  end if;

  if root_row.current_release_revision is distinct from expected_history_revision then
    raise exception using
      errcode = '23514',
      message = 'Definition root current release pointer does not match immutable release history';
  end if;


  if exists (
    select 1
    from vortex_definition.releases as release
    where release.root_id = p_root_id
      and release.release_revision = draft_row.draft_revision
  ) then
    raise exception using
      errcode = '23505',
      message = 'Definition draft revision is already published';
  end if;

  for supplied_dependency in
    select item.value
    from pg_catalog.jsonb_array_elements(dependency_manifest_value) as item(value)
  loop
    dependency_count := dependency_count + 1;
    if pg_catalog.jsonb_typeof(supplied_dependency) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Definition dependency has an invalid shape';
    end if;

    supplied_kind := supplied_dependency ->> 'kind';
    if supplied_kind = 'module' then
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
        where supplied.key not in (
          'kind', 'key', 'rootId', 'releaseRevision', 'releaseVersion',
          'contentFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 6 then
        raise exception using errcode = '22023', message = 'Module dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'key';
      supplied_target_root_id := (supplied_dependency ->> 'rootId')::uuid;
      supplied_target_release_revision := (supplied_dependency ->> 'releaseRevision')::bigint;
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_catalogue_item_id := null;
      if supplied_reference !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
        or pg_catalog.char_length(supplied_reference) not between 3 and 120
        or supplied_target_root_id is null
        or supplied_target_root_id = '00000000-0000-0000-0000-000000000000'::uuid
        or supplied_target_release_revision not between 1 and 9007199254740991
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or supplied_target_root_id = p_root_id
        or not exists (
          select 1
          from vortex_definition.releases as target_release
          join vortex_definition.roots as target_root on target_root.root_id = target_release.root_id
          where target_release.root_id = supplied_target_root_id
            and target_release.release_revision = supplied_target_release_revision
            and target_release.release_version = supplied_version
            and target_release.content_fingerprint = supplied_content_fingerprint
            and target_root.organization_id = context_organization_id
            and target_root.kind = 'module'
            and target_root.key = supplied_reference
        ) then
        raise exception using errcode = '23514', message = 'Module dependency does not identify an exact same-organization module release';
      end if;
    elsif supplied_kind = 'connection_type' then
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
        where supplied.key not in (
          'kind', 'key', 'rootId', 'releaseVersion', 'contentFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 5 then
        raise exception using errcode = '22023', message = 'Connection type dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'key';
      supplied_catalogue_item_id := (supplied_dependency ->> 'rootId')::uuid;
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      if supplied_reference !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
        or pg_catalog.char_length(supplied_reference) not between 3 and 120
        or supplied_catalogue_item_id is null
        or supplied_catalogue_item_id = '00000000-0000-0000-0000-000000000000'::uuid
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
        raise exception using errcode = '22023', message = 'Connection type dependency has invalid evidence';
      end if;
    elsif supplied_kind = 'platform_block' then
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
        where supplied.key not in (
          'kind', 'blockId', 'releaseVersion', 'contentFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 4 then
        raise exception using errcode = '22023', message = 'Platform block dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'blockId';
      supplied_catalogue_item_id := case
        when supplied_reference ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then supplied_reference::uuid
        else null
      end;
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      if supplied_catalogue_item_id is null
        or supplied_catalogue_item_id = '00000000-0000-0000-0000-000000000000'::uuid
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
        raise exception using errcode = '22023', message = 'Platform block dependency has invalid evidence';
      end if;
    elsif supplied_kind = 'platform_theme' then
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
        where supplied.key not in (
          'kind', 'catalogueThemeId', 'releaseVersion', 'contentFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 4 then
        raise exception using errcode = '22023', message = 'Platform theme dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'catalogueThemeId';
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      supplied_catalogue_item_id := null;
      if supplied_reference !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or supplied_reference = '00000000-0000-0000-0000-000000000000'
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
        raise exception using errcode = '22023', message = 'Platform theme dependency has invalid evidence';
      end if;
    elsif supplied_kind in (
      'application_flow', 'application_flow_node', 'application_query',
      'module_query', 'application_form', 'application_workflow', 'application_action',
      'protected_operation'
    ) then
      -- Flow targets are contained by, or pinned for, one exact Application
      -- release. Each entry has exactly its contract shape, and its owner is
      -- this release, an exact pinned Module release in this same manifest, or
      -- a protected platform service operation verified before append.
      if root_row.kind is distinct from 'application' then
        raise exception using errcode = '23514',
          message = 'Flow target dependencies belong only to an Application release';
      end if;
      supplied_owner_kind := case supplied_kind
        when 'protected_operation' then supplied_dependency #>> '{operation,owner,kind}'
        when 'module_query' then 'module'
        else 'application'
      end;
      supplied_expected_keys := pg_catalog.array_cat(
        array['kind', 'releaseVersion', 'contentFingerprint']::text[],
        case supplied_kind
          when 'application_flow' then
            array['applicationRootId', 'flowId', 'resolutionFingerprint']::text[]
          when 'application_flow_node' then
            array[
              'applicationRootId', 'flowId', 'nodeId', 'operations', 'grantable',
              'resolutionFingerprint'
            ]::text[]
          when 'application_query' then
            array['applicationRootId', 'queryId', 'resolutionFingerprint']::text[]
          when 'module_query' then
            array['moduleRootId', 'queryId', 'declaredRequirement', 'resolutionFingerprint']::text[]
          when 'application_form' then
            array['applicationRootId', 'formId', 'resolutionFingerprint']::text[]
          when 'application_workflow' then
            array['applicationRootId', 'workflowId', 'resolutionFingerprint']::text[]
          when 'application_action' then
            array['applicationRootId', 'actionId', 'resolutionFingerprint']::text[]
          when 'protected_operation' then array['operation', 'resolutionFingerprint']::text[]
        end
      );
      if exists (
          select 1
          from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
          where supplied.key <> all (supplied_expected_keys)
        )
        or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency))
          <> pg_catalog.cardinality(supplied_expected_keys)
        or exists (
          select 1
          from pg_catalog.unnest(supplied_expected_keys) as expected(key)
          where expected.key not in (
            'operation', 'declaredRequirement', 'operations', 'grantable'
          )
            and pg_catalog.jsonb_typeof(supplied_dependency -> expected.key) is distinct from 'string'
        )
        or (
          supplied_kind = 'module_query'
          and pg_catalog.jsonb_typeof(supplied_dependency -> 'declaredRequirement')
            is distinct from 'object'
        )
        or (
          supplied_kind = 'protected_operation'
          and (
            pg_catalog.jsonb_typeof(supplied_dependency -> 'operation') is distinct from 'object'
            or pg_catalog.jsonb_typeof(supplied_dependency #> '{operation,owner}')
              is distinct from 'object'
            or supplied_owner_kind is null
            or supplied_owner_kind not in ('application', 'module', 'platform_service')
          )
        )
        or (
          supplied_kind = 'application_flow_node'
          and (
            pg_catalog.jsonb_typeof(supplied_dependency -> 'operations') is distinct from 'array'
            or pg_catalog.jsonb_typeof(supplied_dependency -> 'grantable') is distinct from 'boolean'
          )
        ) then
        raise exception using errcode = '22023',
          message = 'Definition flow target dependency has an invalid shape';
      end if;
      if supplied_kind = 'protected_operation' then
        supplied_owner_id_key := case supplied_owner_kind
          when 'application' then 'applicationRootId'
          when 'module' then 'moduleRootId'
          else 'serviceId'
        end;
        if exists (
            select 1
            from pg_catalog.jsonb_object_keys(supplied_dependency -> 'operation') as operation_key(key)
            where operation_key.key not in ('owner', 'operationId')
          )
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency -> 'operation')) <> 2
          or pg_catalog.jsonb_typeof(supplied_dependency #> '{operation,operationId}')
            is distinct from 'string'
          or exists (
            select 1
            from pg_catalog.jsonb_object_keys(supplied_dependency #> '{operation,owner}') as owner_key(key)
            where owner_key.key not in ('kind', supplied_owner_id_key)
          )
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency #> '{operation,owner}')) <> 2
          or pg_catalog.jsonb_typeof(
            supplied_dependency -> 'operation' -> 'owner' -> supplied_owner_id_key
          ) is distinct from 'string' then
          raise exception using errcode = '22023',
            message = 'Definition flow target dependency has an invalid shape';
        end if;
      end if;

      if supplied_kind = 'application_flow_node' then
        if (supplied_dependency ->> 'grantable')::boolean is distinct from
            (pg_catalog.jsonb_array_length(supplied_dependency -> 'operations') > 0) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation references have an invalid grantability shape';
        end if;

        if exists (
          select 1
          from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations') as operation(value)
          where pg_catalog.jsonb_typeof(operation.value) is distinct from 'object'
            or pg_catalog.jsonb_typeof(operation.value -> 'owner') is distinct from 'object'
            or pg_catalog.jsonb_typeof(operation.value -> 'operationId') is distinct from 'string'
            or pg_catalog.jsonb_typeof(operation.value #> '{owner,kind}') is distinct from 'string'
        ) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation reference has an invalid shape';
        end if;

        if exists (
          select 1
          from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations') as operation(value)
          where (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(operation.value)) <> 2
            or exists (
              select 1
              from pg_catalog.jsonb_object_keys(operation.value) as operation_key(key)
              where operation_key.key not in ('owner', 'operationId')
            )
            or operation.value #>> '{owner,kind}' not in ('application', 'module')
            or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(operation.value -> 'owner')) <> 2
            or exists (
              select 1
              from pg_catalog.jsonb_object_keys(operation.value -> 'owner') as owner_key(key)
              where owner_key.key not in (
                'kind',
                case operation.value #>> '{owner,kind}'
                  when 'application' then 'applicationRootId'
                  else 'moduleRootId'
                end
              )
            )
            or pg_catalog.jsonb_typeof(
              operation.value -> 'owner' -> case operation.value #>> '{owner,kind}'
                when 'application' then 'applicationRootId'
                else 'moduleRootId'
              end
            ) is distinct from 'string'
        ) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation reference has an invalid owner shape';
        end if;

        if exists (
          select 1
          from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations') as operation(value)
          cross join lateral (
            select case operation.value #>> '{owner,kind}'
              when 'application' then operation.value #>> '{owner,applicationRootId}'
              else operation.value #>> '{owner,moduleRootId}'
            end as owner_id
          ) as owner
          where owner.owner_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            or owner.owner_id = '00000000-0000-0000-0000-000000000000'
            or (operation.value ->> 'operationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            or operation.value ->> 'operationId' = '00000000-0000-0000-0000-000000000000'
        ) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation reference has an invalid identifier';
        end if;

        if exists (
          select 1
          from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations') as operation(value)
          cross join lateral (
            select case operation.value #>> '{owner,kind}'
              when 'application' then operation.value #>> '{owner,applicationRootId}'
              else operation.value #>> '{owner,moduleRootId}'
            end as owner_id
          ) as owner
          where (
              operation.value #>> '{owner,kind}' = 'application'
              and owner.owner_id is distinct from p_root_id::text
            )
            or (
              operation.value #>> '{owner,kind}' = 'module'
              and not exists (
                select 1
                from pg_catalog.jsonb_array_elements(dependency_manifest_value) as pinned(value)
                where pinned.value ->> 'kind' = 'module'
                  and pg_catalog.lower(pinned.value ->> 'rootId') = owner.owner_id
              )
            )
        ) then
          raise exception using errcode = '23514',
            message = 'Definition flow node operation reference does not belong to this release or a pinned Module';
        end if;

        if exists (
          select 1
          from (
            select
              pg_catalog.lag(ordered.reference_key) over (order by ordered.ordinality) as previous_reference_key,
              ordered.reference_key
            from (
              select
                operation.ordinality,
                (operation.value #>> '{owner,kind}') || ':' ||
                  case operation.value #>> '{owner,kind}'
                    when 'application' then operation.value #>> '{owner,applicationRootId}'
                    else operation.value #>> '{owner,moduleRootId}'
                  end || ':' || (operation.value ->> 'operationId') as reference_key
              from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations')
                with ordinality as operation(value, ordinality)
            ) as ordered
          ) as adjacent
          where adjacent.previous_reference_key is not null
            and adjacent.previous_reference_key collate "C" >= adjacent.reference_key collate "C"
        ) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation references must be unique and canonically sorted';
        end if;
      end if;

      supplied_reference := vortex_definition.flow_target_dependency_reference(supplied_dependency);
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      supplied_catalogue_item_id := null;
      if supplied_reference is null
        or pg_catalog.char_length(supplied_reference) not between 1 and 500
        or supplied_reference ~ '[[:space:]]'
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or (
          supplied_dependency ? 'resolutionFingerprint'
          and supplied_dependency ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
        ) then
        raise exception using errcode = '22023',
          message = 'Definition flow target dependency has invalid evidence';
      end if;

      if (
          supplied_owner_kind = 'application'
          and (
            case when supplied_kind = 'protected_operation'
              then supplied_dependency #>> '{operation,owner,applicationRootId}'
              else supplied_dependency ->> 'applicationRootId'
            end is distinct from p_root_id::text
            or supplied_version is distinct from release_version_value
            or supplied_dependency ->> 'resolutionFingerprint'
              is distinct from resolution_fingerprint_value
          )
        )
        or (
          supplied_owner_kind = 'module'
          and not exists (
            select 1
            from pg_catalog.jsonb_array_elements(dependency_manifest_value) as pinned(value)
            where pinned.value ->> 'kind' = 'module'
              and pinned.value ->> 'rootId' = case when supplied_kind = 'protected_operation'
                then supplied_dependency #>> '{operation,owner,moduleRootId}'
                else supplied_dependency ->> 'moduleRootId'
              end
              and pinned.value ->> 'releaseVersion' = supplied_version
              and pinned.value ->> 'resolutionFingerprint' =
                supplied_dependency ->> 'resolutionFingerprint'
          )
        ) then
        raise exception using errcode = '23514',
          message = 'Flow target dependency does not identify this release or an exact pinned module release';
      end if;
    else
      raise exception using errcode = '22023', message = 'Definition dependency has an unknown kind';
    end if;

    if exists (
      select 1
      from vortex_definition.release_dependencies as existing
      where existing.root_id = p_root_id
        and existing.release_revision = draft_row.draft_revision
        and existing.dependency_kind = supplied_kind
        and existing.dependency_reference = supplied_reference
        and (
          supplied_kind <> 'platform_block'
          or existing.dependency_version = supplied_version
        )
    ) then
      raise exception using errcode = '23505', message = 'Definition dependency manifest repeats a subject';
    end if;
  end loop;

  if exists (
    select 1
    from (
      select
        supplied.value ->> 'kind' as dependency_kind,
        case supplied.value ->> 'kind'
          when 'platform_theme' then supplied.value ->> 'catalogueThemeId'
          when 'platform_block' then
            (supplied.value ->> 'blockId') || '@' || (supplied.value ->> 'releaseVersion')
          when 'module' then supplied.value ->> 'key'
          when 'connection_type' then supplied.value ->> 'key'
          else vortex_definition.flow_target_dependency_reference(supplied.value)
        end as dependency_reference,
        pg_catalog.count(*) as duplicate_count
      from pg_catalog.jsonb_array_elements(dependency_manifest_value) as supplied(value)
      group by 1, 2
    ) as grouped
    where grouped.dependency_reference is null or grouped.duplicate_count <> 1
  ) then
    raise exception using errcode = '22023', message = 'Definition dependency manifest repeats or omits a subject';
  end if;

  -- Field policy is an immutable part of a newly published permission. Validate
  -- it at the one supported release-write boundary so trusted callers cannot
  -- store a release the compiler would refuse. Existing releases are untouched.
  if root_row.kind in ('module', 'application') then
    permissions_value := coalesce(
      compilation_output_value #> '{canonical,content,permissions}',
      '[]'::jsonb
    );

    if pg_catalog.jsonb_typeof(permissions_value) is distinct from 'array' then
      raise exception using
        errcode = '23514',
        message = 'Definition release permissions are unavailable for field-policy validation';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(permissions_value) as permission(value)
      where (
        permission.value ->> 'recordTypeId' is null
        and permission.value ? 'fieldPolicy'
      ) or (
        permission.value ->> 'recordTypeId' is not null
        and (
          not permission.value ? 'fieldPolicy'
          or not vortex_access.permission_field_policy_is_valid(
            permission.value -> 'fieldPolicy'
          )
        )
      )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Definition release field policy has invalid record ownership or shape';
    end if;

    if exists (
      with module_record_types as (
        select record_type.value
        from pg_catalog.jsonb_array_elements(
          case
            when root_row.kind = 'module'
              and pg_catalog.jsonb_typeof(
                compilation_output_value #> '{canonical,content,recordTypes}'
              ) = 'array'
            then compilation_output_value #> '{canonical,content,recordTypes}'
            else '[]'::jsonb
          end
        ) as record_type(value)
      ), pinned_module_record_types as (
        select record_type.value
        from pg_catalog.jsonb_array_elements(dependency_manifest_value) as dependency(value)
        join vortex_definition.releases as module_release
          on module_release.root_id = (dependency.value ->> 'rootId')::uuid
          and module_release.release_revision =
            (dependency.value ->> 'releaseRevision')::bigint
        cross join lateral pg_catalog.jsonb_array_elements(
          case
            when pg_catalog.jsonb_typeof(
              module_release.compilation_output #> '{canonical,content,recordTypes}'
            ) = 'array'
            then module_release.compilation_output #> '{canonical,content,recordTypes}'
            else '[]'::jsonb
          end
        ) as record_type(value)
        where root_row.kind = 'application'
          and dependency.value ->> 'kind' = 'module'
      ), available_record_types as (
        select value from module_record_types
        union all
        select value from pinned_module_record_types
      ), available_record_type_counts as (
        select
          pg_catalog.lower(record_type.value ->> 'recordTypeId') as record_type_id,
          pg_catalog.count(*) as record_type_count
        from available_record_types as record_type(value)
        group by pg_catalog.lower(record_type.value ->> 'recordTypeId')
      ), available_fields as (
        select
          pg_catalog.lower(record_type.value ->> 'recordTypeId') as record_type_id,
          pg_catalog.lower(field.value ->> 'fieldId') as field_id
        from available_record_types as record_type(value)
        cross join lateral pg_catalog.jsonb_array_elements(
          case
            when pg_catalog.jsonb_typeof(record_type.value -> 'fields') = 'array'
            then record_type.value -> 'fields'
            else '[]'::jsonb
          end
        ) as field(value)
      ), policy_fields as (
        select
          pg_catalog.lower(permission.value ->> 'recordTypeId') as record_type_id,
          pg_catalog.lower(field.value) as field_id
        from pg_catalog.jsonb_array_elements(permissions_value) as permission(value)
        cross join lateral pg_catalog.jsonb_array_elements_text(
          (permission.value #> '{fieldPolicy,readableFieldIds}')
          || (permission.value #> '{fieldPolicy,changeableFieldIds}')
        ) as field(value)
        where permission.value ->> 'recordTypeId' is not null
      )
      select 1
      from pg_catalog.jsonb_array_elements(permissions_value) as permission(value)
      left join available_record_type_counts as record_type_count
        on record_type_count.record_type_id =
          pg_catalog.lower(permission.value ->> 'recordTypeId')
      where permission.value ->> 'recordTypeId' is not null
        and (
          record_type_count.record_type_count is distinct from 1
          or exists (
            select 1
            from policy_fields as policy_field
            where policy_field.record_type_id =
                pg_catalog.lower(permission.value ->> 'recordTypeId')
              and not exists (
                select 1
                from available_fields as available_field
                where available_field.record_type_id = policy_field.record_type_id
                  and available_field.field_id = policy_field.field_id
              )
          )
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Definition release field policy names a field outside its exact record type';
    end if;
  end if;

  if root_row.kind = 'application' then
    if pg_catalog.jsonb_typeof(compilation_output_value #> '{canonical,content,pages}')
        is distinct from 'array'
      or pg_catalog.jsonb_typeof(compilation_output_value #> '{canonical,content,roles}')
        is distinct from 'array' then
      raise exception using errcode = 'XX001',
        message = 'Published Application address metadata is malformed';
    end if;
    application_address_value := pg_catalog.jsonb_build_object(
      'kind', compilation_output_value -> 'kind',
      'name', compilation_output_value #> '{canonical,content,name}',
      'icon', compilation_output_value #> '{canonical,content,icon}',
      'homePageId', compilation_output_value #> '{canonical,content,homePageId}',
      'pages', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'pageId', page.value -> 'pageId',
            'key', page.value -> 'key',
            'accessPermissionKey', page.value -> 'accessPermissionKey'
          ) order by page.ordinality
        )
        from pg_catalog.jsonb_array_elements(
          compilation_output_value #> '{canonical,content,pages}'
        ) with ordinality as page(value, ordinality)
      ), '[]'::jsonb),
      'roles', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'roleId', role.value -> 'roleId',
            'key', role.value -> 'key',
            'homePageId', role.value -> 'homePageId'
          ) order by role.ordinality
        )
        from pg_catalog.jsonb_array_elements(
          compilation_output_value #> '{canonical,content,roles}'
        ) with ordinality as role(value, ordinality)
      ), '[]'::jsonb)
    );
    application_experience_value := pg_catalog.jsonb_build_object(
      'experiences', coalesce(
        compilation_output_value #> '{canonical,content,experiences}', '[]'::jsonb
      ),
      'resolvedExperiences', case
        when pg_catalog.jsonb_typeof(
          compilation_output_value #> '{canonical,content,experiences}'
        ) = 'array' then coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'state', experience.value ->> 'state', 'page', page.value
            ) order by experience.value ->> 'state' collate "C"
          )
          from pg_catalog.jsonb_array_elements(
            compilation_output_value #> '{canonical,content,experiences}'
          ) as experience(value)
          join pg_catalog.jsonb_array_elements(
            compilation_output_value #> '{canonical,content,pages}'
          ) as page(value)
            on page.value ->> 'pageId' = experience.value ->> 'pageId'
        ), '[]'::jsonb)
        else '[]'::jsonb
      end,
      'shells', compilation_output_value #> '{canonical,content,shells}',
      'theme', compilation_output_value #> '{canonical,content,theme}'
    );
  end if;

  insert into vortex_definition.releases (
    root_id, release_revision, release_version, authored_source,
    authored_source_fingerprint, source_contract_version, compilation_output, resolution_snapshot,
    content_fingerprint, resolution_fingerprint, validation_contract_version,
    impact_reasons, release_note, published_at, published_by,
    application_address, application_experience
  ) values (
    p_root_id, draft_row.draft_revision, release_version_value, draft_row.draft_source,
    draft_row.source_fingerprint, draft_row.source_contract_version, compilation_output_value,
    resolution_snapshot_value,
    content_fingerprint_value, resolution_fingerprint_value, validation_contract_version_value,
    impact_reasons_value, release_note_value, operation_at,
    context_actor_id, application_address_value, application_experience_value
  );

  for supplied_dependency in
    select item.value
    from pg_catalog.jsonb_array_elements(dependency_manifest_value) as item(value)
  loop
    supplied_kind := supplied_dependency ->> 'kind';
    supplied_reference := case supplied_kind
      when 'platform_theme' then supplied_dependency ->> 'catalogueThemeId'
      when 'platform_block' then supplied_dependency ->> 'blockId'
      else supplied_dependency ->> 'key'
    end;
    supplied_version := supplied_dependency ->> 'releaseVersion';
    supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
    supplied_target_root_id := case when supplied_kind = 'module'
      then (supplied_dependency ->> 'rootId')::uuid else null end;
    supplied_target_release_revision := case when supplied_kind = 'module'
      then (supplied_dependency ->> 'releaseRevision')::bigint else null end;
    supplied_catalogue_item_id := case supplied_kind
      when 'connection_type' then (supplied_dependency ->> 'rootId')::uuid
      when 'platform_block' then (supplied_dependency ->> 'blockId')::uuid
      else null
    end;
    supplied_entry := null;
    if supplied_kind in (
      'application_flow', 'application_flow_node', 'application_query',
      'module_query', 'application_form', 'application_workflow', 'application_action',
      'protected_operation'
    ) then
      supplied_entry := supplied_dependency;
      supplied_reference := vortex_definition.flow_target_dependency_reference(supplied_dependency);
    end if;

    insert into vortex_definition.release_dependencies (
      root_id, release_revision, dependency_kind, dependency_reference,
      dependency_version, dependency_content_fingerprint,
      target_root_id, target_release_revision, catalogue_item_id, dependency_entry
    ) values (
      p_root_id, draft_row.draft_revision, supplied_kind, supplied_reference,
      supplied_version, supplied_content_fingerprint,
      supplied_target_root_id, supplied_target_release_revision, supplied_catalogue_item_id,
      supplied_entry
    );
    inserted_dependency_count := inserted_dependency_count + 1;
  end loop;

  if inserted_dependency_count <> dependency_count then
    raise exception using errcode = '23514', message = 'Definition dependency manifest was not stored one-for-one';
  end if;

  perform 1
  from vortex_definition.reachable_module_dependency_edges(
    p_root_id, draft_row.draft_revision
  );

  update vortex_definition.roots as root
  set current_release_revision = draft_row.draft_revision
  where root.root_id = p_root_id
    and root.current_release_revision is not distinct from expected_history_revision;

  if not found then
    raise exception using errcode = '40001', message = 'Definition current release pointer changed during publication';
  end if;

  if human_publication then
    checked_context := vortex_access.validated_human_request_context();
    if checked_context is distinct from original_context then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
  end if;

  if human_publication then
    foreach permission_key in array array[
      'platform.organization.definition_drafts.manage',
      'platform.organization.definition_releases.manage'
    ] loop
      permission_id := case permission_key
        when 'platform.organization.definition_drafts.manage'
          -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
          then '0548c061-b1a9-48e5-a04a-eb1d0dae0644'::uuid
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        else 'dfdd5aba-2b85-4169-b570-92be284e7b5c'::uuid
      end;
      select evaluated.* into strict permission_decision
      from vortex_access.evaluate_organization_permission_eligibility(
        pg_catalog.jsonb_build_object(
          'operationKey', permission_key,
          'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
          'target', pg_catalog.jsonb_build_object('kind', 'organization'),
          'requiredPermission', pg_catalog.jsonb_build_object(
            -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
            'ownerKind', 'platform', 'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
            'permissionId', permission_id
          ),
          'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
          'authority', pg_catalog.jsonb_build_object('kind', 'permission')
        )
      ) as evaluated;
      checked_at := pg_catalog.clock_timestamp();
      if permission_decision.outcome is distinct from 'eligible'
        or permission_decision.operation_key is distinct from permission_key
        or permission_decision.target_kind is distinct from 'organization'
        or permission_decision.target_application_root_id is not null
        or permission_decision.reason_code is not null
        or permission_decision.organization_id
          is distinct from (checked_context ->> 'organizationId')::uuid
        or permission_decision.organization_account_id
          is distinct from (checked_context ->> 'organizationAccountId')::uuid
        or permission_decision.access_version is distinct from locked_access_version
        or permission_decision.correlation_id
          is distinct from (checked_context ->> 'correlationId')::uuid
        or permission_decision.checked_at is null or permission_decision.checked_at > checked_at
        or permission_decision.valid_until is null or permission_decision.valid_until <= checked_at
        or (checked_context ->> 'issuedAt')::timestamptz > checked_at
        or (checked_context ->> 'expiresAt')::timestamptz <= checked_at then
        raise exception using errcode = '42501',
          message = 'Definition publication authority is unavailable';
      end if;
      permission_deadline := least(permission_deadline, permission_decision.valid_until);
    end loop;
    if permission_deadline <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
  end if;

  return query
  select
    release.root_id,
    release.release_revision,
    release.release_version,
    release.content_fingerprint,
    release.resolution_fingerprint,
    coalesce((
      select pg_catalog.jsonb_agg(
        case dependency.dependency_kind
          when 'module' then pg_catalog.jsonb_build_object(
            'kind', 'module', 'key', dependency.dependency_reference,
            'rootId', dependency.target_root_id,
            'releaseRevision', dependency.target_release_revision,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'connection_type' then pg_catalog.jsonb_build_object(
            'kind', 'connection_type', 'key', dependency.dependency_reference,
            'rootId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'platform_block' then pg_catalog.jsonb_build_object(
            'kind', 'platform_block',
            'blockId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'platform_theme' then pg_catalog.jsonb_build_object(
            'kind', 'platform_theme', 'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          else dependency.dependency_entry
        end order by
          dependency.dependency_kind collate "C",
          dependency.dependency_reference collate "C",
          dependency.dependency_version collate "C"
      )
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = release.root_id
        and dependency.release_revision = release.release_revision
    ), '[]'::jsonb),
    release.published_at,
    release.published_by
  from vortex_definition.releases as release
  where release.root_id = p_root_id
    and release.release_revision = draft_row.draft_revision;
end
$function$;

revoke execute on function vortex_definition.append_release(uuid, bigint, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.append_release(uuid, bigint, text, jsonb)
  to vortex_request;
comment on function vortex_definition.append_release(uuid, bigint, text, jsonb) is
  'Atomically validates and records one compiled Definition release with exact field-policy ownership, pinned dependencies and canonical flow operations; retains System publication and permits ordinary human Application and Module publication only under locked current draft/release permissions and original account attribution, then advances only its root pointer.';

alter function vortex_definition.append_release(p_root_id uuid, p_expected_draft_revision bigint, p_expected_source_fingerprint text, p_release jsonb) owner to vortex_owner;

grant execute on function vortex_definition.append_release(p_root_id uuid, p_expected_draft_revision bigint, p_expected_source_fingerprint text, p_release jsonb) to postgres;

create or replace function vortex_access.read_application_address_candidates(
  p_identity_id uuid,
  p_tenant_short_name text,
  p_organization_short_name text,
  p_include_experiences boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  addressed_organization record;
  application_row record;
  application_values jsonb := '[]'::jsonb;
  page_values jsonb;
  experience_values jsonb;
  role_values jsonb;
  permission_values jsonb;
  home_page_key text;
begin
  if p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_tenant_short_name is null
    or pg_catalog.char_length(p_tenant_short_name) not between 1 and 40
    or p_tenant_short_name !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    or p_organization_short_name is null
    or pg_catalog.char_length(p_organization_short_name) not between 1 and 40
    or p_organization_short_name !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$' then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  select tenant.tenant_id, tenant.short_name as tenant_short_name,
    organization.organization_id, organization.short_name as organization_short_name
  into addressed_organization
  from vortex_identity.tenants as tenant
  join vortex_identity.organizations as organization
    on organization.tenant_id = tenant.tenant_id
  where tenant.short_name = p_tenant_short_name
    and organization.short_name = p_organization_short_name
    and tenant.state = 'active'
    and organization.state = 'active';

  if not found then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  begin
    perform 1
    from vortex_access.resolve_human_organization_scope(
      p_identity_id, addressed_organization.organization_id
    ) as scope;
  exception
    when sqlstate 'V3140' then
      return pg_catalog.jsonb_build_object(
        'kind', 'suspended_super_administrator_account'
      );
    when sqlstate '42501' or sqlstate 'P0002' then
      return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end;

  -- The organisation scope above is the viewer's only scope check: every
  -- candidate below is already an active registration of this organisation.
  for application_row in
    select root.root_id, root.key as application_key, release.application_address,
      case when p_include_experiences then release.application_experience else null end
        as application_experience,
      registration.source_revision as release_revision
    from vortex_access.permission_registrations as registration
    join vortex_definition.roots as root
      on root.root_id = registration.registration_owner_id
      and root.organization_id = addressed_organization.organization_id
      and root.kind = 'application'
      and root.key = registration.source_definition_key
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = registration.source_revision
      and release.release_version = registration.source_version
      and release.validation_contract_version = registration.validation_contract_version
    where registration.organization_id = addressed_organization.organization_id
      and registration.registration_kind = 'application'
      and registration.state = 'active'
      and exists (
        select 1
        from vortex_definition.installation_bindings as binding
        where binding.organization_id = addressed_organization.organization_id
          and binding.application_root_id = root.root_id
          and binding.application_release_revision = registration.source_revision
          and binding.state = 'active'
      )
      and release.application_address ->> 'kind' = 'application'
    order by root.key collate "C", root.root_id
  loop
    -- Published release data is platform-produced: a malformed field is a
    -- defect of that application's release, so it fails loudly with the
    -- application named instead of dropping the application from the list.
    page_values := application_row.application_address -> 'pages';
    if pg_catalog.jsonb_typeof(page_values) is distinct from 'array' then
      raise exception using errcode = 'XX001',
        message = pg_catalog.format(
          'Published application %s has malformed pages', application_row.application_key);
    end if;

    select page.value ->> 'key'
    into home_page_key
    from pg_catalog.jsonb_array_elements(page_values) as page(value)
    where page.value ->> 'pageId' =
      application_row.application_address ->> 'homePageId';

    if home_page_key is null then
      raise exception using errcode = 'XX001',
        message = pg_catalog.format(
          'Published application %s has no home page among its pages',
          application_row.application_key);
    end if;

    -- Declared experience pages are resolved to their exact compiled page definitions here, so
    -- App can render an application's own not-found, unavailable and error surfaces. A refused
    -- page and a missing page both resolve to the same not_found experience. Experiences are an
    -- optional release field: an absent one declares none, a present one must be an array.
    if p_include_experiences then
      experience_values := application_row.application_experience -> 'experiences';
      if experience_values is null then
        experience_values := '[]'::jsonb;
      elsif pg_catalog.jsonb_typeof(experience_values) is distinct from 'array' then
        raise exception using errcode = 'XX001',
          message = pg_catalog.format(
            'Published application %s has malformed experiences', application_row.application_key);
      end if;
    end if;

    role_values := application_row.application_address -> 'roles';
    if pg_catalog.jsonb_typeof(role_values) is distinct from 'array' then
      raise exception using errcode = 'XX001',
        message = pg_catalog.format(
          'Published application %s has malformed roles', application_row.application_key);
    end if;

    -- Page discovery only consults the page's access permission. Avoid
    -- serializing unrelated application actions into every address read.
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'key', entry.permission_key,
        'applicationRootId', entry.application_root_id,
        'ownerKind', entry.owner_kind,
        'ownerId', entry.owner_id,
        'permissionId', entry.permission_id,
        'actionKind', entry.action_kind,
        'namedAction', entry.named_action
      ) order by entry.permission_key collate "C", entry.permission_id
    ), '[]'::jsonb)
    into permission_values
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
      and registration.state = 'active'
    where entry.organization_id = addressed_organization.organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = application_row.root_id
      and entry.application_root_id = entry.registration_owner_id
      and entry.permission_key in (
        select page.value ->> 'accessPermissionKey'
        from pg_catalog.jsonb_array_elements(page_values) as page(value)
      );

    application_values := application_values || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId', application_row.root_id,
        'releaseRevision', application_row.release_revision,
        'key', application_row.application_key,
        'name', application_row.application_address ->> 'name',
        'icon', application_row.application_address ->> 'icon',
        'homePageKey', home_page_key,
        'pages', (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'pageId', page.value ->> 'pageId',
              'key', page.value ->> 'key',
              'accessPermissionKey', page.value ->> 'accessPermissionKey'
            ) order by page.value ->> 'key' collate "C"
          )
          from pg_catalog.jsonb_array_elements(page_values) as page(value)
        ),
        'roles', (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'roleId', role.value ->> 'roleId',
              'key', role.value ->> 'key',
              'homePageId', role.value ->> 'homePageId'
            ) order by role.value ->> 'key' collate "C"
          )
          from pg_catalog.jsonb_array_elements(role_values) as role(value)
        ),
        'permissions', coalesce(permission_values, '[]'::jsonb)
      ) || case when p_include_experiences then pg_catalog.jsonb_build_object(
        'experiences', application_row.application_experience -> 'resolvedExperiences',
        'shells', case
          when pg_catalog.jsonb_array_length(experience_values) > 0
            then coalesce(
              application_row.application_experience -> 'shells',
              '[]'::jsonb
            )
          else '[]'::jsonb
        end
      ) || case
        when p_include_experiences and pg_catalog.jsonb_array_length(experience_values) > 0
          then pg_catalog.jsonb_build_object(
            'theme', application_row.application_experience -> 'theme'
          )
        else '{}'::jsonb
      end
      else '{}'::jsonb end
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'kind', 'available',
    'organizationId', addressed_organization.organization_id,
    'tenantShortName', addressed_organization.tenant_short_name,
    'organizationShortName', addressed_organization.organization_short_name,
    'applications', application_values
  );
end
$function$;

revoke all on function vortex_access.read_application_address_candidates(uuid, text, text, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.read_application_address_candidates(uuid, text, text, boolean)
  to vortex_runtime;

comment on function vortex_access.read_application_address_candidates(uuid, text, text, boolean) is
  'Private App candidate read for one exact live human organisation address; only App may project metadata after current page Access decisions.';

alter function vortex_access.read_application_address_candidates(p_identity_id uuid, p_tenant_short_name text, p_organization_short_name text, p_include_experiences boolean) owner to vortex_owner;

grant execute on function vortex_access.read_application_address_candidates(p_identity_id uuid, p_tenant_short_name text, p_organization_short_name text, p_include_experiences boolean) to postgres;

create or replace function vortex_definition.read_active_installation_for_scope_internal(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  selected_organization_id uuid;
  selected_application_root_id uuid;
  selected_application_release_revision bigint;
  selected_bindings jsonb;
begin
  if p_organization_id is null or p_application_root_id is null then
    raise exception using errcode = '22023', message = 'Active Application context is required';
  end if;
  selected_organization_id := p_organization_id;
  selected_application_root_id := p_application_root_id;

  select pg_catalog.min(binding.application_release_revision)
  into selected_application_release_revision
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = selected_organization_id
    and binding.application_root_id = selected_application_root_id
    and binding.state = 'active';
  if selected_application_release_revision is null then
    raise exception using errcode = 'P0002', message = 'Active Application installation is unavailable';
  end if;
  if exists (
    select 1 from vortex_definition.installation_bindings as binding
    where binding.organization_id = selected_organization_id
      and binding.application_root_id = selected_application_root_id
      and binding.state = 'active'
      and binding.application_release_revision <> selected_application_release_revision
  ) then
    raise exception using errcode = '55000', message = 'Active Application installation is mixed';
  end if;

  if not exists (
    select 1
    from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = selected_application_release_revision
    where root.root_id = selected_application_root_id
      and root.kind = 'application'
      and root.organization_id = selected_organization_id
      and release.application_address ->> 'kind' = 'application'
  ) then
    raise exception using errcode = '23514', message = 'Active Application release evidence is invalid';
  end if;

  if not exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      selected_application_root_id, selected_application_release_revision
    )
  ) or exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      selected_application_root_id, selected_application_release_revision
    ) as node
    left join vortex_definition.installation_bindings as binding
      on binding.organization_id = selected_organization_id
      and binding.application_root_id = selected_application_root_id
      and binding.module_root_id = node.target_root_id
    where binding.state is distinct from 'active'
      or binding.application_release_revision is distinct from selected_application_release_revision
      or binding.module_release_revision is distinct from node.target_release_revision
  ) or exists (
    select 1
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = selected_organization_id
      and binding.application_root_id = selected_application_root_id
      and binding.state = 'active'
      and not exists (
        select 1
        from vortex_definition.reachable_module_dependency_edges(
          selected_application_root_id, selected_application_release_revision
        ) as node
        where node.target_root_id = binding.module_root_id
          and node.target_release_revision = binding.module_release_revision
      )
  ) then
    raise exception using errcode = '55000', message = 'Active Application Module bindings are incomplete';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'organizationId', binding.organization_id,
      'applicationRootId', binding.application_root_id,
      'moduleRootId', binding.module_root_id,
      'bindingRevision', binding.binding_revision,
      'applicationReleaseRevision', binding.application_release_revision,
      'moduleReleaseRevision', binding.module_release_revision,
      'state', binding.state
    ) order by binding.module_root_id
  ) into selected_bindings
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = selected_organization_id
    and binding.application_root_id = selected_application_root_id
    and binding.application_release_revision = selected_application_release_revision
    and binding.state = 'active';

  return pg_catalog.jsonb_build_object(
    'organizationId', selected_organization_id,
    'applicationRootId', selected_application_root_id,
    'applicationReleaseRevision', selected_application_release_revision,
    'moduleBindings', selected_bindings
  );
end
$function$;

alter function vortex_definition.read_active_installation_for_scope_internal(uuid,uuid) owner to vortex_owner;

revoke all on function vortex_definition.read_active_installation_for_scope_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
-- This fixed reader serves Definition and PostgreSQL callers, and the Record
-- adapter's system-only search snapshot read, which passes only the Application
-- of its validated system context. The adapter never receives direct Module
-- table authority.
grant execute on function vortex_definition.read_active_installation_for_scope_internal(uuid, uuid)
  to postgres;
grant execute on function vortex_definition.read_active_installation_for_scope_internal(uuid, uuid)
  to vortex_owner;
grant execute on function vortex_definition.read_active_installation_for_scope_internal(uuid, uuid)
  to vortex_record_adapter;
comment on function vortex_definition.read_active_installation_for_scope_internal(uuid, uuid) is
  'Resolves the complete exact active Module binding set for one already-validated organisation/Application scope.';

reset role;
