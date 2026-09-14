-- Publication preparation may audit every immutable release, but it must never
-- transport a root's entire history in one response.  Keep the root/draft
-- facts separate from one anchored keyset page of immutable evidence.

create or replace function vortex_definition.read_publication_state(
  p_root_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  context_organization_id uuid;
  root_row vortex_definition.roots%rowtype;
  draft_row vortex_definition.drafts%rowtype;
  history_latest_release_revision bigint;
begin
  checked_context := vortex_definition.validated_system_context();
  context_organization_id := (checked_context ->> 'organizationId')::uuid;
  if p_root_id is null or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Definition publication state requires a non-nil root identifier';
  end if;
  select root.* into root_row from vortex_definition.roots as root where root.root_id = p_root_id;
  if not found then return null; end if;
  if root_row.organization_id <> context_organization_id then
    raise exception using errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;
  select draft.* into draft_row from vortex_definition.drafts as draft where draft.root_id = p_root_id;
  if not found then
    raise exception using errcode = '23503', message = 'A Definition root requires its current draft';
  end if;
  select release.release_revision into history_latest_release_revision
  from vortex_definition.releases as release
  where release.root_id = p_root_id
  order by release.release_revision desc
  limit 1;
  return pg_catalog.jsonb_build_object(
    'root', pg_catalog.jsonb_build_object(
      'rootId', root_row.root_id, 'organizationId', root_row.organization_id,
      'kind', root_row.kind, 'key', root_row.key,
      'currentReleaseRevision', root_row.current_release_revision,
      'createdAt', root_row.created_at, 'createdBy', root_row.created_by
    ),
    'historyLatestReleaseRevision', history_latest_release_revision,
    'draft', pg_catalog.jsonb_build_object(
      'rootId', draft_row.root_id, 'organizationId', root_row.organization_id,
      'kind', root_row.kind, 'key', root_row.key, 'draftRevision', draft_row.draft_revision,
      'publishedRevision', root_row.current_release_revision, 'source', draft_row.draft_source,
      'sourceContractVersion', draft_row.source_contract_version,
      'sourceFingerprint', draft_row.source_fingerprint, 'createdAt', root_row.created_at,
      'createdBy', root_row.created_by, 'updatedAt', draft_row.updated_at,
      'updatedBy', draft_row.updated_by
    ),
    'identities', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'definitionKey', root_row.key, 'scope', requirement.value ->> 'scope',
        'kind', requirement.value ->> 'kind', 'componentOwner', requirement.value ->> 'componentOwner',
        'alias', current_alias.value, 'identifier', identity.identity_id
      ) order by requirement.value ->> 'scope', requirement.value ->> 'kind', current_alias.value)
      from pg_catalog.jsonb_array_elements(draft_row.identity_requirements) as requirement(value)
      cross join lateral pg_catalog.jsonb_array_elements_text(requirement.value -> 'aliases') as current_alias(value)
      join vortex_definition.source_identities as identity on identity.root_id = p_root_id
        and identity.owner_scope = requirement.value ->> 'ownerScope'
        and identity.kind = requirement.value ->> 'kind'
        and identity.component_owner = requirement.value ->> 'componentOwner'
      join vortex_definition.source_identity_aliases as alias on alias.root_id = p_root_id
        and alias.owner_scope = requirement.value ->> 'ownerScope'
        and alias.scope = requirement.value ->> 'scope' and alias.kind = requirement.value ->> 'kind'
        and alias.component_owner = requirement.value ->> 'componentOwner'
        and alias.alias = current_alias.value and alias.identity_id = identity.identity_id
    ), '[]'::jsonb)
  );
end
$function$;

