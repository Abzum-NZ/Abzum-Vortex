set role vortex_owner;

drop function vortex_definition.read_rehearsed_preview_releases(uuid, jsonb);

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
    'releaseRevision', release.release_revision
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
  'Returns one anchored bounded oldest-first page of same-organisation immutable Module release locators; exact definitions are read once per snapshot in batches.';

alter function vortex_definition.read_module_release_page(p_key text, p_anchor_release_revision bigint, p_after_release_revision bigint, p_page_size integer) owner to vortex_owner;

grant execute on function vortex_definition.read_module_release_page(p_key text, p_anchor_release_revision bigint, p_after_release_revision bigint, p_page_size integer) to postgres;

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
    'authoredSource', release_row.authored_source,
    'authoredSourceFingerprint', release_row.authored_source_fingerprint,
    'sourceContractVersion', release_row.source_contract_version,
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

alter function vortex_definition.read_module_release(p_root_id uuid, p_release_revision bigint) owner to vortex_owner;

grant execute on function vortex_definition.read_module_release(p_root_id uuid, p_release_revision bigint) to postgres;

create or replace function vortex_definition.assert_preview_releases_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_releases jsonb
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  rehearsed_type record;
  application_release_revision_value bigint;
  releases_value jsonb := p_releases -> 'releases';
  checked_context jsonb;
  locked_access_version bigint;
