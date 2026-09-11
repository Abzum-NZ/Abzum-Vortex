-- One owner for the Module dependency pin-set rule: an Application's
-- dependency closure pins each Module root at exactly one revision, with each
-- edge's evidence matching its target release.
--
-- vortex_definition.reachable_module_dependency_edges is that owner. It walks
-- the closure of one exact release, returns one row per Module root, and
-- raises 23514 when the stored closure breaks the rule. The only writer of
-- release_dependencies, vortex_definition.append_release, calls it before
-- advancing a root's current pointer, so no new inconsistent closure can be
-- stored. The bound reader, the active-installation reader, the storage
-- provisioner and the Application permission registry read their Module set
-- from it and no longer carry their own walks or consistency checks. Their
-- signatures, security modes, search paths, owners and grants are unchanged.

create function vortex_definition.reachable_module_dependency_edges(
  p_root_id uuid,
  p_release_revision bigint
)
returns table (
  target_root_id uuid,
  target_release_revision bigint,
  dependency_reference text,
  dependency_version text,
  dependency_content_fingerprint text,
  evidence_fingerprint text
)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  pin record;
begin
  -- UNION collapses edges that reach one target with identical evidence, so a
  -- root has one tuple exactly when every edge pins it at one revision with
  -- the same evidence. The release being resolved already pins its own root,
  -- so reaching that root again would pin it twice; this is also how a
  -- root-level cycle is refused.
  for pin in
    with recursive module_edges as (
      select dependency.target_root_id, dependency.target_release_revision,
        dependency.dependency_reference, dependency.dependency_version,
        dependency.dependency_content_fingerprint, dependency.evidence_fingerprint
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = p_root_id
        and dependency.release_revision = p_release_revision
        and dependency.dependency_kind = 'module'
      union
      select dependency.target_root_id, dependency.target_release_revision,
        dependency.dependency_reference, dependency.dependency_version,
        dependency.dependency_content_fingerprint, dependency.evidence_fingerprint
      from module_edges as parent
      join vortex_definition.release_dependencies as dependency
        on dependency.root_id = parent.target_root_id
        and dependency.release_revision = parent.target_release_revision
        and dependency.dependency_kind = 'module'
    )
    select edge.target_root_id, edge.target_release_revision,
      edge.dependency_reference, edge.dependency_version,
      edge.dependency_content_fingerprint, edge.evidence_fingerprint,
      pg_catalog.count(*) over (partition by edge.target_root_id) as root_pin_count,
      root.kind is distinct from 'module'
        or root.key is distinct from edge.dependency_reference
        or release.release_version is distinct from edge.dependency_version
        or release.content_fingerprint is distinct from edge.dependency_content_fingerprint
        or release.resolution_fingerprint is distinct from edge.evidence_fingerprint
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
    evidence_fingerprint := pin.evidence_fingerprint;
    return next;
  end loop;
end
$function$;