create function vortex_definition.read_publication_history_page(
  p_root_id uuid, p_anchor_release_revision bigint, p_after_release_revision bigint, p_page_size integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  root_row vortex_definition.roots%rowtype;
  entries jsonb;
  next_after bigint;
begin
  checked_context := vortex_definition.validated_system_context();
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

revoke all on function vortex_definition.read_publication_history_page(uuid, bigint, bigint, integer)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_publication_history_page(uuid, bigint, bigint, integer)
  to vortex_request;

create function vortex_definition.read_module_release_page(
  p_key text,
  p_anchor_release_revision bigint,
  p_after_release_revision bigint,
  p_page_size integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  root_row vortex_definition.roots%rowtype;
  anchor_revision bigint;
  history_latest_release_revision bigint;
  entries jsonb;
  next_after bigint;
begin
  checked_context := vortex_definition.validated_system_context();
  if p_key is null
    or pg_catalog.char_length(p_key) not between 3 and 120
    or p_key !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
    or p_key ~ '(^|\.)[^.]{41,}(\.|$)'
    or p_page_size is null or p_page_size not between 1 and 100
    or (p_anchor_release_revision is null and p_after_release_revision is not null)
    or (p_anchor_release_revision is not null and
      (p_anchor_release_revision not between 1 and 9007199254740991
        or p_after_release_revision is null
        or p_after_release_revision not between 1 and p_anchor_release_revision - 1)) then
    raise exception using errcode = '22023',
      message = 'Definition module release page selector is invalid';
  end if;

  select root.* into root_row
  from vortex_definition.roots as root
  where root.organization_id = (checked_context ->> 'organizationId')::uuid
    and root.kind = 'module'
    and root.key = p_key;

  if not found or root_row.current_release_revision is null then
    return pg_catalog.jsonb_build_object(
      'rootId', null, 'anchorReleaseRevision', null,
      'entries', '[]'::jsonb, 'nextAfterReleaseRevision', null
    );
  end if;

  if p_anchor_release_revision is null then
    anchor_revision := root_row.current_release_revision;
    select release.release_revision into history_latest_release_revision
    from vortex_definition.releases as release
    where release.root_id = root_row.root_id
    order by release.release_revision desc
    limit 1;
    if history_latest_release_revision is distinct from anchor_revision then
      raise exception using errcode = '23514',
        message = 'Definition root current release pointer does not match immutable release history';
    end if;
  else
    anchor_revision := p_anchor_release_revision;
    if root_row.current_release_revision < anchor_revision
      or not exists (
        select 1 from vortex_definition.releases as release
        where release.root_id = root_row.root_id
          and release.release_revision = anchor_revision
      ) then
      raise exception using errcode = '40001',
        message = 'Definition module release page anchor is unavailable';
    end if;
  end if;

  with page as (
    select release.*
    from vortex_definition.releases as release
    where release.root_id = root_row.root_id
      and release.release_revision <= anchor_revision
      and (p_after_release_revision is null or release.release_revision > p_after_release_revision)
    order by release.release_revision asc
    limit p_page_size
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
      'organizationId', root_row.organization_id,
      'key', root_row.key,
      'rootId', release.root_id,
      'releaseRevision', release.release_revision,
      'releaseVersion', release.release_version,
      'contentFingerprint', release.content_fingerprint,
      'resolutionFingerprint', release.resolution_fingerprint,
      'compilationOutput', release.compilation_output,
      'resolutionSnapshot', release.resolution_snapshot,
      'identities', coalesce(release.resolution_snapshot -> 'identities', '[]'::jsonb),
      'published', pg_catalog.jsonb_build_object(
        'publication', pg_catalog.jsonb_build_object(
          'kind', 'module', 'rootId', release.root_id,
          'revision', release.release_revision, 'releaseVersion', release.release_version,
          'contentFingerprint', release.content_fingerprint,
          'publishedAt', release.published_at, 'publishedBy', release.published_by,
          'validationContractVersion', release.validation_contract_version
        ),
        'content', release.compilation_output -> 'canonical' -> 'content',
        'dependencyManifest', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'kind', 'module', 'rootId', target.root_id,
            'revision', target.release_revision, 'releaseVersion', target.release_version,
            'contentFingerprint', target.content_fingerprint,
            'publishedAt', target.published_at, 'publishedBy', target.published_by,
            'validationContractVersion', target.validation_contract_version
          ) order by target.root_id, target.release_revision)
          from vortex_definition.release_dependencies as dependency
          join vortex_definition.releases as target
            on target.root_id = dependency.target_root_id
            and target.release_revision = dependency.target_release_revision
          where dependency.root_id = release.root_id
            and dependency.release_revision = release.release_revision
            and dependency.dependency_kind = 'module'
        ), '[]'::jsonb),
        'releaseNote', release.release_note
      )
    )
  ) order by release.release_revision asc), '[]'::jsonb), max(release.release_revision)
  into entries, next_after
  from page as release;

  return pg_catalog.jsonb_build_object(
    'rootId', root_row.root_id,
    'anchorReleaseRevision', anchor_revision,
    'entries', entries,
    'nextAfterReleaseRevision', case when next_after = anchor_revision then null else next_after end
  );
