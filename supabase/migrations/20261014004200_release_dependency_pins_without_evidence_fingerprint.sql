set local role vortex_owner;

-- A module dependency pin is the target root and its immutable release revision;
-- the stored evidence fingerprint duplicated what that identity already selects.
drop function vortex_definition.reachable_module_dependency_edges(uuid, bigint);

alter table vortex_definition.release_dependencies
  drop column evidence_fingerprint;

CREATE FUNCTION vortex_definition.reachable_module_dependency_edges(p_root_id uuid, p_release_revision bigint) RETURNS TABLE(target_root_id uuid, target_release_revision bigint, dependency_reference text, dependency_version text, dependency_content_fingerprint text)
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  pin record;
begin
  -- UNION collapses edges that reach one target with an identical pin, so a
  -- root has one tuple exactly when every edge pins it at one revision. The
  -- release being resolved already pins its own root, so reaching that root
  -- again would pin it twice; this is also how a root-level cycle is refused.
  for pin in
    with recursive module_edges as (
      select dependency.target_root_id, dependency.target_release_revision,
        dependency.dependency_reference, dependency.dependency_version,
        dependency.dependency_content_fingerprint
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = p_root_id
        and dependency.release_revision = p_release_revision
        and dependency.dependency_kind = 'module'
      union
      select dependency.target_root_id, dependency.target_release_revision,
        dependency.dependency_reference, dependency.dependency_version,
        dependency.dependency_content_fingerprint
      from module_edges as parent
      join vortex_definition.release_dependencies as dependency
        on dependency.root_id = parent.target_root_id
        and dependency.release_revision = parent.target_release_revision
        and dependency.dependency_kind = 'module'
    )
    select edge.target_root_id, edge.target_release_revision,
      edge.dependency_reference, edge.dependency_version,
      edge.dependency_content_fingerprint,
      pg_catalog.count(*) over (partition by edge.target_root_id) as root_pin_count,
      root.kind is distinct from 'module'
        or root.key is distinct from edge.dependency_reference
        or release.release_version is distinct from edge.dependency_version
        or release.content_fingerprint is distinct from edge.dependency_content_fingerprint
        as disagrees_with_target
    from module_edges as edge
    left join vortex_definition.roots as root on root.root_id = edge.target_root_id
    left join vortex_definition.releases as release
      on release.root_id = edge.target_root_id
      and release.release_revision = edge.target_release_revision
  loop
    if pin.root_pin_count <> 1
      or pin.disagrees_with_target
      or pin.target_root_id = p_root_id then
      raise exception using errcode = '23514', message = 'Exact bound Module dependency evidence is inconsistent';
    end if;
    target_root_id := pin.target_root_id;
    target_release_revision := pin.target_release_revision;
    dependency_reference := pin.dependency_reference;
    dependency_version := pin.dependency_version;
    dependency_content_fingerprint := pin.dependency_content_fingerprint;
    return next;
  end loop;
end
$$;

alter function vortex_definition.reachable_module_dependency_edges(p_root_id uuid, p_release_revision bigint) owner to vortex_owner;

COMMENT ON FUNCTION vortex_definition.reachable_module_dependency_edges(p_root_id uuid, p_release_revision bigint) IS 'Owner-private Module dependency pin set of one exact release: one row per Module root; raises 23514 when a root is pinned at more than one revision or an edge disagrees with its target release.';

REVOKE ALL ON FUNCTION vortex_definition.reachable_module_dependency_edges(p_root_id uuid, p_release_revision bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_definition.reachable_module_dependency_edges(p_root_id uuid, p_release_revision bigint) TO vortex_owner;

grant execute on function vortex_definition.reachable_module_dependency_edges(p_root_id uuid, p_release_revision bigint) to postgres;

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

  insert into vortex_definition.releases (
    root_id, release_revision, release_version, authored_source,
    authored_source_fingerprint, source_contract_version, compilation_output, resolution_snapshot,
    content_fingerprint, resolution_fingerprint, validation_contract_version,
    impact_reasons, release_note, published_at, published_by
  ) values (
    p_root_id, draft_row.draft_revision, release_version_value, draft_row.draft_source,
    draft_row.source_fingerprint, draft_row.source_contract_version, compilation_output_value,
    resolution_snapshot_value,
    content_fingerprint_value, resolution_fingerprint_value, validation_contract_version_value,
    impact_reasons_value, release_note_value, operation_at,
    context_actor_id
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

create or replace function vortex_definition.project_consumer_release_evidence(
  p_kind text,
  p_root_id uuid,
  p_release_revision bigint
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'organizationId', root.organization_id,
    'kind', root.kind,
    'key', root.key,
    'rootId', release.root_id,
    'releaseRevision', release.release_revision,
    'releaseVersion', release.release_version,
    'sourceContractVersion', release.source_contract_version,
    'validationContractVersion', release.validation_contract_version,
    'contentFingerprint', release.content_fingerprint,
    'resolutionFingerprint', release.resolution_fingerprint,
    'compilationOutput', release.compilation_output,
    'resolutionSnapshot', release.resolution_snapshot,
    'dependencyManifest', coalesce((
      select pg_catalog.jsonb_agg(
        case dependency.dependency_kind
          when 'module' then pg_catalog.jsonb_build_object(
            'kind', 'module',
            'key', dependency.dependency_reference,
            'rootId', dependency.target_root_id,
            'releaseRevision', dependency.target_release_revision,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'connection_type' then pg_catalog.jsonb_build_object(
            'kind', 'connection_type',
            'key', dependency.dependency_reference,
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
            'kind', 'platform_theme',
            'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          else dependency.dependency_entry
        end
        order by dependency.dependency_kind collate "C",
          dependency.dependency_reference collate "C",
          dependency.dependency_version collate "C"
      )
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = release.root_id
        and dependency.release_revision = release.release_revision
    ), '[]'::jsonb),
    'moduleDependencyTargets', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'rootId', target.root_id,
          'releaseRevision', target.release_revision,
          'releaseVersion', target.release_version,
          'contentFingerprint', target.content_fingerprint,
          'resolutionFingerprint', target.resolution_fingerprint
        ) order by dependency.dependency_reference collate "C",
          target.root_id, target.release_revision
      )
      from vortex_definition.release_dependencies as dependency
      join vortex_definition.releases as target
        on target.root_id = dependency.target_root_id
        and target.release_revision = dependency.target_release_revision
      where dependency.root_id = release.root_id
        and dependency.release_revision = release.release_revision
        and dependency.dependency_kind = 'module'
    ), '[]'::jsonb)
  )
  from vortex_definition.roots as root
  join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = p_release_revision
  where root.root_id = p_root_id
    and root.kind = p_kind
$function$;