revoke all on function vortex_definition.reachable_module_dependency_edges(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.reachable_module_dependency_edges(uuid, bigint)
  to vortex_module_owner;
comment on function vortex_definition.reachable_module_dependency_edges(uuid, bigint) is
  'Owner-private Module dependency pin set of one exact release: one row per Module root; raises 23514 when a root is pinned at more than one revision or an edge disagrees with its target release.';

-- vortex_definition.append_release: the only writer of release_dependencies
-- now resolves the pin set of the release it is appending after storing its
-- manifest and before advancing the current pointer, so a refused closure
-- aborts the whole append. Everything else is unchanged from
-- 20260908041122_support_native_application_release_dependencies.sql.
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
  comparison_fingerprint text,
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
  supplied_evidence_fingerprint text;
  supplied_target_root_id uuid;
  supplied_target_release_revision bigint;
  supplied_catalogue_item_id uuid;
  dependency_count integer := 0;
  inserted_dependency_count integer := 0;
  expected_history_revision bigint;
  release_count integer;
  release_version_value text;
  compilation_output_value jsonb;
  resolution_snapshot_value jsonb;
  content_fingerprint_value text;
  resolution_fingerprint_value text;
  validation_contract_version_value text;
  comparison_fingerprint_value text;
  impact_reasons_value jsonb;
  release_note_value text;
  dependency_manifest_value jsonb;
begin
  checked_context := vortex_definition.validated_system_context();
  context_organization_id := (checked_context ->> 'organizationId')::uuid;
  context_actor_id := (checked_context ->> 'systemActorId')::uuid;

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
        'comparisonFingerprint', 'impactReasons', 'releaseNote', 'dependencies'
      )
    )
    or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(p_release)
    ) <> 10 then
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
  comparison_fingerprint_value := p_release ->> 'comparisonFingerprint';
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
    or comparison_fingerprint_value !~ '^sha256:[a-f0-9]{64}$'
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

  select pg_catalog.max(release.release_revision), pg_catalog.count(*)::integer
  into expected_history_revision, release_count
  from vortex_definition.releases as release
  where release.root_id = p_root_id;

  if root_row.current_release_revision is distinct from expected_history_revision then
    raise exception using
      errcode = '23514',
      message = 'Definition root current release pointer does not match immutable release history';
  end if;

  if release_count >= 10000 then
    raise exception using
      errcode = '54000',
      message = 'Definition release history reached its supported limit';
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
          'contentFingerprint', 'resolutionFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 7 then
        raise exception using errcode = '22023', message = 'Module dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'key';
      supplied_target_root_id := (supplied_dependency ->> 'rootId')::uuid;
      supplied_target_release_revision := (supplied_dependency ->> 'releaseRevision')::bigint;
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_evidence_fingerprint := supplied_dependency ->> 'resolutionFingerprint';
      supplied_catalogue_item_id := null;
      if supplied_reference !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
        or pg_catalog.char_length(supplied_reference) not between 3 and 120
        or supplied_target_root_id is null
        or supplied_target_root_id = '00000000-0000-0000-0000-000000000000'::uuid
        or supplied_target_release_revision not between 1 and 9007199254740991
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or supplied_evidence_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or supplied_target_root_id = p_root_id
        or not exists (
          select 1
          from vortex_definition.releases as target_release
          join vortex_definition.roots as target_root on target_root.root_id = target_release.root_id
          where target_release.root_id = supplied_target_root_id
            and target_release.release_revision = supplied_target_release_revision
            and target_release.release_version = supplied_version
            and target_release.content_fingerprint = supplied_content_fingerprint
            and target_release.resolution_fingerprint = supplied_evidence_fingerprint
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
          'kind', 'key', 'rootId', 'releaseVersion', 'contentFingerprint', 'catalogueFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 6 then
        raise exception using errcode = '22023', message = 'Connection type dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'key';
      supplied_catalogue_item_id := (supplied_dependency ->> 'rootId')::uuid;
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_evidence_fingerprint := supplied_dependency ->> 'catalogueFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      if supplied_reference !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
        or pg_catalog.char_length(supplied_reference) not between 3 and 120
        or supplied_catalogue_item_id is null
        or supplied_catalogue_item_id = '00000000-0000-0000-0000-000000000000'::uuid
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or supplied_evidence_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
        raise exception using errcode = '22023', message = 'Connection type dependency has invalid evidence';
      end if;
    elsif supplied_kind = 'platform_block' then
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
        where supplied.key not in (
          'kind', 'blockId', 'releaseVersion', 'contentFingerprint', 'catalogueFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 5 then
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
      supplied_evidence_fingerprint := supplied_dependency ->> 'catalogueFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      if supplied_catalogue_item_id is null
        or supplied_catalogue_item_id = '00000000-0000-0000-0000-000000000000'::uuid
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or supplied_evidence_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
        raise exception using errcode = '22023', message = 'Platform block dependency has invalid evidence';
      end if;
    elsif supplied_kind = 'platform_theme' then
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
        where supplied.key not in (
          'kind', 'catalogueThemeId', 'releaseVersion', 'contentFingerprint', 'catalogueFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 5 then
        raise exception using errcode = '22023', message = 'Platform theme dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'catalogueThemeId';
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_evidence_fingerprint := supplied_dependency ->> 'catalogueFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      supplied_catalogue_item_id := null;
      if supplied_reference !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or supplied_reference = '00000000-0000-0000-0000-000000000000'
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or supplied_evidence_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
        raise exception using errcode = '22023', message = 'Platform theme dependency has invalid evidence';
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
          when 'platform_block' then supplied.value ->> 'blockId'
          else supplied.value ->> 'key'
        end as dependency_reference,
        pg_catalog.count(*) as duplicate_count
      from pg_catalog.jsonb_array_elements(dependency_manifest_value) as supplied(value)
      group by 1, 2
    ) as grouped
    where grouped.dependency_reference is null or grouped.duplicate_count <> 1
  ) then
    raise exception using errcode = '22023', message = 'Definition dependency manifest repeats or omits a subject';
  end if;

  insert into vortex_definition.releases (
    root_id, release_revision, release_version, authored_source,
    authored_source_fingerprint, source_contract_version, compilation_output, resolution_snapshot,
    content_fingerprint, resolution_fingerprint, validation_contract_version,
    comparison_fingerprint, impact_reasons, release_note, published_at, published_by
  ) values (
    p_root_id, draft_row.draft_revision, release_version_value, draft_row.draft_source,
    draft_row.source_fingerprint, draft_row.source_contract_version, compilation_output_value,
    resolution_snapshot_value,
    content_fingerprint_value, resolution_fingerprint_value, validation_contract_version_value,
    comparison_fingerprint_value, impact_reasons_value, release_note_value, operation_at,
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
    supplied_evidence_fingerprint := case when supplied_kind = 'module'
      then supplied_dependency ->> 'resolutionFingerprint' else supplied_dependency ->> 'catalogueFingerprint' end;
    supplied_target_root_id := case when supplied_kind = 'module'
      then (supplied_dependency ->> 'rootId')::uuid else null end;
    supplied_target_release_revision := case when supplied_kind = 'module'
      then (supplied_dependency ->> 'releaseRevision')::bigint else null end;
    supplied_catalogue_item_id := case supplied_kind
      when 'connection_type' then (supplied_dependency ->> 'rootId')::uuid
      when 'platform_block' then (supplied_dependency ->> 'blockId')::uuid
      else null
    end;

    insert into vortex_definition.release_dependencies (
      root_id, release_revision, dependency_kind, dependency_reference,
      dependency_version, dependency_content_fingerprint, evidence_fingerprint,
      target_root_id, target_release_revision, catalogue_item_id
    ) values (
      p_root_id, draft_row.draft_revision, supplied_kind, supplied_reference,
      supplied_version, supplied_content_fingerprint, supplied_evidence_fingerprint,
      supplied_target_root_id, supplied_target_release_revision, supplied_catalogue_item_id
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

  return query
  select
    release.root_id,
    release.release_revision,
    release.release_version,
    release.content_fingerprint,
    release.resolution_fingerprint,
    release.comparison_fingerprint,
    coalesce((
      select pg_catalog.jsonb_agg(
        case dependency.dependency_kind
          when 'module' then pg_catalog.jsonb_build_object(
            'kind', 'module', 'key', dependency.dependency_reference,
            'rootId', dependency.target_root_id,
            'releaseRevision', dependency.target_release_revision,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint,
            'resolutionFingerprint', dependency.evidence_fingerprint
          )
          when 'connection_type' then pg_catalog.jsonb_build_object(
            'kind', 'connection_type', 'key', dependency.dependency_reference,
            'rootId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint,
            'catalogueFingerprint', dependency.evidence_fingerprint
          )
          when 'platform_block' then pg_catalog.jsonb_build_object(
            'kind', 'platform_block',
            'blockId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint,
            'catalogueFingerprint', dependency.evidence_fingerprint
          )
          else pg_catalog.jsonb_build_object(
            'kind', 'platform_theme', 'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint,
            'catalogueFingerprint', dependency.evidence_fingerprint
          )
        end order by
          dependency.dependency_kind collate "C",
          dependency.dependency_reference collate "C"
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
  'Atomically records a validated compiled Definition release and exact dependencies, then advances only its root current-release pointer.';

-- vortex_definition.read_application_bound_release_set: the Module set is the
-- resolver's pin set. The reader's own consistency checks are removed because
-- the resolver raises the same 23514 refusal. Signature, volatility, security
-- mode, search path, validation order and returned evidence are unchanged.
create or replace function vortex_definition.read_application_bound_release_set(
  p_application_release_revision bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  application_root_id uuid;
  application_evidence jsonb;
  module_evidence jsonb;
begin
  checked_context := vortex_access.validated_human_request_context();
  if not checked_context ? 'applicationRootId'
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Application release-set context is invalid';
  end if;
  application_root_id := (checked_context ->> 'applicationRootId')::uuid;

  select vortex_definition.project_consumer_release_evidence(
    'application', root.root_id, p_application_release_revision
  ) into application_evidence
  from vortex_definition.roots as root
  where root.root_id = application_root_id
    and root.kind = 'application'
    and root.organization_id = (checked_context ->> 'organizationId')::uuid;
  if application_evidence is null then
    raise exception using errcode = 'P0002', message = 'Exact bound Application release is unavailable';
  end if;

  select pg_catalog.jsonb_agg(
    vortex_definition.project_consumer_release_evidence(
      'module', pin.target_root_id, pin.target_release_revision
    ) order by pin.target_root_id
  ) into module_evidence
  from vortex_definition.reachable_module_dependency_edges(
    application_root_id, p_application_release_revision
  ) as pin;

  if module_evidence is null then
    raise exception using errcode = '23514', message = 'Application has no exact Module dependency set';
  end if;

  return pg_catalog.jsonb_build_object(
    'correlationId', checked_context ->> 'correlationId',
    'application', application_evidence,
    'modules', module_evidence
  );
end
$function$;

revoke all on function vortex_definition.read_application_bound_release_set(bigint)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_application_bound_release_set(bigint)
  to vortex_request;
comment on function vortex_definition.read_application_bound_release_set(bigint) is
  'Returns the exact local Application and complete exact Module dependency closure selected by validated human application context.';

-- vortex_module.provision_module_installation_storage: the direct-edge-only
-- dependency check is replaced by membership in the resolver's pin set. The
-- pin set holds one row per Module root, so the requested root and revision
-- are accepted only when they are the Application's one pin for that root;
-- an inconsistent closure is refused by the resolver itself. Every other
-- check, lock, and retry/idempotency path below is byte-identical to the
-- delivered function. postgres does not retain CREATE on vortex_module
-- between migrations (it is granted and revoked inside the owning migration's
-- own transaction), so the replace runs as the function's existing owner,
-- which always has rights on its own schema and object.
set local role vortex_module_owner;
create or replace function vortex_module.provision_module_installation_storage(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_module_root_id uuid,
  p_module_release_revision bigint,
  p_expected_binding_revision bigint
)
returns table (
  state text,
  changed boolean,
  binding_revision bigint,
  application_root_id uuid,
  application_release_revision bigint,
  module_root_id uuid,
  module_release_revision bigint,
  content_fingerprint text,
  resolution_fingerprint text,
  generator_contract_version text,
  storage_contract_ids uuid[]
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  permission_decision record;
  delegation_decision record;
  checked_context jsonb;
  application_release vortex_definition.releases%rowtype;
  stored_binding vortex_module.installation_bindings%rowtype;
  provision record;
  next_binding_revision bigint;
  binding_exists boolean;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision not between 1 and 9007199254740991
    or p_module_root_id is null
    or p_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_module_release_revision not between 1 and 9007199254740991
    or (p_expected_binding_revision is not null
      and p_expected_binding_revision not between 1 and 9007199254740991) then
    raise exception using errcode = '22023', message = 'Module installation storage command is invalid';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501', message = 'Module installation authority is unavailable';
  end if;

  select evaluated.* into strict delegation_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install_scope',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'organization_catalogue'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      )
    )
  ) as evaluated;
  if delegation_decision.outcome is distinct from 'eligible'
    or delegation_decision.organization_id <> permission_decision.organization_id
    or delegation_decision.organization_account_id <> permission_decision.organization_account_id
    or delegation_decision.access_version <> permission_decision.access_version
    or delegation_decision.correlation_id <> permission_decision.correlation_id then
    raise exception using errcode = '42501', message = 'Module installation delegation is unavailable';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '40001', message = 'Module installation context changed';
  end if;

  -- The binding identity is locked before its row can exist. Storage lineage
  -- locks are acquired later by the Record helper in canonical UUID order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'vortex_module.binding:' || permission_decision.organization_id::text || ':' ||
        p_application_root_id::text || ':' || p_module_root_id::text,
      0
    )
  );

  select release.* into strict application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_application_root_id
    and release.release_revision = p_application_release_revision
    and root.kind = 'application'
    and root.organization_id = permission_decision.organization_id;
  if application_release.validation_contract_version <> '1.0.0'
    or application_release.compilation_output #>> '{kind}' <> 'application'
    or application_release.compilation_output #>> '{canonical,envelope,rootId}'
      <> p_application_root_id::text
    or application_release.compilation_output #>> '{validationContractVersion}' <> '1.0.0' then
    raise exception using errcode = '23514', message = 'Exact Application V1 release is unavailable';
  end if;
  if not exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as edge
    where edge.target_root_id = p_module_root_id
      and edge.target_release_revision = p_module_release_revision
  ) then
    raise exception using errcode = '23514', message = 'Exact application Module binding is unavailable';
  end if;

  select binding.* into stored_binding
  from vortex_module.installation_bindings as binding
  where binding.organization_id = permission_decision.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = p_module_root_id
  for update;
  binding_exists := found;

  if binding_exists then
    if stored_binding.state = 'active'
      or (
        p_expected_binding_revision is null
        and (
          stored_binding.application_release_revision <> p_application_release_revision
          or stored_binding.module_release_revision <> p_module_release_revision
          or stored_binding.state <> 'provisioned'
        )
      )
      or (
        p_expected_binding_revision is not null
        and stored_binding.binding_revision <> p_expected_binding_revision
      ) then
      raise exception using errcode = '40001', message = 'Module installation binding changed';
    end if;
  end if;
  if not binding_exists and p_expected_binding_revision is not null then
    raise exception using errcode = '40001', message = 'Module installation binding is unavailable';
  end if;

  select storage.* into strict provision
  from vortex_record.provision_exact_module_storage(
    p_module_root_id, p_module_release_revision
  ) as storage;

  if binding_exists
    and stored_binding.application_release_revision = p_application_release_revision
    and stored_binding.module_release_revision = p_module_release_revision
    and stored_binding.state = 'provisioned' then
    if stored_binding.content_fingerprint <> provision.content_fingerprint
      or stored_binding.resolution_fingerprint <> provision.resolution_fingerprint
      or stored_binding.generator_contract_version <> provision.generator_contract_version
      or stored_binding.storage_contract_ids <> provision.storage_contract_ids then
      raise exception using errcode = '55000', message = 'Stored Module installation evidence is incompatible';
    end if;
    return query select stored_binding.state, false, stored_binding.binding_revision,
      stored_binding.application_root_id, stored_binding.application_release_revision,
      stored_binding.module_root_id, stored_binding.module_release_revision,
      stored_binding.content_fingerprint, stored_binding.resolution_fingerprint,
      stored_binding.generator_contract_version, stored_binding.storage_contract_ids;
    return;
  end if;

  if binding_exists then
    if stored_binding.binding_revision = 9007199254740991 then
      raise exception using errcode = '22003', message = 'Module installation binding revision is exhausted';
    end if;
    next_binding_revision := stored_binding.binding_revision + 1;
    update vortex_module.installation_bindings as binding
    set binding_revision = next_binding_revision,
        application_release_revision = p_application_release_revision,
        module_release_revision = p_module_release_revision,
        state = 'provisioned',
        content_fingerprint = provision.content_fingerprint,
        resolution_fingerprint = provision.resolution_fingerprint,
        generator_contract_version = provision.generator_contract_version,
        storage_contract_ids = provision.storage_contract_ids,
        changed_at = pg_catalog.statement_timestamp()
    where binding.organization_id = permission_decision.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = p_module_root_id
      and binding.binding_revision = p_expected_binding_revision;
    if not found then
      raise exception using errcode = '40001', message = 'Module installation binding changed';
    end if;
  else
    next_binding_revision := 1;
    insert into vortex_module.installation_bindings (
      organization_id, application_root_id, module_root_id, binding_revision,
      application_release_revision, module_release_revision, state,
      content_fingerprint, resolution_fingerprint, generator_contract_version,
      storage_contract_ids
    ) values (
      permission_decision.organization_id, p_application_root_id, p_module_root_id, 1,
      p_application_release_revision, p_module_release_revision, 'provisioned',
      provision.content_fingerprint, provision.resolution_fingerprint,
      provision.generator_contract_version, provision.storage_contract_ids
    );
  end if;

  return query select 'provisioned'::text, true, next_binding_revision,
    p_application_root_id, p_application_release_revision, p_module_root_id,
    p_module_release_revision, provision.content_fingerprint,
    provision.resolution_fingerprint, provision.generator_contract_version,
    provision.storage_contract_ids;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Module installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module installation evidence is ambiguous';
end
$function$;

revoke all on function vortex_module.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) to vortex_request;
comment on function vortex_module.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) is 'Protected exact-release storage provisioning; commits only an inactive Module binding.';
reset role;

-- vortex_module.read_current_active_installation: the four recursive walks are
-- replaced by the resolver's pin set, which raises 23514 when the closure is
-- inconsistent. The comparisons between active bindings and pins, in both
-- directions, are the separate active-binding rule and are unchanged. The
-- replace runs as the function's existing owner for the reason given above.
set local role vortex_module_owner;
create or replace function vortex_module.read_current_active_installation()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  selected_organization_id uuid;
  selected_application_root_id uuid;
  selected_application_release_revision bigint;
  selected_bindings jsonb;
begin
  checked_context := vortex_access.validated_human_request_context();
  if not checked_context ? 'applicationRootId' then
    raise exception using errcode = '22023', message = 'Active Application context is required';
  end if;
  selected_organization_id := (checked_context ->> 'organizationId')::uuid;
  selected_application_root_id := (checked_context ->> 'applicationRootId')::uuid;

  select pg_catalog.min(binding.application_release_revision)
  into selected_application_release_revision
  from vortex_module.installation_bindings as binding
  where binding.organization_id = selected_organization_id
    and binding.application_root_id = selected_application_root_id
    and binding.state = 'active';
  if selected_application_release_revision is null then
    raise exception using errcode = 'P0002', message = 'Active Application installation is unavailable';
  end if;
  if exists (
    select 1 from vortex_module.installation_bindings as binding
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
      and release.compilation_output #>> '{kind}' = 'application'
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
    left join vortex_module.installation_bindings as binding
      on binding.organization_id = selected_organization_id
      and binding.application_root_id = selected_application_root_id
      and binding.module_root_id = node.target_root_id
    where binding.state is distinct from 'active'
      or binding.application_release_revision is distinct from selected_application_release_revision
      or binding.module_release_revision is distinct from node.target_release_revision
      or binding.content_fingerprint is distinct from node.dependency_content_fingerprint
      or binding.resolution_fingerprint is distinct from node.evidence_fingerprint
  ) or exists (
    select 1
    from vortex_module.installation_bindings as binding
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
  from vortex_module.installation_bindings as binding
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

revoke all on function vortex_module.read_current_active_installation()
  from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.read_current_active_installation()
  to vortex_request;
comment on function vortex_module.read_current_active_installation() is
  'Returns the complete exact active Module binding set selected from validated human Application context.';
reset role;

-- vortex_access.apply_application_permission_registration_v1_internal: the
-- Module set whose permissions an Application registration must carry is the
-- resolver's pin set, not the Application's direct dependencies. A Module
-- reached only through another Module now has its declared permissions
-- checked and registered. Everything else is unchanged from
-- 20260907223932_preserve_permission_field_policy.sql.
create or replace function vortex_access.apply_application_permission_registration_v1_internal(
  p_operation text,
  p_expected_revision bigint,
  p_candidate jsonb,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  operation text,
  organization_id uuid,
  application_root_id uuid,
  registration_state text,
  registration_revision bigint,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
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
        and dependency.evidence_fingerprint = source_value ->> 'resolutionFingerprint'
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
    organization_id, registration_kind, registration_owner_id, revision, state, operation,
    source_definition_key, source_version, source_revision, validation_contract_version,
    source_content_fingerprint, source_resolution_fingerprint,
    permission_catalogue_fingerprint, candidate_fingerprint,
    changed_at, changed_by, change_correlation_id
  ) values (
    candidate_organization_id, 'application', candidate_application_root_id,
    next_revision, 'active', p_operation, candidate_release ->> 'definitionKey', candidate_release_version,
    candidate_release_revision, candidate_validation_version,
    candidate_content_fingerprint, candidate_resolution_fingerprint,
    candidate_catalogue_fingerprint, supplied_candidate_fingerprint,
    operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id, registration_revision,
    application_root_id, owner_kind, owner_id, permission_id, permission_key,
    label, description, record_type_id, action_kind, named_action, administrative,
    source_kind, source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint, meaning_fingerprint,
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
    source.source_value ->> 'validationContractVersion',
    source.source_value ->> 'contentFingerprint',
    source.source_value ->> 'resolutionFingerprint', null,
    item.entry_value ->> 'meaningFingerprint',
    permission.permission_value -> 'recordScope',
    permission.permission_value -> 'fieldPolicy'
  from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
  cross join lateral (select item.entry_value -> 'permission' as permission_value) as permission
  cross join lateral (select item.entry_value -> 'sourceRelease' as source_value) as source;

  if p_operation = 'register' then
    insert into vortex_access.permission_registrations (
      organization_id, registration_kind, registration_owner_id, state, revision,
      source_definition_key, source_version, source_revision, validation_contract_version,
      source_content_fingerprint, source_resolution_fingerprint,
      permission_catalogue_fingerprint, candidate_fingerprint,
      changed_at, changed_by, change_correlation_id
    ) values (
      candidate_organization_id, 'application', candidate_application_root_id,
      'active', next_revision, candidate_release ->> 'definitionKey', candidate_release_version,
      candidate_release_revision,
      candidate_validation_version, candidate_content_fingerprint,
      candidate_resolution_fingerprint, candidate_catalogue_fingerprint,
      supplied_candidate_fingerprint, operation_at, p_changed_by, p_correlation_id
    );
  else
    update vortex_access.permission_registrations as registration
    set state = 'active', revision = next_revision,
        source_definition_key = candidate_release ->> 'definitionKey',
        source_version = candidate_release_version,
        source_revision = candidate_release_revision,
        validation_contract_version = candidate_validation_version,
        source_content_fingerprint = candidate_content_fingerprint,
        source_resolution_fingerprint = candidate_resolution_fingerprint,
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
$function$;

revoke execute on function
  vortex_access.apply_application_permission_registration_v1_internal(
    text, bigint, jsonb, uuid, uuid
  )
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