end
$function$;

revoke all on function vortex_definition.read_module_release_page(text, bigint, bigint, integer)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_module_release_page(text, bigint, bigint, integer)
  to vortex_request;

drop function vortex_definition.list_module_releases(text);

comment on function vortex_definition.read_module_release_page(text, bigint, bigint, integer) is
  'Returns one anchored bounded oldest-first page of same-organisation immutable Module release evidence.';

-- Reinstall the current effective append function after removing only its
-- historical-count declaration, count scan and refusal. pg_get_functiondef is
-- used so this migration retains every subsequently-added lock, exact-dependency,
-- field-policy and transitive-closure check rather than reviving an older body.
do $block$
declare
  function_source text;
begin
  select pg_catalog.pg_get_functiondef('vortex_definition.append_release(uuid,bigint,text,jsonb)'::regprocedure)
    into function_source;
  if function_source is null
    or pg_catalog.strpos(function_source, 'release_count integer;') = 0
    or pg_catalog.strpos(function_source, 'Definition release history reached its supported limit') = 0 then
    raise exception 'Definition append release cap removal expected the current effective function';
  end if;
  function_source := pg_catalog.replace(function_source, E'  release_count integer;\n', '');
  function_source := pg_catalog.replace(function_source,
    E'  select pg_catalog.max(release.release_revision), pg_catalog.count(*)::integer\n  into expected_history_revision, release_count\n  from vortex_definition.releases as release\n  where release.root_id = p_root_id;\n',
    E'  expected_history_revision := root_row.current_release_revision;\n  if expected_history_revision is null then\n    if exists (select 1 from vortex_definition.releases as release where release.root_id = p_root_id) then\n      raise exception using errcode = \'23514\', message = \'Definition root current release pointer does not match immutable release history\';\n    end if;\n  elsif not exists (\n    select 1 from vortex_definition.releases as release\n    where release.root_id = p_root_id and release.release_revision = expected_history_revision\n  ) or exists (\n    select 1 from vortex_definition.releases as release\n    where release.root_id = p_root_id and release.release_revision > expected_history_revision\n  ) then\n    raise exception using errcode = \'23514\', message = \'Definition root current release pointer does not match immutable release history\';\n  end if;\n');
  function_source := pg_catalog.replace(function_source,
    E'\n  if release_count >= 10000 then\n    raise exception using\n      errcode = \'54000\',\n      message = \'Definition release history reached its supported limit\';\n  end if;\n', E'\n');
  if pg_catalog.strpos(function_source, 'release_count') <> 0
    or pg_catalog.strpos(function_source, 'Definition release history reached its supported limit') <> 0 then
    raise exception 'Definition append release cap removal was incomplete';
  end if;
  execute function_source;
end
$block$;

comment on function vortex_definition.read_publication_history_page(uuid, bigint, bigint, integer) is
  'Returns one anchored, bounded oldest-first keyset page of full immutable publication evidence for internal publication preparation.';