revoke all on function vortex_definition.project_consumer_release_evidence(text, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.project_consumer_release_evidence(text, uuid, bigint) to vortex_owner;
comment on function vortex_definition.project_consumer_release_evidence(text, uuid, bigint) is
  'Owner-private projection of one exact immutable release; performs no scope selection.';

alter function vortex_definition.project_consumer_release_evidence(p_kind text, p_root_id uuid, p_release_revision bigint) owner to vortex_owner;

grant execute on function vortex_definition.project_consumer_release_evidence(p_kind text, p_root_id uuid, p_release_revision bigint) to postgres;

create or replace function vortex_definition.read_consumer_release(
  p_kind text,
  p_root_id uuid,
  p_release_revision bigint default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  selected_release jsonb;
begin
  checked_context := vortex_definition.validated_system_context();

  if p_kind not in ('module', 'application')
    or p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (
      p_release_revision is not null
      and p_release_revision not between 1 and 9007199254740991
    ) then
    raise exception using
      errcode = '22023',
      message = 'Definition consumer read has an invalid selector';
  end if;

  select pg_catalog.jsonb_build_object(
    'organizationId', root.organization_id,
    'kind', root.kind,
    'key', root.key,
    'rootId', release.root_id,
    'releaseRevision', release.release_revision,
    'releaseVersion', release.release_version,
    'sourceContractVersion', release.source_contract_version,
    'validationContractVersion', release.validation_contract_version,
    'contentFingerprint', release.content_fingerprint,
    'resolutionFingerprint', release.resolution_fingerprint,
    'compilationOutput', release.compilation_output,
    'resolutionSnapshot', release.resolution_snapshot,
    'dependencyManifest', coalesce((
      select pg_catalog.jsonb_agg(
        case dependency.dependency_kind
          when 'module' then pg_catalog.jsonb_build_object(
            'kind', 'module',
            'key', dependency.dependency_reference,
            'rootId', dependency.target_root_id,
            'releaseRevision', dependency.target_release_revision,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'connection_type' then pg_catalog.jsonb_build_object(
            'kind', 'connection_type',
            'key', dependency.dependency_reference,
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
            'kind', 'platform_theme',
            'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          else dependency.dependency_entry
        end
        order by
          dependency.dependency_kind collate "C",
          dependency.dependency_reference collate "C",
          dependency.dependency_version collate "C"
      )
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = release.root_id
        and dependency.release_revision = release.release_revision
    ), '[]'::jsonb),
    'moduleDependencyTargets', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'rootId', target.root_id,
          'releaseRevision', target.release_revision,
          'releaseVersion', target.release_version,
          'contentFingerprint', target.content_fingerprint,
          'resolutionFingerprint', target.resolution_fingerprint
        )
        order by
          dependency.dependency_reference collate "C",
          target.root_id,
          target.release_revision
      )
      from vortex_definition.release_dependencies as dependency
      join vortex_definition.releases as target
        on target.root_id = dependency.target_root_id
        and target.release_revision = dependency.target_release_revision
      where dependency.root_id = release.root_id
        and dependency.release_revision = release.release_revision
        and dependency.dependency_kind = 'module'
    ), '[]'::jsonb)
  ) into selected_release
  from vortex_definition.roots as root
  join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = coalesce(
      p_release_revision,
      root.current_release_revision
    )
  where root.root_id = p_root_id
    and root.kind = p_kind
    and root.organization_id = (checked_context ->> 'organizationId')::uuid;

  return selected_release;
end
$function$;

revoke execute on function vortex_definition.read_consumer_release(text, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_consumer_release(text, uuid, bigint)
  to vortex_request;
comment on function vortex_definition.read_consumer_release(text, uuid, bigint) is
  'Returns one same-organization immutable Module or Application release as private integrity evidence for the Definition consumer-read service.';

alter function vortex_definition.read_consumer_release(p_kind text, p_root_id uuid, p_release_revision bigint) owner to vortex_owner;

grant execute on function vortex_definition.read_consumer_release(p_kind text, p_root_id uuid, p_release_revision bigint) to postgres;

create or replace function vortex_definition.read_restore_release_evidence(
  p_kind text,
  p_root_id uuid,
  p_release_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  initial_human_context jsonb;
  final_human_context jsonb;
  raw_context jsonb;
  release_evidence jsonb;
  human_current_draft jsonb;
  root_row vortex_definition.roots%rowtype;
  draft_row vortex_definition.drafts%rowtype;
  permission_decision record;
  completion_at timestamptz;
  human_restore boolean := false;
begin
  raw_context := vortex_platform.current_context();
  human_restore := raw_context ->> 'callerKind' = 'human';
  if human_restore then
    if p_kind is null
      or p_kind is distinct from 'application'
      or p_root_id is null
      or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_release_revision is null
      or p_release_revision not between 1 and 9007199254740991 then
      raise exception using
        errcode = '22023',
        message = 'Definition restore evidence has an invalid selector';
    end if;

    initial_human_context := vortex_access.validated_human_request_context();
    if initial_human_context ->> 'callerKind' is distinct from 'human'
      or initial_human_context ->> 'channel' is distinct from 'web'
      or initial_human_context ? 'applicationRootId'
      or initial_human_context ? 'delegatedContext'
      or initial_human_context ? 'supportContext' then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    checked_context := vortex_definition.validated_builder_draft_write_context_internal(p_root_id);
    if checked_context is distinct from initial_human_context then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    select root.*
    into root_row
    from vortex_definition.roots as root
    where root.root_id = p_root_id
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind = 'application'
    for update;
    if not found
      or root_row.application_origin_kind is distinct from 'ordinary'
      or root_row.current_release_revision is null then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    select draft.*
    into draft_row
    from vortex_definition.drafts as draft
    where draft.root_id = root_row.root_id
    for update;
    if not found then
      raise exception using
        errcode = '23503',
        message = 'A Definition root requires its current draft';
    end if;
  else
    checked_context := vortex_definition.validated_system_context();
  end if;

  if p_kind is null
    or p_kind not in ('module', 'application')
    or p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_release_revision is null
    or p_release_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Definition restore evidence has an invalid selector';
  end if;

  select pg_catalog.jsonb_build_object(
    'organizationId', root.organization_id,
    'kind', root.kind,
    'key', root.key,
    'rootId', root.root_id,
    'releaseRevision', release.release_revision,
    'releaseVersion', release.release_version,
    'authoredSource', release.authored_source,
    'sourceFingerprint', release.authored_source_fingerprint,
    'sourceContractVersion', release.source_contract_version,
    'contentFingerprint', release.content_fingerprint,
    'resolutionFingerprint', release.resolution_fingerprint,
    'validationContractVersion', release.validation_contract_version,
    'compilationOutput', release.compilation_output,
    'resolutionSnapshot', release.resolution_snapshot,
    'dependencyManifest', coalesce((
      select pg_catalog.jsonb_agg(
        case dependency.dependency_kind
          when 'module' then pg_catalog.jsonb_build_object(
            'kind', 'module',
            'key', dependency.dependency_reference,
            'rootId', dependency.target_root_id,
            'releaseRevision', dependency.target_release_revision,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'connection_type' then pg_catalog.jsonb_build_object(
            'kind', 'connection_type',
            'key', dependency.dependency_reference,
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
            'kind', 'platform_theme',
            'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          else dependency.dependency_entry
        end
        order by
          dependency.dependency_kind collate "C",
          dependency.dependency_reference collate "C",
          dependency.dependency_version collate "C"
      )
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = release.root_id
        and dependency.release_revision = release.release_revision
    ), '[]'::jsonb),
    'moduleDependencyTargets', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'rootId', target.root_id,
          'releaseRevision', target.release_revision,
          'releaseVersion', target.release_version,
          'contentFingerprint', target.content_fingerprint,
          'resolutionFingerprint', target.resolution_fingerprint
        )
        order by
          dependency.dependency_reference collate "C",
          target.root_id,
          target.release_revision
      )
      from vortex_definition.release_dependencies as dependency
      join vortex_definition.releases as target
        on target.root_id = dependency.target_root_id
        and target.release_revision = dependency.target_release_revision
      where dependency.root_id = release.root_id
        and dependency.release_revision = release.release_revision
        and dependency.dependency_kind = 'module'
    ), '[]'::jsonb),
    'identityEvidence', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'definitionKey', root.key,
          'ownerScope', alias.owner_scope,
          'scope', alias.scope,
          'kind', alias.kind,
          'componentOwner', alias.component_owner,
          'alias', alias.alias,
          'identifier', alias.identity_id
        )
        order by
          alias.scope collate "C",
          alias.kind collate "C",
          alias.component_owner collate "C",
          alias.alias collate "C"
      )
      from vortex_definition.source_identity_aliases as alias
      where alias.root_id = root.root_id
    ), '[]'::jsonb)
  )
  into release_evidence
  from vortex_definition.roots as root
  join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = p_release_revision
      and (not human_restore or release.release_revision <= root_row.current_release_revision)
  where root.root_id = p_root_id
    and root.kind = p_kind
    and root.organization_id = (checked_context ->> 'organizationId')::uuid;

  if human_restore and release_evidence is not null then
    human_current_draft := pg_catalog.jsonb_build_object(
      'organizationId', root_row.organization_id,
      'kind', root_row.kind,
      'key', root_row.key,
      'rootId', draft_row.root_id,
      'draftRevision', draft_row.draft_revision,
      'publishedRevision', root_row.current_release_revision,
      'source', draft_row.draft_source,
      'sourceContractVersion', draft_row.source_contract_version,
      'sourceFingerprint', draft_row.source_fingerprint,
      'createdAt', root_row.created_at,
      'createdBy', root_row.created_by,
      'updatedAt', draft_row.updated_at,
      'updatedBy', draft_row.updated_by
    ) || case
      when draft_row.restored_from_release_revision is not null then pg_catalog.jsonb_build_object(
        'restoredFromReleaseRevision', draft_row.restored_from_release_revision,
        'restoredFromSourceFingerprint', draft_row.restored_from_source_fingerprint,
        'restoredBy', draft_row.restored_by,
        'restoredAt', draft_row.restored_at,
        'restoreCorrelationId', draft_row.restore_correlation_id
      )
      else '{}'::jsonb
    end;

    release_evidence := release_evidence || pg_catalog.jsonb_build_object(
      'humanDraftSnapshot', pg_catalog.jsonb_build_object(
        'draftRevision', draft_row.draft_revision,
        'sourceFingerprint', draft_row.source_fingerprint,
        'anchorReleaseRevision', root_row.current_release_revision
      ),
      'humanCurrentDraft', human_current_draft
    );

    final_human_context := vortex_definition.validated_builder_draft_write_context_internal(p_root_id);
    if final_human_context is distinct from initial_human_context then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    select evaluated.*
    into strict permission_decision
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', 'platform.organization.definition_drafts.manage',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform',
          -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
          'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
          -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
          'permissionId', '0548c061-b1a9-48e5-a04a-eb1d0dae0644'
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    ) as evaluated;

    final_human_context := vortex_access.validated_human_request_context();
    completion_at := pg_catalog.clock_timestamp();
    if final_human_context is distinct from initial_human_context
      or permission_decision.outcome is distinct from 'eligible'
      or permission_decision.operation_key is distinct from 'platform.organization.definition_drafts.manage'
      or permission_decision.target_kind is distinct from 'organization'
      or permission_decision.target_application_root_id is not null
      or permission_decision.organization_id is distinct from (initial_human_context ->> 'organizationId')::uuid
      or permission_decision.organization_account_id is distinct from (initial_human_context ->> 'organizationAccountId')::uuid
      or permission_decision.access_version is distinct from (initial_human_context ->> 'accessVersion')::bigint
      or permission_decision.correlation_id is distinct from (initial_human_context ->> 'correlationId')::uuid
      or permission_decision.reason_code is not null
      or permission_decision.checked_at is null
      or permission_decision.checked_at > completion_at
      or permission_decision.valid_until is null
      or permission_decision.valid_until <= completion_at
      or (initial_human_context ->> 'issuedAt')::timestamptz > completion_at
      or (initial_human_context ->> 'expiresAt')::timestamptz <= completion_at
      or draft_row.updated_at > completion_at
      or (draft_row.restored_at is not null and draft_row.restored_at > completion_at) then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;
  end if;

  return release_evidence;
