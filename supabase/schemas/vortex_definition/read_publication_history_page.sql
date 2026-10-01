create or replace function vortex_definition.read_publication_history_page(
  p_root_id uuid, p_anchor_release_revision bigint, p_after_release_revision bigint, p_page_size integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  root_row vortex_definition.roots%rowtype;
  entries jsonb;
  next_after bigint;
begin
  checked_context := vortex_definition.validated_builder_evidence_read_context_internal();
  if p_root_id is null or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_anchor_release_revision is null or p_anchor_release_revision not between 1 and 9007199254740991
    or (p_after_release_revision is not null and p_after_release_revision not between 0 and p_anchor_release_revision)
    or p_page_size is null or p_page_size not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Definition publication history page selector is invalid';
  end if;
  select root.* into root_row from vortex_definition.roots as root where root.root_id = p_root_id;
  if not found then return null; end if;
  if root_row.organization_id <> (checked_context ->> 'organizationId')::uuid then
    raise exception using errcode = '42501', message = 'Definition root does not belong to the context organization';
  end if;
  if root_row.current_release_revision is distinct from p_anchor_release_revision then
    raise exception using errcode = '40001', message = 'Definition publication history anchor changed';
  end if;
  with page as (
    select release.* from vortex_definition.releases as release
    where release.root_id = p_root_id
      and release.release_revision <= p_anchor_release_revision
      and (p_after_release_revision is null or release.release_revision > p_after_release_revision)
    order by release.release_revision asc limit p_page_size
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'previousReleaseRevision', (
      select previous.release_revision
      from vortex_definition.releases as previous
      where previous.root_id = release.root_id
        and previous.release_revision < release.release_revision
      order by previous.release_revision desc
      limit 1
    ),
    'release', pg_catalog.jsonb_build_object(
      'publication', pg_catalog.jsonb_build_object(
      'kind', root_row.kind, 'rootId', release.root_id, 'revision', release.release_revision,
      'releaseVersion', release.release_version, 'contentFingerprint', release.content_fingerprint,
      'publishedAt', release.published_at, 'publishedBy', release.published_by,
      'validationContractVersion', release.validation_contract_version),
      'content', release.compilation_output -> 'canonical' -> 'content',
      'dependencyManifest', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'kind','module','rootId',target.root_id,'revision',target.release_revision,
      'releaseVersion',target.release_version,'contentFingerprint',target.content_fingerprint,
      'publishedAt',target.published_at,'publishedBy',target.published_by,
      'validationContractVersion',target.validation_contract_version) order by target.root_id,target.release_revision)
      from vortex_definition.release_dependencies as dependency
      join vortex_definition.releases as target on target.root_id = dependency.target_root_id
        and target.release_revision = dependency.target_release_revision
      where dependency.root_id = release.root_id and dependency.release_revision = release.release_revision
        and dependency.dependency_kind = 'module'), '[]'::jsonb),
      'releaseNote', release.release_note,
      'evidence', pg_catalog.jsonb_build_object('authoredSource',release.authored_source,
      'authoredSourceFingerprint',release.authored_source_fingerprint,
      'sourceContractVersion',release.source_contract_version,'compilationOutput',release.compilation_output,
      'resolutionSnapshot',release.resolution_snapshot,'resolutionFingerprint',release.resolution_fingerprint,
        'comparisonFingerprint',release.comparison_fingerprint,'impactReasons',release.impact_reasons)
    )
  ) order by release.release_revision asc), '[]'::jsonb), max(release.release_revision)
  into entries, next_after from page as release;
  return pg_catalog.jsonb_build_object('anchorReleaseRevision', p_anchor_release_revision,
    'entries', entries,
    'nextAfterReleaseRevision', case when next_after = p_anchor_release_revision then null else next_after end);
end
$function$;

revoke all on function vortex_definition.read_publication_history_page(uuid, bigint, bigint, integer) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.read_publication_history_page(uuid, bigint, bigint, integer) to vortex_request;

comment on function vortex_definition.read_publication_history_page(uuid, bigint, bigint, integer) is
  'Returns one anchored, bounded oldest-first keyset page of full immutable publication evidence for internal publication preparation.';
