-- Private, system-context-only Definition publication operations.  The API
-- deliberately accepts compiled publication evidence but derives all mutable
-- draft, root, actor and timestamp evidence inside the transaction.

create or replace function vortex_definition.create_root(
  p_kind text,
  p_key text,
  p_draft_source jsonb,
  p_source_fingerprint text,
  p_identity_requirements jsonb
)
returns table (
  root_id uuid,
  organization_id uuid,
  kind text,
  definition_key text,
  draft_revision bigint,
  published_revision bigint,
  authored_source jsonb,
  source_contract_version text,
  source_fingerprint text,
  created_at timestamptz,
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  new_root_id uuid;
  operation_at timestamptz := pg_catalog.statement_timestamp();
  actor_id uuid;
begin
  checked_context := vortex_definition.validated_system_context();
  actor_id := (checked_context ->> 'systemActorId')::uuid;

  loop
    new_root_id := pg_catalog.gen_random_uuid();
    exit when new_root_id <> '00000000-0000-0000-0000-000000000000'::uuid;
  end loop;

  insert into vortex_definition.roots (
    root_id, organization_id, kind, key, created_at, created_by
  ) values (
    new_root_id,
    (checked_context ->> 'organizationId')::uuid,
    p_kind,
    p_key,
    operation_at,
    actor_id
  );

  perform vortex_definition.record_source_identities(
    new_root_id, p_identity_requirements, actor_id, operation_at
  );

  insert into vortex_definition.drafts (
    root_id, draft_revision, draft_source, source_contract_version,
    identity_requirements, source_fingerprint, updated_at, updated_by
  ) values (
    new_root_id,
    1,
    p_draft_source,
    p_draft_source ->> 'source_contract_version',
    p_identity_requirements,
    p_source_fingerprint,
    operation_at,
    actor_id
  );

  return query
  select
    root.root_id,
    root.organization_id,
    root.kind,
    root.key,
    draft.draft_revision,
    root.current_release_revision,
    draft.draft_source,
    draft.source_contract_version,
    draft.source_fingerprint,
    root.created_at,
    root.created_by,
    draft.updated_at,
    draft.updated_by
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.root_id = new_root_id;
end
$function$;

create or replace function vortex_definition.save_draft(
  p_root_id uuid,
  p_expected_revision bigint,
  p_draft_source jsonb,
  p_source_fingerprint text,
  p_identity_requirements jsonb
)
returns table (
  root_id uuid,
  organization_id uuid,
  kind text,
  definition_key text,
  draft_revision bigint,
  published_revision bigint,
  authored_source jsonb,
  source_contract_version text,
  source_fingerprint text,
  created_at timestamptz,
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  expected_organization_id uuid;
  root_organization_id uuid;
  saved_revision bigint;
  operation_at timestamptz := pg_catalog.statement_timestamp();
begin
  checked_context := vortex_definition.validated_system_context();
  expected_organization_id := (checked_context ->> 'organizationId')::uuid;

  if p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Definition draft save has an invalid root or expected revision';
  end if;

  select root.organization_id
  into root_organization_id
  from vortex_definition.roots as root
  where root.root_id = p_root_id;

  if not found then
    return;
  end if;

  if root_organization_id <> expected_organization_id then
    raise exception using
      errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;

  update vortex_definition.drafts as draft
  set
    draft_revision = draft.draft_revision + 1,
    draft_source = p_draft_source,
    identity_requirements = p_identity_requirements,
    source_contract_version = p_draft_source ->> 'source_contract_version',
    source_fingerprint = p_source_fingerprint,
    updated_at = operation_at,
    updated_by = (checked_context ->> 'systemActorId')::uuid
  where draft.root_id = p_root_id
    and draft.draft_revision = p_expected_revision
  returning draft.draft_revision into saved_revision;

  if saved_revision is null then
    return;
  end if;

  perform vortex_definition.record_source_identities(
    p_root_id,
    p_identity_requirements,
    (checked_context ->> 'systemActorId')::uuid,
    operation_at
  );

  return query
  select
    root.root_id,
    root.organization_id,
    root.kind,
    root.key,
    draft.draft_revision,
    root.current_release_revision,
    draft.draft_source,
    draft.source_contract_version,
    draft.source_fingerprint,
    root.created_at,
    root.created_by,
    draft.updated_at,
    draft.updated_by
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.root_id = p_root_id;
end
$function$;

create function vortex_definition.read_publication_state(
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
begin
  checked_context := vortex_definition.validated_system_context();
  context_organization_id := (checked_context ->> 'organizationId')::uuid;

  if p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using
      errcode = '22023',
      message = 'Definition publication state requires a non-nil root identifier';
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

  select draft.* into draft_row
  from vortex_definition.drafts as draft
  where draft.root_id = p_root_id;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'A Definition root requires its current draft';
  end if;

  return pg_catalog.jsonb_build_object(
    'root', pg_catalog.jsonb_build_object(
      'rootId', root_row.root_id,
      'organizationId', root_row.organization_id,
      'kind', root_row.kind,
      'key', root_row.key,
      'currentReleaseRevision', root_row.current_release_revision,
      'createdAt', root_row.created_at,
      'createdBy', root_row.created_by
    ),
    'draft', pg_catalog.jsonb_build_object(
      'rootId', draft_row.root_id,
      'organizationId', root_row.organization_id,
      'kind', root_row.kind,
      'key', root_row.key,
      'draftRevision', draft_row.draft_revision,
      'publishedRevision', root_row.current_release_revision,
      'source', draft_row.draft_source,
      'sourceContractVersion', draft_row.source_contract_version,
      'sourceFingerprint', draft_row.source_fingerprint,
      'createdAt', root_row.created_at,
      'createdBy', root_row.created_by,
      'updatedAt', draft_row.updated_at,
      'updatedBy', draft_row.updated_by
    ),
    'identities', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'definitionKey', root_row.key,
          'scope', requirement.value ->> 'scope',
          'kind', requirement.value ->> 'kind',
          'componentOwner', requirement.value ->> 'componentOwner',
          'alias', current_alias.value,
          'identifier', identity.identity_id
        ) order by
          requirement.value ->> 'scope',
          requirement.value ->> 'kind',
          current_alias.value
      )
      from pg_catalog.jsonb_array_elements(draft_row.identity_requirements) as requirement(value)
      cross join lateral pg_catalog.jsonb_array_elements_text(
        requirement.value -> 'aliases'
      ) as current_alias(value)
      join vortex_definition.source_identities as identity
        on identity.root_id = p_root_id
        and identity.owner_scope = requirement.value ->> 'ownerScope'
        and identity.kind = requirement.value ->> 'kind'
        and identity.component_owner = requirement.value ->> 'componentOwner'
      join vortex_definition.source_identity_aliases as alias
        on alias.root_id = p_root_id
        and alias.owner_scope = requirement.value ->> 'ownerScope'
        and alias.scope = requirement.value ->> 'scope'
        and alias.kind = requirement.value ->> 'kind'
        and alias.component_owner = requirement.value ->> 'componentOwner'
        and alias.alias = current_alias.value
        and alias.identity_id = identity.identity_id
    ), '[]'::jsonb),
    'history', pg_catalog.jsonb_build_object(
      'kind', root_row.kind,
      'definitionKey', root_row.key,
      'history', coalesce((
        select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'publication', pg_catalog.jsonb_build_object(
            'kind', root_row.kind,
            'rootId', release.root_id,
            'revision', release.release_revision,
            'releaseVersion', release.release_version,
            'contentFingerprint', release.content_fingerprint,
            'publishedAt', release.published_at,
            'publishedBy', release.published_by,
            'validationContractVersion', release.validation_contract_version
          ),
          'content', release.compilation_output -> 'canonical' -> 'content',
          'dependencyManifest', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'kind', 'module', 'rootId', target.root_id,
                'revision', target.release_revision, 'releaseVersion', target.release_version,
                'contentFingerprint', target.content_fingerprint,
                'publishedAt', target.published_at, 'publishedBy', target.published_by,
                'validationContractVersion', target.validation_contract_version
              ) order by target.root_id, target.release_revision
            )
            from vortex_definition.release_dependencies as dependency
            join vortex_definition.releases as target
              on target.root_id = dependency.target_root_id
              and target.release_revision = dependency.target_release_revision
            where dependency.root_id = release.root_id
              and dependency.release_revision = release.release_revision
              and dependency.dependency_kind = 'module'
          ), '[]'::jsonb),
          'releaseNote', release.release_note,
          'evidence', pg_catalog.jsonb_build_object(
            'authoredSource', release.authored_source,
            'authoredSourceFingerprint', release.authored_source_fingerprint,
            'sourceContractVersion', release.source_contract_version,
            'compilationOutput', release.compilation_output,
            'resolutionSnapshot', release.resolution_snapshot,
            'resolutionFingerprint', release.resolution_fingerprint,
            'comparisonFingerprint', release.comparison_fingerprint,
            'impactReasons', release.impact_reasons
          )
        ) order by release.release_revision
      )
        from vortex_definition.releases as release
        where release.root_id = p_root_id
      ), '[]'::jsonb)
    )
  );