end
$function$;

revoke execute on function vortex_definition.read_restore_release_evidence(text, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_restore_release_evidence(text, uuid, bigint)
  to vortex_request;
comment on function vortex_definition.read_restore_release_evidence(text, uuid, bigint) is
  'Returns narrow private evidence needed to verify one immutable source before restoring its draft.';

alter function vortex_definition.read_restore_release_evidence(p_kind text, p_root_id uuid, p_release_revision bigint) owner to vortex_owner;

create or replace function vortex_definition.read_current_detached_installation_for_transfer_internal()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  selected_organization_id uuid;
  selected_application_root_id uuid;
  selected_application_release_revision bigint;
  selected_bindings jsonb;
  binding_row vortex_definition.installation_bindings%rowtype;
begin
  checked_context := vortex_access.validated_human_request_context();
  if not checked_context ? 'applicationRootId' then
    raise exception using errcode = '22023', message = 'Detached Application context is required';
  end if;
  selected_organization_id := (checked_context ->> 'organizationId')::uuid;
  selected_application_root_id := (checked_context ->> 'applicationRootId')::uuid;

  -- The retained/disabled entry must observe one stable binding set.  Use the
  -- same lifecycle key as installation transitions, then hold every matching
  -- binding through the transfer transaction.
  for binding_row in
    select binding.*
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = selected_organization_id
      and binding.application_root_id = selected_application_root_id
    order by binding.module_root_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'vortex_definition.binding:' || binding_row.organization_id::text || ':' ||
        binding_row.application_root_id::text || ':' || binding_row.module_root_id::text,
      0
    ));
  end loop;
  perform 1
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = selected_organization_id
    and binding.application_root_id = selected_application_root_id
  for share;

  select pg_catalog.min(binding.application_release_revision)
  into selected_application_release_revision
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = selected_organization_id
    and binding.application_root_id = selected_application_root_id
    and binding.state = 'detached';
  if selected_application_release_revision is null then
    raise exception using errcode = 'P0002', message = 'Detached Application installation is unavailable';
  end if;
  if exists (
    select 1 from vortex_definition.installation_bindings as binding
    where binding.organization_id = selected_organization_id
      and binding.application_root_id = selected_application_root_id
      and binding.state = 'detached'
      and binding.application_release_revision <> selected_application_release_revision
  ) then
    raise exception using errcode = '55000', message = 'Detached Application installation is mixed';
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
      and release.compilation_output #>> '{kind}' = 'application'
  ) then
    raise exception using errcode = '23514', message = 'Detached Application release evidence is invalid';
  end if;

  if not exists (
    select 1 from vortex_definition.release_dependencies as dependency
    where dependency.root_id = selected_application_root_id
      and dependency.release_revision = selected_application_release_revision
      and dependency.dependency_kind = 'module'
  ) or exists (
    with recursive module_edges as (
      select dependency.target_root_id, dependency.target_release_revision,
        dependency.dependency_reference, dependency.dependency_version,
        dependency.dependency_content_fingerprint
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = selected_application_root_id
        and dependency.release_revision = selected_application_release_revision
        and dependency.dependency_kind = 'module'
      union
      select dependency.target_root_id, dependency.target_release_revision,
        dependency.dependency_reference, dependency.dependency_version,
        dependency.dependency_content_fingerprint
      from module_edges as parent
      join vortex_definition.release_dependencies as dependency
        on dependency.root_id = parent.target_root_id
        and dependency.release_revision = parent.target_release_revision
        and dependency.dependency_kind = 'module'
    )
    select 1
    from module_edges as edge
    left join vortex_definition.releases as module_release
      on module_release.root_id = edge.target_root_id
      and module_release.release_revision = edge.target_release_revision
    left join vortex_definition.roots as module_root
      on module_root.root_id = edge.target_root_id
    where module_root.kind is distinct from 'module'
      or module_root.key is distinct from edge.dependency_reference
      or module_release.release_version is distinct from edge.dependency_version
      or module_release.content_fingerprint is distinct from edge.dependency_content_fingerprint
  ) or exists (
    with recursive module_nodes as (
      select dependency.target_root_id, dependency.target_release_revision
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = selected_application_root_id
        and dependency.release_revision = selected_application_release_revision
        and dependency.dependency_kind = 'module'
      union
      select dependency.target_root_id, dependency.target_release_revision
      from module_nodes as parent
      join vortex_definition.release_dependencies as dependency
        on dependency.root_id = parent.target_root_id
        and dependency.release_revision = parent.target_release_revision
        and dependency.dependency_kind = 'module'
    )
    select 1 from module_nodes group by target_root_id
    having pg_catalog.count(distinct target_release_revision) <> 1
  ) or exists (
    with recursive module_nodes as (
      select dependency.target_root_id, dependency.target_release_revision
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = selected_application_root_id
        and dependency.release_revision = selected_application_release_revision
        and dependency.dependency_kind = 'module'
      union
      select dependency.target_root_id, dependency.target_release_revision
      from module_nodes as parent
      join vortex_definition.release_dependencies as dependency
        on dependency.root_id = parent.target_root_id
        and dependency.release_revision = parent.target_release_revision
        and dependency.dependency_kind = 'module'
    )
    select 1
    from module_nodes as node
    left join vortex_definition.installation_bindings as binding
      on binding.organization_id = selected_organization_id
      and binding.application_root_id = selected_application_root_id
      and binding.module_root_id = node.target_root_id
    where binding.state is distinct from 'detached'
      or binding.application_release_revision is distinct from selected_application_release_revision
      or binding.module_release_revision is distinct from node.target_release_revision
  ) or exists (
    select 1
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = selected_organization_id
      and binding.application_root_id = selected_application_root_id
      and binding.state = 'detached'
      and not exists (
        with recursive module_nodes as (
          select dependency.target_root_id, dependency.target_release_revision
          from vortex_definition.release_dependencies as dependency
          where dependency.root_id = selected_application_root_id
            and dependency.release_revision = selected_application_release_revision
            and dependency.dependency_kind = 'module'
          union
          select dependency.target_root_id, dependency.target_release_revision
          from module_nodes as parent
          join vortex_definition.release_dependencies as dependency
            on dependency.root_id = parent.target_root_id
            and dependency.release_revision = parent.target_release_revision
            and dependency.dependency_kind = 'module'
        )
        select 1 from module_nodes as node
        where node.target_root_id = binding.module_root_id
          and node.target_release_revision = binding.module_release_revision
      )
  ) then
    raise exception using errcode = '55000', message = 'Detached Application Module bindings are incomplete';
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
    and binding.state = 'detached';

  return pg_catalog.jsonb_build_object(
    'organizationId', selected_organization_id,
    'applicationRootId', selected_application_root_id,
    'applicationReleaseRevision', selected_application_release_revision,
    'moduleBindings', selected_bindings
  );