begin
  if pg_catalog.jsonb_typeof(p_releases) is distinct from 'object'
    or pg_catalog.jsonb_typeof(releases_value) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_releases -> 'ownedRoots') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_releases -> 'usedRoots') is distinct from 'array'
    or p_releases #>> '{application,rootId}' is distinct from p_application_root_id::text then
    raise exception using errcode = '22023', message = 'Preview release plan is invalid';
  end if;

  -- Authority precedes root/draft locks. Compilation runs outside this short apply phase.
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id
  for share;
  if locked_access_version is distinct from (p_releases ->> 'accessVersion')::bigint
    or locked_access_version is distinct from (checked_context ->> 'accessVersion')::bigint then
    raise exception using errcode = '40001', message = 'Preview plan access context changed';
  end if;
  perform 1 from vortex_definition.roots as root
  where root.organization_id = p_organization_id
    and (root.root_id = p_application_root_id
      or root.owner_application_root_id = p_application_root_id
      or root.root_id in (select (item.value ->> 'rootId')::uuid
        from pg_catalog.jsonb_array_elements(p_releases -> 'usedRoots') as item(value)))
  order by root.root_id for share;
  perform 1 from vortex_definition.drafts as draft
  join vortex_definition.roots as root on root.root_id = draft.root_id
  where root.organization_id = p_organization_id
    and (root.root_id = p_application_root_id or root.owner_application_root_id = p_application_root_id)
  order by draft.root_id for share of draft;

  perform 1
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.root_id = p_application_root_id and root.organization_id = p_organization_id
    and root.kind = 'application'
    and draft.draft_revision = (p_releases #>> '{application,draftRevision}')::bigint
    and draft.source_fingerprint = p_releases #>> '{application,sourceFingerprint}'
    and root.current_release_revision is not distinct from
      (p_releases #>> '{application,currentReleaseRevision}')::bigint;
  if not found or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_releases -> 'ownedRoots') as item(value)
    where not exists (
      select 1 from vortex_definition.roots as root
      join vortex_definition.drafts as draft on draft.root_id = root.root_id
      where root.root_id = (item.value ->> 'rootId')::uuid
        and root.organization_id = p_organization_id and root.kind = 'module'
        and root.owner_application_root_id = p_application_root_id
        and root.key = item.value ->> 'key'
        and draft.draft_revision = (item.value ->> 'draftRevision')::bigint
        and draft.source_fingerprint = item.value ->> 'sourceFingerprint'
        and root.current_release_revision is not distinct from (item.value ->> 'currentReleaseRevision')::bigint
    )
  ) or (select pg_catalog.count(*) from vortex_definition.roots as root
    where root.organization_id = p_organization_id and root.owner_application_root_id = p_application_root_id)
      <> pg_catalog.jsonb_array_length(p_releases -> 'ownedRoots')
  or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_releases -> 'usedRoots') as item(value)
    where not exists (
      select 1 from vortex_definition.roots as root
      where root.root_id = (item.value ->> 'rootId')::uuid and root.organization_id = p_organization_id
        and root.kind = 'module'
        and root.current_release_revision = (item.value ->> 'currentReleaseRevision')::bigint
    )
  ) then
    raise exception using errcode = '40001', message = 'Preview plan definition inputs changed';
  end if;

  -- Every compiled row is bound to its exact permanent owned root and staged source. Repeated
  -- planning of a released draft is valid too: only the preview shadows that immutable row.
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(releases_value) as item(value)
    where pg_catalog.jsonb_typeof(item.value -> 'release') is distinct from 'object'
      or pg_catalog.jsonb_typeof(item.value -> 'dependencies') is distinct from 'array'
      or not exists (
        select 1 from vortex_definition.roots as root
        join vortex_definition.drafts as draft on draft.root_id = root.root_id
        where root.root_id = (item.value #>> '{release,root_id}')::uuid
          and root.organization_id = p_organization_id
          and (root.root_id = p_application_root_id
            or (root.kind = 'module' and root.owner_application_root_id = p_application_root_id))
          and draft.draft_revision = (item.value #>> '{release,release_revision}')::bigint
          and draft.source_fingerprint = item.value #>> '{release,authored_source_fingerprint}'
          and draft.draft_source = item.value #> '{release,authored_source}'
          and item.value #>> '{release,compilation_output,kind}' = root.kind
          and not exists (
            select 1 from pg_catalog.jsonb_array_elements(item.value -> 'dependencies') as dependency(value)
            where dependency.value ->> 'root_id' is distinct from root.root_id::text
              or dependency.value ->> 'release_revision' is distinct from draft.draft_revision::text
          )
      )
  ) or (select pg_catalog.count(*) <> pg_catalog.count(distinct item.value #>> '{release,root_id}')
    from pg_catalog.jsonb_array_elements(releases_value) as item(value)) then
    raise exception using errcode = '40001', message = 'Preview release plan source changed';
  end if;

  -- Exact dependency rows are either part of this plan or immutable releases of this organisation.
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(releases_value) as item(value)
    cross join lateral pg_catalog.jsonb_array_elements(item.value -> 'dependencies') as dependency(value)
    where dependency.value ->> 'dependency_kind' = 'module'
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(releases_value) as target(value)
        where target.value #>> '{release,root_id}' = dependency.value ->> 'target_root_id'
          and target.value #>> '{release,release_revision}' = dependency.value ->> 'target_release_revision'
          and target.value #>> '{release,release_version}' = dependency.value ->> 'dependency_version'
          and target.value #>> '{release,content_fingerprint}' = dependency.value ->> 'dependency_content_fingerprint'
      ) and not exists (
        select 1 from vortex_definition.releases as release
        join vortex_definition.roots as root on root.root_id = release.root_id
        where root.organization_id = p_organization_id and root.kind = 'module'
          and release.root_id = (dependency.value ->> 'target_root_id')::uuid
          and release.release_revision = (dependency.value ->> 'target_release_revision')::bigint
          and release.release_version = dependency.value ->> 'dependency_version'
          and release.content_fingerprint = dependency.value ->> 'dependency_content_fingerprint'
      )
  ) then
    raise exception using errcode = '40001', message = 'Preview plan dependencies changed';
  end if;
  -- A compiled plan may describe a new type, but cannot nominate another live or preview
  -- table for a type already installed in this Application. Check before replacing a preview.
  for rehearsed_type in
    select (item.value #>> '{release,root_id}')::uuid as module_root_id, record_type.value
    from pg_catalog.jsonb_array_elements(releases_value) as item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      item.value #> '{release,compilation_output,canonical,content,recordTypes}'
    ) as record_type(value)
    where item.value #>> '{release,compilation_output,kind}' = 'module'
      and not record_type.value ? 'systemProjection'
  loop
    perform vortex_record.resolve_preview_seed_source_internal(
      p_organization_id, p_application_root_id, rehearsed_type.module_root_id,
      (rehearsed_type.value ->> 'recordTypeId')::uuid,
      (rehearsed_type.value ->> 'storageContractId')::uuid
    );
  end loop;
  application_release_revision_value := (
    select (item.value #>> '{release,release_revision}')::bigint
    from pg_catalog.jsonb_array_elements(releases_value) as item(value)
    where (item.value #>> '{release,root_id}')::uuid = p_application_root_id
  );
  if application_release_revision_value is null then
    raise exception using errcode = 'P0002', message = 'Preview plan has no compiled Application release';
  end if;
  return application_release_revision_value;
end
$function$;

alter function vortex_definition.assert_preview_releases_internal(uuid, uuid, jsonb) owner to vortex_owner;

revoke all on function vortex_definition.assert_preview_releases_internal(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.assert_preview_releases_internal(uuid, uuid, jsonb)
  to vortex_owner;
comment on function vortex_definition.assert_preview_releases_internal(uuid, uuid, jsonb) is
  'Binds a server-compiled preview plan to the exact draft source, permanent owned roots, dependency anchors and access version under short shared locks; retains storage and seed-source ownership checks.';

create or replace function vortex_definition.create_preview_installation(
  p_application_root_id uuid,
  p_expected_draft_revision bigint,
  p_releases jsonb,
  p_shape_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_lifetime constant interval := interval '24 hours';
  checked_context jsonb;
  organization_id_value uuid;
  organization_account_id_value uuid;
  identity_id_value uuid;
  preview_installation_id_value uuid;
  draft_revision_value bigint;
  application_release_revision_value bigint;
  created_at_value timestamptz;
  expires_at_value timestamptz;
  previous_preview record;
begin
  if not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_releases #>> '{application,draftRevision}' is distinct from p_expected_draft_revision::text
    or p_shape_fingerprint is null
    or p_shape_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  organization_id_value := (checked_context ->> 'organizationId')::uuid;
  organization_account_id_value := (checked_context ->> 'organizationAccountId')::uuid;
  identity_id_value := (checked_context ->> 'identityId')::uuid;
  -- A preview is provisioned in the organisation's context: the Application it previews may have
  -- no installation, and so no Application context, yet.
  if checked_context ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Preview installation context is unavailable';
  end if;

  select draft.draft_revision
  into draft_revision_value
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.root_id = p_application_root_id
    and root.organization_id = organization_id_value
    and root.kind = 'application'
;
  if not found or draft_revision_value <> p_expected_draft_revision then
    raise exception using errcode = '40001', message = 'Application draft revision changed';
  end if;
  application_release_revision_value := vortex_definition.assert_preview_releases_internal(
    organization_id_value, p_application_root_id, p_releases
  );

  -- One preview per Application and builder: a new preview replaces this builder's previous one
  -- and its storage, never another builder's.
  for previous_preview in
    select preview.preview_installation_id
    from vortex_definition.preview_installations as preview
    where preview.organization_id = organization_id_value
      and preview.application_root_id = p_application_root_id
      and preview.previewer_organization_account_id = organization_account_id_value
    order by preview.preview_installation_id
    for update
  loop
    delete from vortex_definition.preview_installations as preview
    where preview.preview_installation_id = previous_preview.preview_installation_id;
  end loop;
  perform vortex_definition.expire_preview_installations(100);

  preview_installation_id_value := pg_catalog.gen_random_uuid();
  created_at_value := pg_catalog.statement_timestamp();
  expires_at_value := created_at_value + preview_lifetime;
  insert into vortex_definition.preview_installations (
    preview_installation_id, organization_id, application_root_id,
    draft_revision, application_release_revision, previewer_identity_id,
    previewer_organization_account_id, resolved_modules, storage_identities,
    created_at, expires_at, draft_shape_fingerprint
  ) values (
    preview_installation_id_value, organization_id_value, p_application_root_id,
    p_expected_draft_revision, application_release_revision_value, identity_id_value,
    organization_account_id_value, '[]'::jsonb, '[]'::jsonb,
    created_at_value, expires_at_value, p_shape_fingerprint
  );
  insert into vortex_definition.preview_releases (
    preview_installation_id, root_id, release_revision, release, dependencies
  )
  select preview_installation_id_value, (item.value #>> '{release,root_id}')::uuid,
    (item.value #>> '{release,release_revision}')::bigint,
    item.value -> 'release', item.value -> 'dependencies'
  from pg_catalog.jsonb_array_elements(p_releases -> 'releases') as item(value);
  perform vortex_definition.write_preview_shape_internal(preview_installation_id_value, false);

  return pg_catalog.jsonb_build_object(
    'previewInstallationId', preview_installation_id_value,
    'organizationId', organization_id_value,
    'applicationRootId', p_application_root_id,
    'draftRevision', p_expected_draft_revision,
    'applicationReleaseRevision', application_release_revision_value,
    'createdAt', created_at_value,
    'expiresAt', expires_at_value,
    -- The builder's live records reach the preview only through the installed Application.
    'seedable', exists (
      select 1
      from vortex_access.permission_registrations as registration
      where registration.organization_id = organization_id_value
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = p_application_root_id
        and registration.state = 'active'
    )
  );
end
$function$;

alter function vortex_definition.create_preview_installation(uuid, bigint, jsonb, text) owner to vortex_owner;

revoke all on function vortex_definition.create_preview_installation(uuid, bigint, jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.create_preview_installation(uuid, bigint, jsonb, text)
  to vortex_request;
comment on function vortex_definition.create_preview_installation(uuid, bigint, jsonb, text) is
  'Replaces the builder''s 24-hour preview of one Application with a preview of its current draft: the server-compiled release plan, the exact Module pins they and the used Module releases name, the preview''s own permission registration whose draft roles only its builder holds, empty isolated storage for every bound record type, and the fingerprint of the draft''s data shape.';

create or replace function vortex_definition.refresh_preview_installation(
  p_preview_installation_id uuid,
  p_expected_draft_revision bigint,
  p_releases jsonb,
  p_shape_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_lifetime constant interval := interval '24 hours';
  checked_context jsonb;
  preview_row vortex_definition.preview_installations%rowtype;
  draft_revision_value bigint;
  application_release_revision_value bigint;
  expires_at_value timestamptz;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text)
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_releases #>> '{application,draftRevision}' is distinct from p_expected_draft_revision::text
    or p_shape_fingerprint is null
    or p_shape_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  -- A preview follows its draft in its own request: its builder, its Application, its address.
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  if not checked_context ? 'applicationRootId'
    or vortex_definition.current_preview_installation_id_internal()
      is distinct from p_preview_installation_id then
    raise exception using errcode = '42501', message = 'Preview installation context is unavailable';
  end if;
  select preview.* into preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (checked_context ->> 'organizationId')::uuid
    and preview.application_root_id = (checked_context ->> 'applicationRootId')::uuid
    and preview.previewer_organization_account_id =
      (checked_context ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
  -- Reads of the preview (for key share) go on while it moves; a second move waits.
  for no key update;
  if not found then
    raise exception using errcode = '42501', message = 'Preview installation is unavailable';
  end if;
  select draft.draft_revision into draft_revision_value
  from vortex_definition.drafts as draft
  where draft.root_id = preview_row.application_root_id
;
  -- A preview only moves forward, to the current draft revision.
  if not found or draft_revision_value <> p_expected_draft_revision
    or p_expected_draft_revision < preview_row.draft_revision then
    raise exception using errcode = '40001', message = 'Application draft revision changed';
  end if;
  application_release_revision_value := vortex_definition.assert_preview_releases_internal(
    preview_row.organization_id, preview_row.application_root_id, p_releases
  );

  delete from vortex_definition.preview_releases as release
  where release.preview_installation_id = p_preview_installation_id;
  insert into vortex_definition.preview_releases (
    preview_installation_id, root_id, release_revision, release, dependencies
  )
  select p_preview_installation_id, (item.value #>> '{release,root_id}')::uuid,
    (item.value #>> '{release,release_revision}')::bigint,
    item.value -> 'release', item.value -> 'dependencies'
  from pg_catalog.jsonb_array_elements(p_releases -> 'releases') as item(value);
  -- Its registration is written again from the new releases and draft roles.
  delete from vortex_access.preview_permission_entries as entry
  where entry.preview_installation_id = p_preview_installation_id;
  delete from vortex_access.preview_permission_registrations as registration
  where registration.preview_installation_id = p_preview_installation_id;
  expires_at_value := pg_catalog.statement_timestamp() + preview_lifetime;
  -- The release set it runs is written again, in this same request, after the new pins.
  update vortex_definition.preview_installations as preview
  set draft_revision = p_expected_draft_revision,
      application_release_revision = application_release_revision_value,
      draft_shape_fingerprint = p_shape_fingerprint,
      runtime_release_set = null,
      expires_at = expires_at_value
  where preview.preview_installation_id = p_preview_installation_id;
  perform vortex_definition.write_preview_shape_internal(p_preview_installation_id, true);

  return pg_catalog.jsonb_build_object(
    'previewInstallationId', p_preview_installation_id,
    'organizationId', preview_row.organization_id,
    'applicationRootId', preview_row.application_root_id,
    'draftRevision', p_expected_draft_revision,
    'applicationReleaseRevision', application_release_revision_value,
    'createdAt', preview_row.created_at,
    'expiresAt', expires_at_value
  );
end
$function$;

alter function vortex_definition.refresh_preview_installation(uuid, bigint, jsonb, text) owner to vortex_owner;

revoke all on function vortex_definition.refresh_preview_installation(uuid, bigint, jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.refresh_preview_installation(uuid, bigint, jsonb, text)
  to vortex_request;
comment on function vortex_definition.refresh_preview_installation(uuid, bigint, jsonb, text) is
  'Moves the builder''s preview, in its own request, to the current draft revision in place: the server-compiled release plan, the Module pins, its permission registration and its Record storage, keeping the records it holds, and another 24 hours. Its release set is written again in the same request. A change the stored records cannot take raises V3201.';

reset role;