end
$function$;

create function vortex_definition.list_module_releases(
  p_key text
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
begin
  checked_context := vortex_definition.validated_system_context();
  context_organization_id := (checked_context ->> 'organizationId')::uuid;

  if p_key is null
    or pg_catalog.char_length(p_key) not between 3 and 120
    or p_key !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
    or p_key ~ '(^|\.)[^.]{41,}(\.|$)' then
    raise exception using
      errcode = '22023',
      message = 'Definition module release lookup requires a valid namespaced key';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'organizationId', root.organization_id,
        'key', root.key,
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
            where dependency.root_id = release.root_id
              and dependency.release_revision = release.release_revision
              and dependency.dependency_kind = 'module'
          ), '[]'::jsonb),
          'releaseNote', release.release_note
        )
      ) order by release.release_version, release.release_revision
    )
    from vortex_definition.releases as release
    join vortex_definition.roots as root on root.root_id = release.root_id
    where root.organization_id = context_organization_id
      and root.kind = 'module'
      and root.key = p_key
  ), '[]'::jsonb);
end
$function$;

create function vortex_definition.read_module_release(
  p_root_id uuid,
  p_release_revision bigint
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
  release_row vortex_definition.releases%rowtype;
begin
  checked_context := vortex_definition.validated_system_context();
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

create function vortex_definition.append_release(
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
        case when supplied.value ->> 'kind' = 'platform_theme'
          then supplied.value ->> 'catalogueThemeId'
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
    supplied_reference := case when supplied_kind = 'platform_theme'
      then supplied_dependency ->> 'catalogueThemeId' else supplied_dependency ->> 'key' end;
    supplied_version := supplied_dependency ->> 'releaseVersion';
    supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
    supplied_evidence_fingerprint := case when supplied_kind = 'module'
      then supplied_dependency ->> 'resolutionFingerprint' else supplied_dependency ->> 'catalogueFingerprint' end;
    supplied_target_root_id := case when supplied_kind = 'module'
      then (supplied_dependency ->> 'rootId')::uuid else null end;
    supplied_target_release_revision := case when supplied_kind = 'module'
      then (supplied_dependency ->> 'releaseRevision')::bigint else null end;
    supplied_catalogue_item_id := case when supplied_kind = 'connection_type'
      then (supplied_dependency ->> 'rootId')::uuid else null end;

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

revoke execute on function vortex_definition.create_root(text, text, jsonb, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
revoke execute on function vortex_definition.save_draft(uuid, bigint, jsonb, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
revoke execute on function vortex_definition.read_publication_state(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_definition.list_module_releases(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_definition.read_module_release(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_definition.append_release(uuid, bigint, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_definition.create_root(text, text, jsonb, text, jsonb)
  to vortex_request;
grant execute on function vortex_definition.save_draft(uuid, bigint, jsonb, text, jsonb)
  to vortex_request;
grant execute on function vortex_definition.read_publication_state(uuid)
  to vortex_request;
grant execute on function vortex_definition.list_module_releases(text)
  to vortex_request;
grant execute on function vortex_definition.read_module_release(uuid, bigint)
  to vortex_request;
grant execute on function vortex_definition.append_release(uuid, bigint, text, jsonb)
  to vortex_request;

comment on function vortex_definition.read_publication_state(uuid) is
  'Returns one organisation-scoped Definition draft, permanent identity aliases and immutable publication evidence for server-side compilation.';
comment on function vortex_definition.list_module_releases(text) is
  'Lists same-organisation immutable Module release evidence for one namespaced dependency key.';
comment on function vortex_definition.read_module_release(uuid, bigint) is
  'Reads one exact same-organisation immutable Module release and its stored compilation and resolution evidence.';
comment on function vortex_definition.append_release(uuid, bigint, text, jsonb) is
  'Atomically records a validated compiled Definition release and exact dependencies, then advances only its root current-release pointer.';