end
$function$;

alter function vortex_definition.read_current_detached_installation_for_transfer_internal() owner to vortex_owner;

revoke all on function vortex_definition.read_current_detached_installation_for_transfer_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.read_current_detached_installation_for_transfer_internal()
  to vortex_record_adapter, postgres, vortex_owner;
comment on function vortex_definition.read_current_detached_installation_for_transfer_internal() is
  'Private exact detached installation reader for the fixed retained/disabled ownership-transfer operation.';

create or replace function vortex_definition.read_provisioned_lifecycle_setup_targets_internal(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  initial_authority record;
  current_authority record;
  install_decision record;
  install_scope_decision record;
  initial_context jsonb;
  current_context jsonb;
  completion_time timestamptz;
  context_expires_at timestamptz;
  delegated_expires_at timestamptz;
  application_definition_key text;
  application_release vortex_definition.releases%rowtype;
  permission_snapshot record;
  pin record;
  locked_binding vortex_definition.installation_bindings%rowtype;
  module_release vortex_definition.releases%rowtype;
  storage_provision record;
  expected_module_root_id uuid;
  expected_binding_revision bigint;
  previous_module_root_id uuid;
  module_root_text text;
  binding_revision_text text;
  closure_count bigint;
  expected_count integer;
  module_bindings jsonb := '[]'::jsonb;
  normalized_pins jsonb;
  all_storage_contract_ids uuid[] := array[]::uuid[];
  union_storage_contract_ids uuid[];
  storage_contract_id_count bigint;
  distinct_storage_contract_id_count bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Provisioned Application lifecycle setup command is invalid';
  end if;

  if p_expected_module_bindings is null
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Provisioned Application lifecycle setup binding pins are invalid';
  end if;
  expected_count := pg_catalog.jsonb_array_length(p_expected_module_bindings);
  if expected_count < 1 or expected_count > 10000 then
    raise exception using errcode = '22023',
      message = 'Provisioned Application lifecycle setup binding pins are invalid';
  end if;

  previous_module_root_id := null;
  for pin in
    select item.value
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
  loop
    if pg_catalog.jsonb_typeof(pin.value) is distinct from 'object' then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;
    if not (pin.value ?& array['moduleRootId', 'bindingRevision'])
      or pin.value - array['moduleRootId', 'bindingRevision'] <> '{}'::jsonb
      or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(pin.value)) <> 2 then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;
    if pg_catalog.jsonb_typeof(pin.value -> 'moduleRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(pin.value -> 'bindingRevision') is distinct from 'number' then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;

    module_root_text := pin.value ->> 'moduleRootId';
    if module_root_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or not pg_catalog.pg_input_is_valid(module_root_text, 'uuid') then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;
    expected_module_root_id := module_root_text::uuid;
    if expected_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
      or module_root_text is distinct from expected_module_root_id::text then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;

    binding_revision_text := pin.value ->> 'bindingRevision';
    if binding_revision_text !~ '^[1-9][0-9]*$'
      or not pg_catalog.pg_input_is_valid(binding_revision_text, 'bigint') then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;
    expected_binding_revision := binding_revision_text::bigint;
    if expected_binding_revision not between 1 and 9007199254740991
      or (previous_module_root_id is not null
        and previous_module_root_id >= expected_module_root_id) then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;
    previous_module_root_id := expected_module_root_id;
  end loop;

  select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'moduleRootId', (item.value ->> 'moduleRootId')::uuid,
        'bindingRevision', (item.value ->> 'bindingRevision')::bigint
      )
      order by (item.value ->> 'moduleRootId')::uuid
    )
  into strict normalized_pins
  from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value);
  if p_expected_module_bindings is distinct from normalized_pins then
    raise exception using errcode = '22023',
      message = 'Provisioned Application lifecycle setup binding pins are invalid';
  end if;

  select locked.* into strict initial_authority
  from vortex_access.lock_application_installation_authority() as locked;
  initial_context := vortex_access.validated_human_request_context();
  if initial_context ->> 'callerKind' is distinct from 'human'
    or (initial_context ->> 'organizationId')::uuid is distinct from initial_authority.organization_id
    or (initial_context ->> 'organizationAccountId')::uuid is distinct from initial_authority.organization_account_id
    or (initial_context ->> 'accessVersion')::bigint is distinct from initial_authority.access_version
    or (initial_context ->> 'correlationId')::uuid is distinct from initial_authority.correlation_id
    or (initial_context ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    raise exception using errcode = '42501',
      message = 'Provisioned Application lifecycle setup authority is unavailable';
  end if;

  select release.* into strict application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where root.root_id = p_application_root_id
    and root.organization_id = initial_authority.organization_id
    and root.kind = 'application'
    and release.release_revision = p_application_release_revision;

  select root.key into strict application_definition_key
  from vortex_definition.roots as root
  where root.root_id = p_application_root_id
    and root.organization_id = initial_authority.organization_id
    and root.kind = 'application';

  if not application_release.validation_contract_version = any (
      vortex_definition.accepted_contract_version('application')
    )
    or application_release.compilation_output #>> '{kind}' is distinct from 'application'
    or application_release.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_application_root_id::text
    or application_release.compilation_output #>> '{validationContractVersion}'
      is distinct from application_release.validation_contract_version then
    raise exception using errcode = '23514',
      message = 'Exact Application release is unavailable';
  end if;

  select snapshot.* into strict permission_snapshot
  from vortex_access.read_application_permission_snapshot(
    initial_authority.organization_id, p_application_root_id
  ) as snapshot;
  if permission_snapshot.organization_id is distinct from initial_authority.organization_id
    or permission_snapshot.application_root_id is distinct from p_application_root_id
    or permission_snapshot.registration_revision not between 1 and 9007199254740991
    or permission_snapshot.release_revision is distinct from p_application_release_revision
    or permission_snapshot.definition_key is distinct from application_definition_key
    or permission_snapshot.release_version is distinct from application_release.release_version
    or permission_snapshot.validation_contract_version is distinct from application_release.validation_contract_version
    or permission_snapshot.content_fingerprint is distinct from application_release.content_fingerprint
    or permission_snapshot.resolution_fingerprint is distinct from application_release.resolution_fingerprint then
    raise exception using errcode = '40001',
      message = 'Application permission registration is stale or unavailable';
  end if;

  select pg_catalog.count(*) into closure_count
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  );
  if closure_count < 1
    or closure_count > 10000
    or closure_count <> expected_count
    or exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
        where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
      )
    ) then
    raise exception using errcode = '23514',
      message = 'Application installation binding set is incomplete';
  end if;

  for pin in
    select required.target_root_id
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'vortex_definition.binding:' || initial_authority.organization_id::text || ':' ||
          p_application_root_id::text || ':' || pin.target_root_id::text,
        0
      )
    );
  end loop;

  for pin in
    select required.target_root_id
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    perform 1
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = pin.target_root_id
    for share;
  end loop;

  for locked_binding in
    select binding.*
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.state <> 'detached'
    order by binding.module_root_id
    for share
  loop
    if locked_binding.state <> 'detached'
      and not exists (
        select 1
        from vortex_definition.reachable_module_dependency_edges(
          p_application_root_id, p_application_release_revision
        ) as required
        where required.target_root_id = locked_binding.module_root_id
      ) then
      raise exception using errcode = '40001',
        message = 'Application installation bindings changed or are incomplete';
    end if;
  end loop;

  for pin in
    select required.*
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    select (expected.value ->> 'bindingRevision')::bigint
    into strict expected_binding_revision
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
    where (expected.value ->> 'moduleRootId')::uuid = pin.target_root_id;

    select binding.* into strict locked_binding
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = pin.target_root_id;

    select release.* into strict module_release
    from vortex_definition.releases as release
    where release.root_id = locked_binding.module_root_id
      and release.release_revision = locked_binding.module_release_revision;

    if locked_binding.binding_revision is distinct from expected_binding_revision
      or locked_binding.application_release_revision is distinct from p_application_release_revision
      or locked_binding.module_release_revision is distinct from pin.target_release_revision
      or locked_binding.state is distinct from 'provisioned'
      or module_release.content_fingerprint is distinct from pin.dependency_content_fingerprint then
      raise exception using errcode = '40001',
        message = 'Application installation bindings changed or are incomplete';
    end if;

    select provision.* into strict storage_provision
    from vortex_record.read_exact_module_storage_provision(
      pin.target_root_id, pin.target_release_revision
    ) as provision;
    if storage_provision.module_root_id is distinct from pin.target_root_id
      or storage_provision.release_revision is distinct from pin.target_release_revision
      or storage_provision.storage_contract_ids is null
      or (
        pg_catalog.cardinality(storage_provision.storage_contract_ids) > 0
        and (
          pg_catalog.array_ndims(storage_provision.storage_contract_ids) is distinct from 1
          or pg_catalog.array_lower(storage_provision.storage_contract_ids, 1) is distinct from 1
        )
      )
      or locked_binding.storage_contract_ids is distinct from storage_provision.storage_contract_ids
      or exists (
        select 1
        from pg_catalog.unnest(storage_provision.storage_contract_ids) as stored(contract_id)
        where stored.contract_id is null
          or stored.contract_id = '00000000-0000-0000-0000-000000000000'::uuid
      ) then
      raise exception using errcode = '40001',
        message = 'Application installation storage evidence changed or is incomplete';
    end if;

    select pg_catalog.count(*),
      pg_catalog.count(distinct stored.contract_id)
    into storage_contract_id_count, distinct_storage_contract_id_count
    from pg_catalog.unnest(storage_provision.storage_contract_ids) as stored(contract_id);
    if storage_contract_id_count <> distinct_storage_contract_id_count then
      raise exception using errcode = '40001',
        message = 'Application installation storage evidence is invalid';
    end if;

    all_storage_contract_ids := all_storage_contract_ids || storage_provision.storage_contract_ids;
    module_bindings := module_bindings || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'moduleRootId', pin.target_root_id,
        'moduleReleaseRevision', pin.target_release_revision,
        'bindingRevision', locked_binding.binding_revision,
        'state', 'provisioned',
        'storageContractIds', pg_catalog.to_jsonb(storage_provision.storage_contract_ids)
      )
    );
  end loop;

  select coalesce(
      pg_catalog.array_agg(distinct stored.contract_id order by stored.contract_id),
      array[]::uuid[]
    )
  into union_storage_contract_ids
  from pg_catalog.unnest(all_storage_contract_ids) as stored(contract_id);

  select locked.* into strict current_authority
  from vortex_access.lock_application_installation_authority() as locked;
  select evaluated.* into strict install_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        -- guard-allow: function-uuid fixed platform permission identity; the owner role has no read access to the declarations table
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba' -- guard-allow: function-uuid fixed platform permission identity; the owner role has no read access to the declarations table
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  select evaluated.* into strict install_scope_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install_scope',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        -- guard-allow: function-uuid fixed platform permission identity; the owner role has no read access to the declarations table
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba' -- guard-allow: function-uuid fixed platform permission identity; the owner role has no read access to the declarations table
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'organization_catalogue'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      )
    )
  ) as evaluated;
  current_context := vortex_access.validated_human_request_context();
  if current_authority.organization_id is distinct from initial_authority.organization_id
    or current_authority.organization_account_id is distinct from initial_authority.organization_account_id
    or current_authority.access_version is distinct from initial_authority.access_version
    or current_authority.correlation_id is distinct from initial_authority.correlation_id
    or current_context is distinct from initial_context
    or current_context ->> 'callerKind' is distinct from 'human'
    or (current_context ->> 'organizationId')::uuid is distinct from current_authority.organization_id
    or (current_context ->> 'organizationAccountId')::uuid is distinct from current_authority.organization_account_id
    or (current_context ->> 'accessVersion')::bigint is distinct from current_authority.access_version
    or (current_context ->> 'correlationId')::uuid is distinct from current_authority.correlation_id
    or (current_context ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    raise exception using errcode = '40001',
      message = 'Application installation authority changed';
  end if;

  if install_decision.outcome is distinct from 'eligible'
    or install_decision.operation_key is distinct from
      'platform.organization.applications.install'
    or install_decision.target_kind is distinct from 'organization'
    or install_decision.target_application_root_id is not null
    or install_decision.organization_id is distinct from current_authority.organization_id
    or install_decision.organization_account_id is distinct from current_authority.organization_account_id
    or install_decision.access_version is distinct from current_authority.access_version
    or install_decision.correlation_id is distinct from current_authority.correlation_id
    or install_decision.reason_code is not null
    or install_scope_decision.outcome is distinct from 'eligible'
    or install_scope_decision.operation_key is distinct from
      'platform.organization.applications.install_scope'
    or install_scope_decision.target_kind is distinct from 'organization'
    or install_scope_decision.target_application_root_id is not null
    or install_scope_decision.organization_id is distinct from current_authority.organization_id
    or install_scope_decision.organization_account_id is distinct from
      current_authority.organization_account_id
    or install_scope_decision.access_version is distinct from current_authority.access_version
    or install_scope_decision.correlation_id is distinct from current_authority.correlation_id
    or install_scope_decision.reason_code is not null then
    raise exception using errcode = '42501',
      message = 'Application installation authority is unavailable';
  end if;

  completion_time := pg_catalog.clock_timestamp();
  context_expires_at := (current_context ->> 'expiresAt')::timestamptz;
  if install_decision.checked_at is null
    or install_decision.checked_at > completion_time
    or install_decision.valid_until is null
    or install_decision.valid_until <= completion_time
    or install_scope_decision.checked_at is null
    or install_scope_decision.checked_at > completion_time
    or install_scope_decision.valid_until is null
    or install_scope_decision.valid_until <= completion_time
    or not pg_catalog.isfinite(context_expires_at)
    or context_expires_at <= completion_time then
    raise exception using errcode = '42501',
      message = 'Application installation context expired';
  end if;
  if current_context ? 'delegatedContext' then
    delegated_expires_at := (current_context #>> '{delegatedContext,expiresAt}')::timestamptz;
    if not pg_catalog.isfinite(delegated_expires_at)
      or delegated_expires_at <= completion_time then
      raise exception using errcode = '42501',
        message = 'Application installation delegation expired';
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', initial_authority.organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'registrationRevision', permission_snapshot.registration_revision,
    'moduleBindings', module_bindings,
    'storageContractIds', pg_catalog.to_jsonb(union_storage_contract_ids)
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Application lifecycle setup evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Application lifecycle setup evidence is ambiguous';
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Provisioned Application lifecycle setup command is invalid';
end
$function$;
alter function vortex_definition.read_provisioned_lifecycle_setup_targets_internal(uuid,bigint,jsonb) owner to vortex_owner;


alter function vortex_definition.read_provisioned_lifecycle_setup_targets_internal(uuid,bigint,jsonb)
  owner to vortex_owner;

revoke all on function vortex_definition.read_provisioned_lifecycle_setup_targets_internal(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.read_provisioned_lifecycle_setup_targets_internal(uuid, bigint, jsonb)
  to vortex_owner;
comment on function vortex_definition.read_provisioned_lifecycle_setup_targets_internal(uuid, bigint, jsonb) is
  'Module-owned complete exact provisioned lifecycle setup targets for the authorized Record setup reader.';

CREATE OR REPLACE FUNCTION vortex_access.apply_application_permission_registration_v1_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(operation text, organization_id uuid, application_root_id uuid, registration_state text, registration_revision bigint, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  operation_at timestamptz;
  candidate_organization_id uuid;
  candidate_application_root_id uuid;
  candidate_release jsonb;
  candidate_release_revision bigint;
  candidate_release_version text;
  candidate_validation_version text;
  candidate_content_fingerprint text;
  candidate_resolution_fingerprint text;
  candidate_catalogue_fingerprint text;
  supplied_candidate_fingerprint text;
  current_registration vortex_access.permission_registrations%rowtype;
  next_revision bigint;
  resulting_version bigint;
  entry_value jsonb;
  permission_value jsonb;
  source_value jsonb;
  entry_owner_kind text;
  entry_owner_id uuid;
  entry_source_revision bigint;
  canonical_application_permissions jsonb;
begin
  if p_operation not in ('register', 'update', 'reactivate')
    or p_candidate is null
    or pg_catalog.jsonb_typeof(p_candidate) <> 'object'
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'register' and p_expected_revision is not null)
    or (p_operation <> 'register' and (p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991))
    or p_candidate - array[
      'contractVersion', 'organizationId', 'applicationRootId', 'applicationRelease',
      'applicationCatalogueFingerprint', 'applicationPermissionIds', 'entries',
      'candidateFingerprint'
    ]::text[] <> '{}'::jsonb
    or not (p_candidate ?& array[
      'contractVersion', 'organizationId', 'applicationRootId', 'applicationRelease',
      'applicationCatalogueFingerprint', 'applicationPermissionIds', 'entries',
      'candidateFingerprint'
    ])
    or p_candidate ->> 'contractVersion' <> '1.0.0'
    or pg_catalog.jsonb_typeof(p_candidate -> 'applicationRelease') <> 'object'
    or pg_catalog.jsonb_typeof(p_candidate -> 'applicationPermissionIds') <> 'array'
    or pg_catalog.jsonb_typeof(p_candidate -> 'entries') <> 'array' then
    raise exception using errcode = '22023', message = 'Application permission registration input is invalid';
  end if;

  begin
    candidate_organization_id := (p_candidate ->> 'organizationId')::uuid;
    candidate_application_root_id := (p_candidate ->> 'applicationRootId')::uuid;
    candidate_release := p_candidate -> 'applicationRelease';
    candidate_release_revision := (candidate_release ->> 'releaseRevision')::bigint;
    candidate_release_version := candidate_release ->> 'releaseVersion';
    candidate_validation_version := candidate_release ->> 'validationContractVersion';
    candidate_content_fingerprint := candidate_release ->> 'contentFingerprint';
    candidate_resolution_fingerprint := candidate_release ->> 'resolutionFingerprint';
    candidate_catalogue_fingerprint := p_candidate ->> 'applicationCatalogueFingerprint';
    supplied_candidate_fingerprint := p_candidate ->> 'candidateFingerprint';
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'Application permission registration input is invalid';
  end;

  if candidate_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or candidate_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or candidate_release - array[
      'kind', 'definitionKey', 'rootId', 'releaseRevision', 'releaseVersion',
      'validationContractVersion', 'contentFingerprint', 'resolutionFingerprint'
    ]::text[] <> '{}'::jsonb
    or not (candidate_release ?& array[
      'kind', 'definitionKey', 'rootId', 'releaseRevision', 'releaseVersion',
      'validationContractVersion', 'contentFingerprint', 'resolutionFingerprint'
    ])
    or candidate_release ->> 'kind' <> 'application'
    or (candidate_release ->> 'rootId')::uuid <> candidate_application_root_id
    or candidate_release_revision not between 1 and 9007199254740991
    or candidate_catalogue_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or supplied_candidate_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Application permission registration input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = candidate_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501', message = 'Application permission registration scope is unavailable';
  end if;

  select release.compilation_output #> '{canonical,content,permissions}'
  into canonical_application_permissions
    from vortex_definition.roots as root
    join vortex_definition.releases as release on release.root_id = root.root_id
    where root.root_id = candidate_application_root_id
      and root.organization_id = candidate_organization_id
      and root.kind = 'application'
      and root.key = candidate_release ->> 'definitionKey'
      and release.release_revision = candidate_release_revision
      and release.release_version = candidate_release_version
      and release.validation_contract_version = candidate_validation_version
      and release.content_fingerprint = candidate_content_fingerprint
      and release.resolution_fingerprint = candidate_resolution_fingerprint;
  if not found
    or pg_catalog.jsonb_typeof(canonical_application_permissions) is distinct from 'array' then
    raise exception using errcode = '40001', message = 'Application permission release evidence is stale or unavailable';
  end if;

  for entry_value in
    select item.entry from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry)
  loop
    if pg_catalog.jsonb_typeof(entry_value) <> 'object'
      or entry_value - array[
        'applicationRootId', 'ownerKind', 'ownerId', 'permission',
        'sourceRelease', 'meaningFingerprint'
      ]::text[] <> '{}'::jsonb
      or (entry_value ->> 'applicationRootId')::uuid <> candidate_application_root_id
      or pg_catalog.jsonb_typeof(entry_value -> 'permission') <> 'object'
      or pg_catalog.jsonb_typeof(entry_value -> 'sourceRelease') <> 'object'
      or entry_value ->> 'meaningFingerprint' !~ '^sha256:[a-f0-9]{64}$' then
      raise exception using errcode = '22023', message = 'Application permission entry is invalid';
    end if;
    permission_value := entry_value -> 'permission';
    source_value := entry_value -> 'sourceRelease';
    begin
      entry_owner_kind := entry_value ->> 'ownerKind';
      entry_owner_id := (entry_value ->> 'ownerId')::uuid;
      entry_source_revision := (source_value ->> 'releaseRevision')::bigint;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode = '22023', message = 'Application permission entry is invalid';
    end;
    if entry_owner_kind not in ('application', 'module')
      or entry_owner_id = '00000000-0000-0000-0000-000000000000'::uuid
      or permission_value - array[
        'permissionId', 'key', 'label', 'description', 'recordTypeId',
        'recordScope', 'fieldPolicy', 'actionKind', 'namedAction', 'administrative'
      ]::text[] <> '{}'::jsonb
      or not (permission_value ?& array[
        'permissionId', 'key', 'label', 'description', 'actionKind', 'administrative'
      ])
      or (
        permission_value ? 'recordScope'
        and (
          permission_value ->> 'recordTypeId' is null
          or pg_catalog.jsonb_typeof(permission_value -> 'recordScope') is distinct from 'object'
        )
      )
      or (
        permission_value ? 'fieldPolicy'
        and (
          permission_value ->> 'recordTypeId' is null
          or not vortex_access.permission_field_policy_is_valid(
            permission_value -> 'fieldPolicy'
          )
        )
      )
      or source_value - array[
        'kind', 'definitionKey', 'rootId', 'releaseRevision', 'releaseVersion',
        'validationContractVersion', 'contentFingerprint', 'resolutionFingerprint'
      ]::text[] <> '{}'::jsonb
      or not (source_value ?& array[
        'kind', 'definitionKey', 'rootId', 'releaseRevision', 'releaseVersion',
        'validationContractVersion', 'contentFingerprint', 'resolutionFingerprint'
      ])
      or source_value ->> 'kind' <> entry_owner_kind
      or (source_value ->> 'rootId')::uuid <> entry_owner_id
      or entry_source_revision not between 1 and 9007199254740991 then
      raise exception using errcode = '22023', message = 'Application permission entry is invalid';
    end if;
    if entry_owner_kind = 'application' then
      if entry_owner_id <> candidate_application_root_id or source_value <> candidate_release then
        raise exception using errcode = '40001', message = 'Application permission ownership evidence is stale or unavailable';
      end if;
    elsif not exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(
        candidate_application_root_id, candidate_release_revision
      ) as dependency
      join vortex_definition.roots as module_root on module_root.root_id = dependency.target_root_id
      join vortex_definition.releases as module_release
        on module_release.root_id = dependency.target_root_id
        and module_release.release_revision = dependency.target_release_revision
      where dependency.target_root_id = entry_owner_id
        and dependency.target_release_revision = entry_source_revision
        and dependency.dependency_reference = source_value ->> 'definitionKey'
        and dependency.dependency_version = source_value ->> 'releaseVersion'
        and dependency.dependency_content_fingerprint = source_value ->> 'contentFingerprint'
        and module_root.organization_id = candidate_organization_id
        and module_root.kind = 'module'
        and module_root.key = source_value ->> 'definitionKey'
        and module_release.release_version = source_value ->> 'releaseVersion'
        and module_release.validation_contract_version = source_value ->> 'validationContractVersion'
        and module_release.content_fingerprint = source_value ->> 'contentFingerprint'
        and module_release.resolution_fingerprint = source_value ->> 'resolutionFingerprint'
    ) then
      raise exception using errcode = '40001', message = 'Module permission ownership evidence is stale or unavailable';
    end if;
  end loop;

  if coalesce(
    (
      select pg_catalog.jsonb_agg(stored.permission_value order by
        (stored.permission_value ->> 'key') collate "C",
        (stored.permission_value ->> 'permissionId') collate "C")
      from pg_catalog.jsonb_array_elements(canonical_application_permissions) as stored(permission_value)
    ),
    '[]'::jsonb
  ) is distinct from coalesce(
    (
      select pg_catalog.jsonb_agg(item.entry_value -> 'permission' order by
        (item.entry_value #>> '{permission,key}') collate "C",
        (item.entry_value #>> '{permission,permissionId}') collate "C")
      from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
      where item.entry_value ->> 'ownerKind' = 'application'
    ),
    '[]'::jsonb
  ) then
    raise exception using errcode = '40001', message = 'Application permission declarations are stale or unavailable';
  end if;

  if exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      candidate_application_root_id, candidate_release_revision
    ) as dependency
    join vortex_definition.releases as module_release
      on module_release.root_id = dependency.target_root_id
      and module_release.release_revision = dependency.target_release_revision
    where (
        pg_catalog.jsonb_typeof(
          module_release.compilation_output #> '{canonical,content,permissions}'
        ) is distinct from 'array'
        or coalesce(
          (
            select pg_catalog.jsonb_agg(stored.permission_value order by
              (stored.permission_value ->> 'key') collate "C",
              (stored.permission_value ->> 'permissionId') collate "C")
            from pg_catalog.jsonb_array_elements(
              module_release.compilation_output #> '{canonical,content,permissions}'
            ) as stored(permission_value)
          ),
          '[]'::jsonb
        ) is distinct from coalesce(
          (
            select pg_catalog.jsonb_agg(item.entry_value -> 'permission' order by
              (item.entry_value #>> '{permission,key}') collate "C",
              (item.entry_value #>> '{permission,permissionId}') collate "C")
            from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
            where item.entry_value ->> 'ownerKind' = 'module'
              and (item.entry_value ->> 'ownerId')::uuid = dependency.target_root_id
          ),
          '[]'::jsonb
        )
      )
  ) then
    raise exception using errcode = '40001', message = 'Module permission declarations are stale or unavailable';
  end if;

  if coalesce(
    (
      select pg_catalog.jsonb_agg(item.entry_value order by
        (item.entry_value ->> 'ownerKind') collate "C",
        (item.entry_value ->> 'ownerId') collate "C",
        (item.entry_value #>> '{permission,key}') collate "C",
        (item.entry_value #>> '{permission,permissionId}') collate "C")
      from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
    ),
    '[]'::jsonb
  ) <> p_candidate -> 'entries' then
    raise exception using errcode = '22023', message = 'Application permission entry order is invalid';
  end if;

  if (
    select coalesce(
      pg_catalog.jsonb_agg(permission.permission_value ->> 'permissionId' order by
        (permission.permission_value ->> 'key') collate "C",
        (permission.permission_value ->> 'permissionId') collate "C"),
      '[]'::jsonb
    )
    from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
    cross join lateral (select item.entry_value -> 'permission' as permission_value) as permission
    where item.entry_value ->> 'ownerKind' = 'application'
      and (permission.permission_value ->> 'administrative')::boolean = false
  ) <> p_candidate -> 'applicationPermissionIds' then
    raise exception using errcode = '22023', message = 'Application permission snapshot is invalid';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = candidate_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = candidate_application_root_id;

  if p_operation = 'register' then
    if found then
      raise exception using errcode = '40001', message = 'Application permission registration already exists';
    end if;
    next_revision := 1;
  else
    if not found
      or current_registration.revision <> p_expected_revision
      or current_registration.revision = 9007199254740991
      or (p_operation = 'update' and current_registration.state <> 'active')
      or (p_operation = 'reactivate' and current_registration.state <> 'withdrawn') then
      raise exception using errcode = '40001', message = 'Application permission registration revision is stale or unavailable';
    end if;
    next_revision := current_registration.revision + 1;
  end if;

  if p_operation = 'register' then
    operation_at := pg_catalog.clock_timestamp();
  else
    operation_at := greatest(
      current_registration.changed_at,
      pg_catalog.clock_timestamp()
    );
  end if;

  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision, state, operation, source_definition_key, source_version, source_revision, validation_contract_version, permission_catalogue_fingerprint, candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    candidate_organization_id, 'application', candidate_application_root_id, next_revision, 'active', p_operation, candidate_release ->> 'definitionKey', candidate_release_version, candidate_release_revision, candidate_validation_version, candidate_catalogue_fingerprint, supplied_candidate_fingerprint, operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id, registration_revision,
    application_root_id, owner_kind, owner_id, permission_id, permission_key,
    label, description, record_type_id, action_kind, named_action, administrative,
    source_kind, source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_catalogue_fingerprint, meaning_fingerprint,
    record_scope, field_policy
  )
  select candidate_organization_id, 'application', candidate_application_root_id,
    next_revision, candidate_application_root_id, item.entry_value ->> 'ownerKind',
    (item.entry_value ->> 'ownerId')::uuid,
    (permission.permission_value ->> 'permissionId')::uuid,
    permission.permission_value ->> 'key', permission.permission_value ->> 'label',
    permission.permission_value ->> 'description',
    (permission.permission_value ->> 'recordTypeId')::uuid,
    permission.permission_value ->> 'actionKind',
    permission.permission_value ->> 'namedAction',
    (permission.permission_value ->> 'administrative')::boolean,
    source.source_value ->> 'kind', source.source_value ->> 'definitionKey',
    (source.source_value ->> 'rootId')::uuid, source.source_value ->> 'releaseVersion',
    (source.source_value ->> 'releaseRevision')::bigint,
    source.source_value ->> 'validationContractVersion', null,
    item.entry_value ->> 'meaningFingerprint',
    permission.permission_value -> 'recordScope',
    permission.permission_value -> 'fieldPolicy'
  from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
  cross join lateral (select item.entry_value -> 'permission' as permission_value) as permission
  cross join lateral (select item.entry_value -> 'sourceRelease' as source_value) as source;

  if p_operation = 'register' then
    insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state, revision, source_definition_key, source_version, source_revision, validation_contract_version, permission_catalogue_fingerprint, candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    candidate_organization_id, 'application', candidate_application_root_id, 'active', next_revision, candidate_release ->> 'definitionKey', candidate_release_version, candidate_release_revision, candidate_validation_version, candidate_catalogue_fingerprint, supplied_candidate_fingerprint, operation_at, p_changed_by, p_correlation_id
  );
  else
    update vortex_access.permission_registrations as registration
    set state = 'active', revision = next_revision,
        source_definition_key = candidate_release ->> 'definitionKey',
        source_version = candidate_release_version,
        source_revision = candidate_release_revision,
        validation_contract_version = candidate_validation_version,
        permission_catalogue_fingerprint = candidate_catalogue_fingerprint,
        candidate_fingerprint = supplied_candidate_fingerprint,
        changed_at = operation_at, changed_by = p_changed_by,
        change_correlation_id = p_correlation_id
    where registration.organization_id = candidate_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = candidate_application_root_id;
  end if;

  select incremented.current_version into resulting_version
  from vortex_access.increment_organization_access_version(
    candidate_organization_id, p_changed_by, p_correlation_id, 'application_access_changed'
  ) as incremented;

  return query select p_operation, candidate_organization_id, candidate_application_root_id,
    'active'::text, next_revision, resulting_version, p_correlation_id;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'Application permission registration input is invalid';
end
$_$;

ALTER FUNCTION vortex_access.apply_application_permission_registration_v1_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) OWNER TO vortex_owner;

COMMENT ON FUNCTION vortex_access.apply_application_permission_registration_v1_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) IS 'Legacy raw registration writer retained privately for the coordinated application-access composition only.';

REVOKE ALL ON FUNCTION vortex_access.apply_application_permission_registration_v1_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

grant execute on function vortex_access.apply_application_permission_registration_v1_internal(p_operation text, p_expected_revision bigint, p_candidate jsonb, p_changed_by uuid, p_correlation_id uuid) to postgres;

reset role;
