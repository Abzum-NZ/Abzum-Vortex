-- Exact immutable Definition reads for the Application selected by trusted
-- human request context. The private projector has no request-role grant and
-- does not select or authorize roots on its own.

create function vortex_definition.project_consumer_release_evidence(
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
            'contentFingerprint', dependency.dependency_content_fingerprint,
            'resolutionFingerprint', dependency.evidence_fingerprint
          )
          when 'connection_type' then pg_catalog.jsonb_build_object(
            'kind', 'connection_type',
            'key', dependency.dependency_reference,
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
            'kind', 'platform_theme',
            'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint,
            'catalogueFingerprint', dependency.evidence_fingerprint
          )
        end
        order by dependency.dependency_kind collate "C",
          dependency.dependency_reference collate "C"
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

create function vortex_definition.read_application_bound_release_set(
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

  with recursive module_edges as (
    select dependency.root_id as source_root_id,
      dependency.target_root_id, dependency.target_release_revision,
      dependency.dependency_reference, dependency.dependency_version,
      dependency.dependency_content_fingerprint, dependency.evidence_fingerprint
    from vortex_definition.release_dependencies as dependency
    where dependency.root_id = application_root_id
      and dependency.release_revision = p_application_release_revision
      and dependency.dependency_kind = 'module'
    union
    select dependency.root_id, dependency.target_root_id,
      dependency.target_release_revision, dependency.dependency_reference,
      dependency.dependency_version, dependency.dependency_content_fingerprint,
      dependency.evidence_fingerprint
    from module_edges as parent
    join vortex_definition.release_dependencies as dependency
      on dependency.root_id = parent.target_root_id
      and dependency.release_revision = parent.target_release_revision
      and dependency.dependency_kind = 'module'
  )
  select pg_catalog.jsonb_agg(
    vortex_definition.project_consumer_release_evidence(
      'module', selected.target_root_id, selected.target_release_revision
    ) order by selected.target_root_id
  ) into module_evidence
  from (
    select distinct edge.target_root_id, edge.target_release_revision
    from module_edges as edge
  ) as selected;

  if module_evidence is null then
    raise exception using errcode = '23514', message = 'Application has no exact Module dependency set';
  end if;

  if exists (
    with recursive module_edges as (
      select dependency.target_root_id, dependency.target_release_revision,
        dependency.dependency_reference, dependency.dependency_version,
        dependency.dependency_content_fingerprint, dependency.evidence_fingerprint
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = application_root_id
        and dependency.release_revision = p_application_release_revision
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
    select 1
    from module_edges as edge
    left join vortex_definition.roots as root on root.root_id = edge.target_root_id
    left join vortex_definition.releases as release
      on release.root_id = edge.target_root_id
      and release.release_revision = edge.target_release_revision
    where root.kind is distinct from 'module'
      or root.key is distinct from edge.dependency_reference
      or release.release_version is distinct from edge.dependency_version
      or release.content_fingerprint is distinct from edge.dependency_content_fingerprint
      or release.resolution_fingerprint is distinct from edge.evidence_fingerprint
  ) or exists (
    with recursive module_nodes as (
      select dependency.target_root_id, dependency.target_release_revision
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = application_root_id
        and dependency.release_revision = p_application_release_revision
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
  ) then
    raise exception using errcode = '23514', message = 'Exact bound Module dependency evidence is inconsistent';
  end if;

  return pg_catalog.jsonb_build_object(
    'correlationId', checked_context ->> 'correlationId',
    'application', application_evidence,
    'modules', module_evidence
  );
end
$function$;

revoke all on function vortex_definition.project_consumer_release_evidence(text, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on function vortex_definition.read_application_bound_release_set(bigint)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_application_bound_release_set(bigint)
  to vortex_request;

comment on function vortex_definition.project_consumer_release_evidence(text, uuid, bigint) is
  'Owner-private projection of one exact immutable release; performs no scope selection.';
comment on function vortex_definition.read_application_bound_release_set(bigint) is
  'Returns the exact local Application and complete exact Module dependency closure selected by validated human application context.';
