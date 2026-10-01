-- Human Definition evidence reads for exact-draft compilation.

begin;

set local role postgres;

create or replace function vortex_definition.validated_builder_evidence_read_context_internal()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller_context jsonb;
  checked_context jsonb;
  permission_decision record;
begin
  caller_context := vortex_context.current_context();
  if caller_context ->> 'callerKind' = 'system' then
    return vortex_definition.validated_system_context();
  end if;

  if caller_context ->> 'callerKind' is distinct from 'human' then
    raise exception using errcode = '42501',
      message = 'Definition evidence read authority is unavailable';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.definition_drafts.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '0548c061-b1a9-48e5-a04a-eb1d0dae0644'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  checked_context := vortex_access.validated_human_request_context();
  if permission_decision.outcome is distinct from 'eligible'
    or checked_context is null
    or checked_context ->> 'callerKind' is distinct from 'human'
    or (checked_context ->> 'organizationId')::uuid
      is distinct from permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid
      is distinct from permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint
      is distinct from permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid
      is distinct from permission_decision.correlation_id then
    raise exception using errcode = '42501',
      message = 'Definition evidence read authority is unavailable';
  end if;

  return checked_context;
end
$function$;

revoke all on function vortex_definition.validated_builder_evidence_read_context_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_definition.validated_builder_evidence_read_context_internal() is
  'Returns the validated current system or human context for Definition evidence reads; human requests require definition-draft management permission.';

create or replace function vortex_definition.read_builder_application_root_key(
  p_root_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  application_key text;
begin
  checked_context := vortex_definition.validated_builder_evidence_read_context_internal();
  if p_root_id is null or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Definition builder root key requires a non-nil root identifier';
  end if;

  select root.key into application_key
  from vortex_definition.roots as root
  where root.root_id = p_root_id
    and root.organization_id = (checked_context ->> 'organizationId')::uuid
    and root.kind = 'application';

  if not found then
    return null;
  end if;
  return application_key;
end
$function$;

revoke all on function vortex_definition.read_builder_application_root_key(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_builder_application_root_key(uuid)
  to vortex_request;
comment on function vortex_definition.read_builder_application_root_key(uuid) is
  'Returns only the key of one same-organisation Application root for validated builder evidence reads.';

create or replace function vortex_definition.read_publication_state(
  p_root_id uuid
)
returns jsonb
language plpgsql
volatile
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
  checked_context := vortex_definition.validated_builder_evidence_read_context_internal();
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

revoke execute on function vortex_definition.read_publication_state(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_definition.read_publication_state(uuid) to vortex_request;

comment on function vortex_definition.read_publication_state(uuid) is
  'Returns one organisation-scoped Definition draft, permanent identity aliases and immutable publication evidence for server-side compilation.';

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

create or replace function vortex_definition.read_module_release_page(
  p_key text,
  p_anchor_release_revision bigint,
  p_after_release_revision bigint,
  p_page_size integer
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
  anchor_revision bigint;
  history_latest_release_revision bigint;
  entries jsonb;
  next_after bigint;
begin
  checked_context := vortex_definition.validated_builder_evidence_read_context_internal();
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

revoke all on function vortex_definition.read_module_release_page(text, bigint, bigint, integer) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.read_module_release_page(text, bigint, bigint, integer) to vortex_request;

comment on function vortex_definition.read_module_release_page(text, bigint, bigint, integer) is
  'Returns one anchored bounded oldest-first page of same-organisation immutable Module release evidence.';

create or replace function vortex_definition.read_module_release(
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
  context_organization_id uuid;
  root_row vortex_definition.roots%rowtype;
  release_row vortex_definition.releases%rowtype;
begin
  checked_context := vortex_definition.validated_builder_evidence_read_context_internal();
  context_organization_id := (checked_context ->> 'organizationId')::uuid;

  if p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_release_revision is null
    or p_release_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Definition module release read requires a root and release revision';
  end if;

  select root.* into root_row
  from vortex_definition.roots as root
  where root.root_id = p_root_id;

  if not found then
    return null;
  end if;

  if root_row.organization_id <> context_organization_id then
    raise exception using
      errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;

  if root_row.kind <> 'module' then
    return null;
  end if;

  select release.* into release_row
  from vortex_definition.releases as release
  where release.root_id = p_root_id
    and release.release_revision = p_release_revision;

  if not found then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', root_row.organization_id,
    'key', root_row.key,
    'rootId', release_row.root_id,
    'releaseRevision', release_row.release_revision,
    'releaseVersion', release_row.release_version,
    'contentFingerprint', release_row.content_fingerprint,
    'resolutionFingerprint', release_row.resolution_fingerprint,
    'compilationOutput', release_row.compilation_output,
    'resolutionSnapshot', release_row.resolution_snapshot,
    'identities', coalesce(release_row.resolution_snapshot -> 'identities', '[]'::jsonb),
    'published', pg_catalog.jsonb_build_object(
      'publication', pg_catalog.jsonb_build_object(
        'kind', 'module', 'rootId', release_row.root_id,
        'revision', release_row.release_revision, 'releaseVersion', release_row.release_version,
        'contentFingerprint', release_row.content_fingerprint,
        'publishedAt', release_row.published_at, 'publishedBy', release_row.published_by,
        'validationContractVersion', release_row.validation_contract_version
      ),
      'content', release_row.compilation_output -> 'canonical' -> 'content',
      'dependencyManifest', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'kind', 'module', 'rootId', target.root_id,
            'revision', target.release_revision, 'releaseVersion', target.release_version,
            'contentFingerprint', target.content_fingerprint,
            'publishedAt', target.published_at, 'publishedBy', target.published_by,
            'validationContractVersion', target.validation_contract_version
          ) order by target.root_id, target.release_revision
        ) from vortex_definition.release_dependencies as dependency
        join vortex_definition.releases as target
          on target.root_id = dependency.target_root_id
          and target.release_revision = dependency.target_release_revision
        where dependency.root_id = release_row.root_id
          and dependency.release_revision = release_row.release_revision
          and dependency.dependency_kind = 'module'
      ), '[]'::jsonb),
      'releaseNote', release_row.release_note
    )
  );
end
$function$;

revoke execute on function vortex_definition.read_module_release(uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_definition.read_module_release(uuid, bigint) to vortex_request;

comment on function vortex_definition.read_module_release(uuid, bigint) is
  'Reads one exact same-organisation immutable Module release and its stored compilation and resolution evidence.';

reset role;

commit;
