-- Reinstall the canonical definitions and grants for the Connection and Definition schema owners.

begin;

-- Canonical vortex_connection.append_application_grant_activity_internal.
create or replace function vortex_connection.append_application_grant_activity_internal(
  p_context jsonb,
  p_activity_id uuid,
  p_connection_instance_id uuid,
  p_application_root_id uuid,
  p_action text,
  p_occurred_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  actor_kind text;
  actor_id uuid;
  subject_ids uuid[];
begin
  if p_context ->> 'callerKind' = 'human' then
    actor_kind := 'organization_account';
    actor_id := (p_context ->> 'organizationAccountId')::uuid;
  elsif p_context ->> 'callerKind' = 'system' then
    actor_kind := 'system';
    actor_id := (p_context ->> 'systemActorId')::uuid;
  else
    raise exception using
      errcode = '42501',
      message = 'Connection grant Activity requires validated human or system context';
  end if;

  select pg_catalog.array_agg(subject_id order by subject_id)
  into subject_ids
  from (
    select distinct candidate.subject_id
    from pg_catalog.unnest(array[p_connection_instance_id, p_application_root_id])
      as candidate(subject_id)
  ) as canonical_subjects;

  perform vortex_activity.append_organization_activity_entry(
    (p_context ->> 'organizationId')::uuid,
    p_activity_id,
    p_occurred_at,
    actor_kind,
    actor_id,
    p_action,
    subject_ids,
    array[]::uuid[],
    'connection',
    (p_context ->> 'correlationId')::uuid,
    'completed'
  );
end;
$function$;

revoke all on function vortex_connection.append_application_grant_activity_internal(jsonb, uuid, uuid, uuid, text, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_connection.append_application_grant_activity_internal(jsonb, uuid, uuid, uuid, text, timestamp with time zone) to vortex_connection_owner;

comment on function vortex_connection.append_application_grant_activity_internal(jsonb, uuid, uuid, uuid, text, timestamp with time zone) is null;

-- Canonical vortex_connection.append_connection_instance_activity_internal.
create or replace function vortex_connection.append_connection_instance_activity_internal(
  p_context jsonb,
  p_activity_id uuid,
  p_connection_instance_id uuid,
  p_action text,
  p_occurred_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  actor_kind text;
  actor_id uuid;
begin
  if p_context ->> 'callerKind' = 'human' then
    actor_kind := 'organization_account';
    actor_id := (p_context ->> 'organizationAccountId')::uuid;
  elsif p_context ->> 'callerKind' = 'system' then
    actor_kind := 'system';
    actor_id := (p_context ->> 'systemActorId')::uuid;
  else
    raise exception using
      errcode = '42501',
      message = 'Connection Activity requires validated human or system context';
  end if;

  perform vortex_activity.append_organization_activity_entry(
    (p_context ->> 'organizationId')::uuid,
    p_activity_id,
    p_occurred_at,
    actor_kind,
    actor_id,
    p_action,
    array[p_connection_instance_id],
    array[]::uuid[],
    'connection',
    (p_context ->> 'correlationId')::uuid,
    'completed'
  );
end
$function$;

revoke all on function vortex_connection.append_connection_instance_activity_internal(jsonb, uuid, uuid, text, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_connection.append_connection_instance_activity_internal(jsonb, uuid, uuid, text, timestamp with time zone) to vortex_connection_owner;

comment on function vortex_connection.append_connection_instance_activity_internal(jsonb, uuid, uuid, text, timestamp with time zone) is null;

-- Canonical vortex_connection.assert_connection_administration_authority.
create or replace function vortex_connection.assert_connection_administration_authority(
  p_context jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
  operation_value constant text := 'platform.organization.connections.manage';
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', operation_value,
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', 'ec2908a1-f3cd-4c4a-8bf7-91bffbf4cb3d'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from operation_value
    or decision.organization_id is distinct from (p_context ->> 'organizationId')::uuid
    or decision.organization_account_id is distinct from
      (p_context ->> 'organizationAccountId')::uuid
    or decision.access_version is distinct from (p_context ->> 'accessVersion')::bigint
    or decision.correlation_id is distinct from (p_context ->> 'correlationId')::uuid then
    raise exception using
      errcode = '42501',
      message = 'Connection administration is unavailable';
  end if;
exception
  when others then
    raise exception using
      errcode = '42501',
      message = 'Connection administration is unavailable';
end
$function$;

alter function vortex_connection.assert_connection_administration_authority(jsonb) owner to vortex_connection_owner;

revoke all on function vortex_connection.assert_connection_administration_authority(jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_connection.assert_connection_administration_authority(jsonb) is null;

-- Canonical vortex_connection.enforce_grant_application_root.
create or replace function vortex_connection.enforce_grant_application_root()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  app_record record;
begin
  select root.organization_id, root.kind into app_record
  from vortex_definition.roots as root
  where root.root_id = new.application_root_id;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'Referenced application root does not exist';
  end if;

  if app_record.kind <> 'application' then
    raise exception using
      errcode = '23514',
      message = 'Referenced root must be of kind application';
  end if;

  if app_record.organization_id <> new.organization_id then
    raise exception using
      errcode = '23514',
      message = 'Referenced application root organization does not match grant organization';
  end if;

  return new;
end;
$function$;

revoke all on function vortex_connection.enforce_grant_application_root() from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_connection.enforce_grant_application_root() is null;

-- Canonical vortex_definition.create_root.
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

grant execute on function vortex_definition.create_root(text, text, jsonb, text, jsonb) to vortex_request;

revoke execute on function vortex_definition.create_root(text, text, jsonb, text, jsonb) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.create_root(text, text, jsonb, text, jsonb) to vortex_request;

comment on function vortex_definition.create_root(text, text, jsonb, text, jsonb) is
  'Creates a Definition root, permanent component identities and initial draft atomically.';

-- Canonical vortex_definition.list_release_history.
create or replace function vortex_definition.list_release_history(
  p_kind text,
  p_root_id uuid,
  p_page_size integer,
  p_before_release_revision bigint default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  history_result jsonb;
begin
  checked_context := vortex_definition.validated_system_context();

  if p_kind is null
    or p_kind not in ('module', 'application')
    or p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_page_size is null
    or p_page_size not between 1 and 100
    or (
      p_before_release_revision is not null
      and p_before_release_revision not between 1 and 9007199254740991
    ) then
    raise exception using
      errcode = '22023',
      message = 'Definition release history has an invalid selector';
  end if;

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'organizationId', root.organization_id,
    'kind', root.kind,
    'definitionKey', root.key,
    'rootId', root.root_id,
    'currentReleaseRevision', root.current_release_revision,
    'entries', page.entries,
    'nextBeforeReleaseRevision', page.next_before_release_revision
  ))
  into history_result
  from vortex_definition.roots as root
  cross join lateral (
    select
      coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'releaseRevision', candidate.release_revision,
            'releaseVersion', candidate.release_version,
            'sourceFingerprint', candidate.authored_source_fingerprint,
            'contentFingerprint', candidate.content_fingerprint,
            'releaseNote', candidate.release_note,
            'publishedAt', candidate.published_at,
            'publishedBy', candidate.published_by,
            'isCurrent', candidate.release_revision = root.current_release_revision
          ) order by candidate.release_revision desc
        ) filter (where candidate.ordinal <= p_page_size),
        '[]'::jsonb
      ) as entries,
      case
        when pg_catalog.count(*) > p_page_size then
          pg_catalog.min(candidate.release_revision)
            filter (where candidate.ordinal <= p_page_size)
        else null
      end as next_before_release_revision
    from (
      select
        release.*,
        pg_catalog.row_number() over (order by release.release_revision desc) as ordinal
      from vortex_definition.releases as release
      where release.root_id = root.root_id
        and (
          p_before_release_revision is null
          or release.release_revision < p_before_release_revision
        )
      order by release.release_revision desc
      limit p_page_size + 1
    ) as candidate
  ) as page
  where root.root_id = p_root_id
    and root.kind = p_kind
    and root.organization_id = (checked_context ->> 'organizationId')::uuid;

  return history_result;
end
$function$;

revoke execute on function vortex_definition.list_release_history(text, uuid, integer, bigint) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.list_release_history(text, uuid, integer, bigint) to vortex_request;

comment on function vortex_definition.list_release_history(text, uuid, integer, bigint) is
  'Returns one bounded newest-first metadata page from a same-organization Definition release history.';

-- Canonical vortex_definition.read_application_bound_release_set.
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

revoke all on function vortex_definition.read_application_bound_release_set(bigint) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.read_application_bound_release_set(bigint) to vortex_request;

grant execute on function vortex_definition.read_application_bound_release_set(bigint) to vortex_definition_owner;

comment on function vortex_definition.read_application_bound_release_set(bigint) is
  'Returns the exact local Application and complete exact Module dependency closure selected by validated human application context.';

-- Canonical vortex_definition.read_module_release.
create or replace function vortex_definition.read_module_release(
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

revoke execute on function vortex_definition.read_module_release(uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_definition.read_module_release(uuid, bigint) to vortex_request;

comment on function vortex_definition.read_module_release(uuid, bigint) is
  'Reads one exact same-organisation immutable Module release and its stored compilation and resolution evidence.';

-- Canonical vortex_definition.read_module_release_page.
create or replace function vortex_definition.read_module_release_page(
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

revoke all on function vortex_definition.read_module_release_page(text, bigint, bigint, integer) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.read_module_release_page(text, bigint, bigint, integer) to vortex_request;

comment on function vortex_definition.read_module_release_page(text, bigint, bigint, integer) is
  'Returns one anchored bounded oldest-first page of same-organisation immutable Module release evidence.';

-- Canonical vortex_definition.read_publication_history_page.
create or replace function vortex_definition.read_publication_history_page(
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

revoke all on function vortex_definition.read_publication_history_page(uuid, bigint, bigint, integer) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.read_publication_history_page(uuid, bigint, bigint, integer) to vortex_request;

comment on function vortex_definition.read_publication_history_page(uuid, bigint, bigint, integer) is
  'Returns one anchored, bounded oldest-first keyset page of full immutable publication evidence for internal publication preparation.';

-- Canonical vortex_definition.read_publication_state.
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

revoke execute on function vortex_definition.read_publication_state(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_definition.read_publication_state(uuid) to vortex_request;

comment on function vortex_definition.read_publication_state(uuid) is
  'Returns one organisation-scoped Definition draft, permanent identity aliases and immutable publication evidence for server-side compilation.';

-- Canonical vortex_definition.read_release_history_entry.
create or replace function vortex_definition.read_release_history_entry(
  p_kind text,
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
  history_entry jsonb;
begin
  checked_context := vortex_definition.validated_system_context();

  if p_kind is null
    or p_kind not in ('module', 'application')
    or p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_release_revision is null
    or p_release_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Definition release history entry has an invalid selector';
  end if;

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'organizationId', root.organization_id,
    'kind', root.kind,
    'definitionKey', root.key,
    'rootId', root.root_id,
    'currentReleaseRevision', root.current_release_revision,
    'entry', pg_catalog.jsonb_build_object(
      'releaseRevision', release.release_revision,
      'releaseVersion', release.release_version,
      'sourceFingerprint', release.authored_source_fingerprint,
      'contentFingerprint', release.content_fingerprint,
      'releaseNote', release.release_note,
      'publishedAt', release.published_at,
      'publishedBy', release.published_by,
      'isCurrent', release.release_revision = root.current_release_revision
    )
  ))
  into history_entry
  from vortex_definition.roots as root
  join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = p_release_revision
  where root.root_id = p_root_id
    and root.kind = p_kind
    and root.organization_id = (checked_context ->> 'organizationId')::uuid;

  return history_entry;
end
$function$;

revoke execute on function vortex_definition.read_release_history_entry(text, uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.read_release_history_entry(text, uuid, bigint) to vortex_request;

comment on function vortex_definition.read_release_history_entry(text, uuid, bigint) is
  'Returns one exact same-organization immutable Definition release metadata entry.';

-- Canonical vortex_definition.read_system_application_bound_release_set.
create or replace function vortex_definition.read_system_application_bound_release_set(
  p_application_root_id uuid,
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
  application_evidence jsonb;
  module_evidence jsonb;
begin
  checked_context := vortex_definition.validated_system_context();
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or (
      checked_context ? 'applicationRootId'
      and (checked_context ->> 'applicationRootId')::uuid <> p_application_root_id
    ) then
    raise exception using
      errcode = '22023',
      message = 'System Application release-set context is invalid';
  end if;

  select vortex_definition.project_consumer_release_evidence(
    'application', root.root_id, p_application_release_revision
  ) into application_evidence
  from vortex_definition.roots as root
  where root.root_id = p_application_root_id
    and root.kind = 'application'
    and root.organization_id = (checked_context ->> 'organizationId')::uuid;
  if application_evidence is null then
    raise exception using
      errcode = 'P0002',
      message = 'Exact system Application release is unavailable';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      vortex_definition.project_consumer_release_evidence(
        'module', pin.target_root_id, pin.target_release_revision
      ) order by pin.target_root_id
    ),
    '[]'::jsonb
  ) into module_evidence
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as pin;

  return pg_catalog.jsonb_build_object(
    'correlationId', checked_context ->> 'correlationId',
    'application', application_evidence,
    'modules', module_evidence
  );
end
$function$;

revoke all on function vortex_definition.read_system_application_bound_release_set(uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.read_system_application_bound_release_set(uuid, bigint) to vortex_request;

comment on function vortex_definition.read_system_application_bound_release_set(uuid, bigint) is
  'Returns one exact organisation-owned Application and its database-resolved Module dependency pin set to a validated system context; a valid zero-Module Application returns an empty Module array.';

-- Canonical vortex_definition.restore_release_draft.
create or replace function vortex_definition.restore_release_draft(
  p_kind text,
  p_root_id uuid,
  p_target_release_revision bigint,
  p_expected_draft_revision bigint,
  p_expected_source_fingerprint text,
  p_identity_requirements jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  restored_draft jsonb;
  operation_at timestamptz := pg_catalog.statement_timestamp();
begin
  checked_context := vortex_definition.validated_system_context();

  if p_kind is null
    or p_kind not in ('module', 'application')
    or p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_target_release_revision is null
    or p_target_release_revision not between 1 and 9007199254740991
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_expected_source_fingerprint is null
    or p_expected_source_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or pg_catalog.jsonb_typeof(p_identity_requirements) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_identity_requirements) < 1 then
    raise exception using
      errcode = '22023',
      message = 'Definition restore has invalid verified evidence';
  end if;

  with selected_release as (
    select
      root.root_id,
      root.organization_id,
      root.kind,
      root.key,
      root.current_release_revision,
      root.created_at,
      root.created_by,
      release.release_revision,
      release.authored_source,
      release.authored_source_fingerprint,
      release.source_contract_version
    from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = p_target_release_revision
      and release.authored_source_fingerprint = p_expected_source_fingerprint
    where root.root_id = p_root_id
      and root.kind = p_kind
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
  ),
  updated_draft as (
    update vortex_definition.drafts as draft
    set
      draft_revision = draft.draft_revision + 1,
      draft_source = selected.authored_source,
      identity_requirements = p_identity_requirements,
      source_contract_version = selected.source_contract_version,
      source_fingerprint = selected.authored_source_fingerprint,
      restored_from_release_revision = selected.release_revision,
      restored_from_source_fingerprint = selected.authored_source_fingerprint,
      restored_by = (checked_context ->> 'systemActorId')::uuid,
      restored_at = operation_at,
      restore_correlation_id = (checked_context ->> 'correlationId')::uuid,
      updated_at = operation_at,
      updated_by = (checked_context ->> 'systemActorId')::uuid
    from selected_release as selected
    where draft.root_id = selected.root_id
      and draft.draft_revision = p_expected_draft_revision
      and draft.draft_revision < 9007199254740991
    returning
      draft.root_id,
      draft.draft_revision,
      draft.draft_source,
      draft.source_contract_version,
      draft.source_fingerprint,
      draft.restored_from_release_revision,
      draft.restored_from_source_fingerprint,
      draft.restored_by,
      draft.restored_at,
      draft.restore_correlation_id,
      draft.updated_at,
      draft.updated_by
  )
  select pg_catalog.jsonb_build_object(
    'organizationId', selected.organization_id,
    'kind', selected.kind,
    'key', selected.key,
    'rootId', updated.root_id,
    'draftRevision', updated.draft_revision,
    'publishedRevision', selected.current_release_revision,
    'source', updated.draft_source,
    'sourceContractVersion', updated.source_contract_version,
    'sourceFingerprint', updated.source_fingerprint,
    'createdAt', selected.created_at,
    'createdBy', selected.created_by,
    'updatedAt', updated.updated_at,
    'updatedBy', updated.updated_by,
    'restoredFromReleaseRevision', updated.restored_from_release_revision,
    'restoredFromSourceFingerprint', updated.restored_from_source_fingerprint,
    'restoredBy', updated.restored_by,
    'restoredAt', updated.restored_at,
    'restoreCorrelationId', updated.restore_correlation_id
  )
  into restored_draft
  from updated_draft as updated
  join selected_release as selected on selected.root_id = updated.root_id;

  return restored_draft;
end
$function$;

revoke execute on function vortex_definition.restore_release_draft(text, uuid, bigint, bigint, text, jsonb) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.restore_release_draft(text, uuid, bigint, bigint, text, jsonb) to vortex_request;

comment on function vortex_definition.restore_release_draft(text, uuid, bigint, bigint, text, jsonb) is
  'Conditionally restores one verified immutable authored source into the expected draft revision without allocating identities or moving a release pointer.';

-- Canonical vortex_definition.save_draft.
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
    restored_from_release_revision = null,
    restored_from_source_fingerprint = null,
    restored_by = null,
    restored_at = null,
    restore_correlation_id = null,
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

grant execute on function vortex_definition.save_draft(uuid, bigint, jsonb, text, jsonb) to vortex_request;

revoke execute on function vortex_definition.save_draft(uuid, bigint, jsonb, text, jsonb) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.save_draft(uuid, bigint, jsonb, text, jsonb) to vortex_request;

comment on function vortex_definition.save_draft(uuid, bigint, jsonb, text, jsonb) is
  'Conditionally saves a draft and records new permanent identities and aliases atomically.';

-- Canonical vortex_connection.assert_human_administration_request.
create or replace function vortex_connection.assert_human_administration_request()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if coalesce(vortex_context.current_context() ->> 'callerKind', '') <> 'human' then
    raise exception using
      errcode = '42501',
      message = 'Connection administration requires a human request context';
  end if;
end
$function$;

alter function vortex_connection.assert_human_administration_request() owner to vortex_connection_owner;

revoke all on function vortex_connection.assert_human_administration_request()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_connection.assert_human_administration_request() is
  'Refuses any caller whose request context is not a human request; used by the connection administration entry points.';

-- Canonical vortex_connection.grant_connection_application_for_administration.
create or replace function vortex_connection.grant_connection_application_for_administration(
  p_connection_instance_id uuid,
  p_application_root_id uuid,
  p_administrator_activity_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_connection.assert_human_administration_request();

  perform vortex_connection.grant_connection_application_internal(
    p_connection_instance_id,
    p_application_root_id,
    p_administrator_activity_id
  );
end
$function$;

alter function vortex_connection.grant_connection_application_for_administration(uuid, uuid, uuid) owner to vortex_connection_owner;

revoke all on function vortex_connection.grant_connection_application_for_administration(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_connection.grant_connection_application_for_administration(uuid, uuid, uuid)
  to vortex_request;

comment on function vortex_connection.grant_connection_application_for_administration(uuid, uuid, uuid) is
  'Human request entry point for granting an application use of a connection instance; delegates to grant_connection_application_internal.';

-- Canonical vortex_connection.reauthorize_connection_instance_for_administration.
create or replace function vortex_connection.reauthorize_connection_instance_for_administration(
  p_connection_instance_id uuid,
  p_expected_revision bigint,
  p_administrator_activity_id uuid,
  p_destination_fingerprint text,
  p_token_expires_at timestamptz
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_connection.assert_human_administration_request();

  return vortex_connection.reauthorize_connection_instance_internal(
    p_connection_instance_id,
    p_expected_revision,
    p_administrator_activity_id,
    p_destination_fingerprint,
    p_token_expires_at
  );
end
$function$;

alter function vortex_connection.reauthorize_connection_instance_for_administration(uuid, bigint, uuid, text, timestamp with time zone) owner to vortex_connection_owner;

revoke all on function vortex_connection.reauthorize_connection_instance_for_administration(uuid, bigint, uuid, text, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_connection.reauthorize_connection_instance_for_administration(uuid, bigint, uuid, text, timestamptz)
  to vortex_request;

comment on function vortex_connection.reauthorize_connection_instance_for_administration(uuid, bigint, uuid, text, timestamptz) is
  'Human request entry point for a revision-checked credential rotation or reauthorisation; delegates to reauthorize_connection_instance_internal.';

-- Canonical vortex_connection.reauthorize_connection_instance_internal.
create or replace function vortex_connection.reauthorize_connection_instance_internal(
  p_connection_instance_id uuid,
  p_expected_revision bigint,
  p_administrator_activity_id uuid,
  p_destination_fingerprint text default null,
  p_token_expires_at timestamptz default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  conn_row vortex_connection.connection_instances%rowtype;
  new_revision bigint;
  administration_context jsonb;
begin
  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection reauthorization requires non-nil administrator activity ID';
  end if;

  if p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Connection reauthorization requires a valid expected revision';
  end if;

  if p_destination_fingerprint is not null and p_destination_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Invalid destination fingerprint: must be 64 lowercase hex characters';
  end if;

  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection reauthorization failed: revision mismatch or not found';
  end if;

  if conn_row.state <> 'revoked' then
    raise exception using
      errcode = '23514',
      message = 'Connection reauthorization requires revoked source state';
  end if;

  update vortex_connection.connection_instances
  set state = 'pending',
      last_health_outcome = 'unknown',
      destination_fingerprint = coalesce(p_destination_fingerprint, destination_fingerprint),
      token_expires_at = p_token_expires_at,
      administrator_activity_id = p_administrator_activity_id,
      revision = revision + 1,
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  perform vortex_connection.append_connection_instance_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    'connection_reauthorized',
    operation_at
  );

  return new_revision;
end
$function$;

alter function vortex_connection.reauthorize_connection_instance_internal(uuid, bigint, uuid, text, timestamp with time zone) owner to vortex_connection_owner;

comment on function vortex_connection.reauthorize_connection_instance_internal(uuid, bigint, uuid, text, timestamp with time zone) is null;

revoke all on function
  vortex_connection.reauthorize_connection_instance_internal(uuid, bigint, uuid, text, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_connection.reauthorize_connection_instance_internal(uuid, bigint, uuid, text, timestamptz) to vortex_runtime;

-- Canonical vortex_connection.record_connection_health_check_for_administration.
create or replace function vortex_connection.record_connection_health_check_for_administration(
  p_connection_instance_id uuid,
  p_expected_revision bigint,
  p_new_health_outcome text,
  p_administrator_activity_id uuid
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_connection.assert_human_administration_request();

  return vortex_connection.record_connection_health_check_internal(
    p_connection_instance_id,
    p_expected_revision,
    p_new_health_outcome,
    p_administrator_activity_id
  );
end
$function$;

alter function vortex_connection.record_connection_health_check_for_administration(uuid, bigint, text, uuid) owner to vortex_connection_owner;

revoke all on function vortex_connection.record_connection_health_check_for_administration(uuid, bigint, text, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_connection.record_connection_health_check_for_administration(uuid, bigint, text, uuid)
  to vortex_request;

comment on function vortex_connection.record_connection_health_check_for_administration(uuid, bigint, text, uuid) is
  'Human request entry point for recording a revision-checked connection health outcome; delegates to record_connection_health_check_internal.';

-- Canonical vortex_connection.record_connection_health_check_internal.
create or replace function vortex_connection.record_connection_health_check_internal(
  p_connection_instance_id uuid,
  p_expected_revision bigint,
  p_new_health_outcome text,
  p_administrator_activity_id uuid default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  conn_row vortex_connection.connection_instances%rowtype;
  next_state text;
  new_revision bigint;
  administration_context jsonb;
begin
  if p_new_health_outcome not in ('healthy', 'unhealthy') then
    raise exception using
      errcode = '22023',
      message = 'Invalid health outcome: must be healthy or unhealthy';
  end if;

  if p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Connection health update requires a valid expected revision';
  end if;

  if p_administrator_activity_id is null
    or p_administrator_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection health update requires non-nil administrator activity ID';
  end if;

  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  -- Lock row for update
  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance health update failed: revision mismatch or not found';
  end if;

  -- Terminal revocation check
  if conn_row.state = 'revoked' then
    raise exception using
      errcode = '42501',
      message = 'Connection instance is revoked; revocation is terminal and cannot transition via health check';
  end if;

  -- Explicit monotonic state transition matrix
  if p_new_health_outcome = 'healthy' then
    next_state := 'active';
  else
    next_state := 'unhealthy';
  end if;

  update vortex_connection.connection_instances
  set last_health_outcome = p_new_health_outcome,
      state = next_state,
      revision = revision + 1,
      administrator_activity_id = p_administrator_activity_id,
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  perform vortex_connection.append_connection_instance_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    'connection_health_recorded',
    operation_at
  );

  return new_revision;
end
$function$;

alter function vortex_connection.record_connection_health_check_internal(uuid, bigint, text, uuid) owner to vortex_connection_owner;

comment on function vortex_connection.record_connection_health_check_internal(uuid, bigint, text, uuid) is null;

revoke all on function
  vortex_connection.record_connection_health_check_internal(uuid, bigint, text, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_connection.record_connection_health_check_internal(uuid, bigint, text, uuid) to vortex_runtime;

-- Canonical vortex_connection.register_connection_instance_for_administration.
create or replace function vortex_connection.register_connection_instance_for_administration(
  p_connection_instance_id uuid,
  p_connection_type_id uuid,
  p_connection_type_version text,
  p_destination_key text,
  p_destination_fingerprint text,
  p_administrator_activity_id uuid,
  p_token_expires_at timestamptz
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_connection.assert_human_administration_request();

  perform vortex_connection.register_connection_instance_internal(
    p_connection_instance_id,
    vortex_context.organization_id(),
    p_connection_type_id,
    p_connection_type_version,
    p_destination_key,
    p_destination_fingerprint,
    p_administrator_activity_id,
    p_token_expires_at
  );

  return 1;
end
$function$;

alter function vortex_connection.register_connection_instance_for_administration(uuid, uuid, text, text, text, uuid, timestamp with time zone) owner to vortex_connection_owner;

revoke all on function vortex_connection.register_connection_instance_for_administration(uuid, uuid, text, text, text, uuid, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_connection.register_connection_instance_for_administration(uuid, uuid, text, text, text, uuid, timestamptz)
  to vortex_request;

comment on function vortex_connection.register_connection_instance_for_administration(uuid, uuid, text, text, text, uuid, timestamptz) is
  'Human request entry point for registering a connection instance in the request context organisation; delegates to register_connection_instance_internal and returns the new revision.';

-- Canonical vortex_connection.register_connection_instance_internal.
create or replace function vortex_connection.register_connection_instance_internal(
  p_connection_instance_id uuid,
  p_organization_id uuid,
  p_connection_type_id uuid,
  p_connection_type_version text,
  p_destination_key text,
  p_destination_fingerprint text,
  p_administrator_activity_id uuid,
  p_token_expires_at timestamptz default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  administration_context jsonb;
begin
  -- Validate administration context for target organization
  administration_context := vortex_connection.validated_administration_context(p_organization_id);

  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection registration requires non-nil administrator activity ID';
  end if;

  insert into vortex_connection.connection_instances (
    connection_instance_id,
    organization_id,
    connection_type_id,
    connection_type_version,
    destination_key,
    destination_fingerprint,
    state,
    last_health_outcome,
    revision,
    administrator_activity_id,
    token_expires_at,
    created_at,
    updated_at
  ) values (
    p_connection_instance_id,
    p_organization_id,
    p_connection_type_id,
    p_connection_type_version,
    p_destination_key,
    p_destination_fingerprint,
    'pending',
    'unknown',
    1,
    p_administrator_activity_id,
    p_token_expires_at,
    operation_at,
    operation_at
  );

  perform vortex_connection.append_connection_instance_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    'connection_registered',
    operation_at
  );
end
$function$;

alter function vortex_connection.register_connection_instance_internal(uuid, uuid, uuid, text, text, text, uuid, timestamp with time zone) owner to vortex_connection_owner;

comment on function vortex_connection.register_connection_instance_internal(uuid, uuid, uuid, text, text, text, uuid, timestamp with time zone) is null;

revoke all on function
  vortex_connection.register_connection_instance_internal(uuid, uuid, uuid, text, text, text, uuid, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_connection.register_connection_instance_internal(uuid, uuid, uuid, text, text, text, uuid, timestamptz) to vortex_runtime;

-- Canonical vortex_connection.revoke_connection_application_for_administration.
create or replace function vortex_connection.revoke_connection_application_for_administration(
  p_connection_instance_id uuid,
  p_application_root_id uuid,
  p_administrator_activity_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_connection.assert_human_administration_request();

  perform vortex_connection.revoke_connection_application_internal(
    p_connection_instance_id,
    p_application_root_id,
    p_administrator_activity_id
  );
end
$function$;

alter function vortex_connection.revoke_connection_application_for_administration(uuid, uuid, uuid) owner to vortex_connection_owner;

revoke all on function vortex_connection.revoke_connection_application_for_administration(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_connection.revoke_connection_application_for_administration(uuid, uuid, uuid)
  to vortex_request;

comment on function vortex_connection.revoke_connection_application_for_administration(uuid, uuid, uuid) is
  'Human request entry point for revoking an application grant on a connection instance; delegates to revoke_connection_application_internal.';

-- Canonical vortex_connection.revoke_connection_application_internal.
create or replace function vortex_connection.revoke_connection_application_internal(
  p_connection_instance_id uuid,
  p_application_root_id uuid,
  p_administrator_activity_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  conn_row vortex_connection.connection_instances%rowtype;
  administration_context jsonb;
  locked_application_root_id uuid;
begin
  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection grant revocation requires non-nil administrator activity ID';
  end if;

  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for share;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance not found';
  end if;

  select grant_entry.application_root_id into locked_application_root_id
  from vortex_connection.connection_application_grants as grant_entry
  where grant_entry.connection_instance_id = p_connection_instance_id
    and grant_entry.application_root_id = p_application_root_id
    and grant_entry.organization_id = conn_row.organization_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Connection application grant not found';
  end if;

  delete from vortex_connection.connection_application_grants
  where connection_instance_id = p_connection_instance_id
    and application_root_id = locked_application_root_id;

  perform vortex_connection.append_application_grant_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    p_application_root_id,
    'connection_application_revoked',
    operation_at
  );
end
$function$;

alter function vortex_connection.revoke_connection_application_internal(uuid, uuid, uuid) owner to vortex_connection_owner;

comment on function vortex_connection.revoke_connection_application_internal(uuid, uuid, uuid) is null;

revoke all on function
  vortex_connection.revoke_connection_application_internal(uuid, uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_connection.revoke_connection_application_internal(uuid, uuid, uuid) to vortex_runtime;

-- Canonical vortex_connection.revoke_connection_instance_for_administration.
create or replace function vortex_connection.revoke_connection_instance_for_administration(
  p_connection_instance_id uuid,
  p_expected_revision bigint,
  p_administrator_activity_id uuid
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_connection.assert_human_administration_request();

  return vortex_connection.revoke_connection_instance_internal(
    p_connection_instance_id,
    p_expected_revision,
    p_administrator_activity_id
  );
end
$function$;

alter function vortex_connection.revoke_connection_instance_for_administration(uuid, bigint, uuid) owner to vortex_connection_owner;

revoke all on function vortex_connection.revoke_connection_instance_for_administration(uuid, bigint, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_connection.revoke_connection_instance_for_administration(uuid, bigint, uuid)
  to vortex_request;

comment on function vortex_connection.revoke_connection_instance_for_administration(uuid, bigint, uuid) is
  'Human request entry point for disabling a connection instance at an expected revision; delegates to revoke_connection_instance_internal.';

-- Canonical vortex_connection.revoke_connection_instance_internal.
create or replace function vortex_connection.revoke_connection_instance_internal(
  p_connection_instance_id uuid,
  p_expected_revision bigint,
  p_administrator_activity_id uuid
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  conn_row vortex_connection.connection_instances%rowtype;
  new_revision bigint;
  administration_context jsonb;
begin
  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection revocation requires non-nil administrator activity ID';
  end if;

  if p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Connection revocation requires a valid expected revision';
  end if;

  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection revocation failed: revision mismatch or not found';
  end if;

  if conn_row.state = 'revoked' then
    raise exception using
      errcode = '23514',
      message = 'Connection revocation requires a non-revoked source state';
  end if;

  update vortex_connection.connection_instances
  set state = 'revoked',
      administrator_activity_id = p_administrator_activity_id,
      revision = revision + 1,
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  perform vortex_connection.append_connection_instance_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    'connection_revoked',
    operation_at
  );

  return new_revision;
end
$function$;

alter function vortex_connection.revoke_connection_instance_internal(uuid, bigint, uuid) owner to vortex_connection_owner;

comment on function vortex_connection.revoke_connection_instance_internal(uuid, bigint, uuid) is null;

revoke all on function
  vortex_connection.revoke_connection_instance_internal(uuid, bigint, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_connection.revoke_connection_instance_internal(uuid, bigint, uuid) to vortex_runtime;

-- Canonical vortex_connection.validated_administration_context.
create or replace function vortex_connection.validated_administration_context(p_organization_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  ctx jsonb;
  ctx_org_id uuid;
begin
  ctx := vortex_context.validated_service_context();
  if ctx ->> 'callerKind' = 'human' then
    perform vortex_connection.assert_connection_administration_authority(ctx);
  end if;
  ctx_org_id := (ctx ->> 'organizationId')::uuid;

  if ctx_org_id is distinct from p_organization_id then
    raise exception using
      errcode = '42501',
      message = 'Connection operation organization does not match request context organization';
  end if;

  return ctx;
end;
$function$;

alter function vortex_connection.validated_administration_context(uuid) owner to vortex_connection_owner;

revoke all on function vortex_connection.validated_administration_context(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_connection.validated_administration_context(uuid) is
  'Returns a matching validated system context or a matching human context with connection administration authority.';

-- Canonical vortex_definition.read_application_release_adoption_release_set.
create or replace function vortex_definition.read_application_release_adoption_release_set(
  p_application_root_id uuid,
  p_application_release_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  permission_decision record;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Application release adoption release-set command is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if not checked_context ? 'applicationRootId'
    or (checked_context ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    raise exception using errcode = '42501',
      message = 'Application release adoption release-set context is unavailable';
  end if;

  -- The exact release evidence is only revealed to a caller who may manage this
  -- organisation's application installations, decided by the same Access
  -- evaluator every other platform-permission check uses.
  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.manage',
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
  if permission_decision.outcome is distinct from 'eligible'
    or (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '42501',
      message = 'Application release adoption release-set authority is unavailable';
  end if;

  -- The same protected projection the ordinary human bound-release read returns;
  -- this caller has already proved installation-management authority above.
  return vortex_definition.read_application_bound_release_set(p_application_release_revision);
end
$function$;

alter function vortex_definition.read_application_release_adoption_release_set(uuid, bigint) owner to vortex_definition_owner;

revoke all on function vortex_definition.read_application_release_adoption_release_set(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.read_application_release_adoption_release_set(uuid, bigint)
  to vortex_request;

comment on function vortex_definition.read_application_release_adoption_release_set(uuid, bigint) is
  'Returns the exact bound Application and Module release set for one root and revision to a caller holding platform.organization.applications.manage in the validated human application context.';

-- Canonical vortex_definition.read_application_release_adoption_target.
create or replace function vortex_definition.read_application_release_adoption_target(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  permission_decision record;
  target_value jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application release adoption target command is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if not checked_context ? 'applicationRootId'
    or (checked_context ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    raise exception using errcode = '42501',
      message = 'Application release adoption target context is unavailable';
  end if;

  -- The offered target is only revealed to a caller who may manage this
  -- organisation's application installations. The decision is made by the same
  -- Access evaluator every other platform-permission check uses.
  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.manage',
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
  if permission_decision.outcome is distinct from 'eligible'
    or (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '42501',
      message = 'Application release adoption target authority is unavailable';
  end if;

  -- Only an application this organisation has installed offers an adoption
  -- target. Module owns installation facts: its fixed Module-owned reader
  -- refuses an organisation/application scope with no complete active
  -- installation, so this function never reads Module storage directly.
  perform vortex_module.read_active_installation_for_scope_internal(
    permission_decision.organization_id,
    p_application_root_id
  );

  -- Publication advances the root pointer but never touches the installation,
  -- so the offered target is the discovery pointer, not the active release.
  select pg_catalog.jsonb_build_object(
    'organizationId', root.organization_id,
    'applicationRootId', root.root_id,
    'currentReleaseRevision', root.current_release_revision,
    'currentReleaseVersion', release.release_version
  )
  into target_value
  from vortex_definition.roots as root
  left join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = root.current_release_revision
  where root.root_id = p_application_root_id
    and root.kind = 'application'
    and root.organization_id = permission_decision.organization_id;

  if target_value is null then
    raise exception using errcode = 'P0002',
      message = 'Application release adoption target is unavailable';
  end if;

  return target_value;
end
$function$;

alter function vortex_definition.read_application_release_adoption_target(uuid) owner to vortex_definition_owner;

revoke all on function vortex_definition.read_application_release_adoption_target(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.read_application_release_adoption_target(uuid)
  to vortex_request;

comment on function vortex_definition.read_application_release_adoption_target(uuid) is
  'Returns the published-current release identity an organisation with an installed application may deliberately adopt, for a caller holding platform.organization.applications.manage.';

-- Canonical vortex_connection.grant_connection_application_internal.
create or replace function vortex_connection.grant_connection_application_internal(
  p_connection_instance_id uuid,
  p_application_root_id uuid,
  p_administrator_activity_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  conn_row vortex_connection.connection_instances%rowtype;
  app_org_id uuid;
  app_kind text;
  administration_context jsonb;
  inserted_connection_instance_id uuid;
begin
  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection grant requires non-nil administrator activity ID';
  end if;

  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for share;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance not found';
  end if;

  -- Resolve and lock application root
  select root.organization_id, root.kind into app_org_id, app_kind
  from vortex_definition.roots as root
  where root.root_id = p_application_root_id
    and root.organization_id = (administration_context ->> 'organizationId')::uuid
  for share;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'Referenced application root is unavailable';
  end if;

  if app_kind <> 'application' then
    raise exception using
      errcode = '23514',
      message = 'Referenced root must be of kind application';
  end if;

  if app_org_id <> conn_row.organization_id then
    raise exception using
      errcode = '23514',
      message = 'Referenced application root organization does not match connection organization';
  end if;

  insert into vortex_connection.connection_application_grants (
    connection_instance_id,
    application_root_id,
    organization_id,
    granted_at
  ) values (
    p_connection_instance_id,
    p_application_root_id,
    conn_row.organization_id,
    operation_at
  )
  on conflict (connection_instance_id, application_root_id) do nothing
  returning connection_instance_id into inserted_connection_instance_id;

  if inserted_connection_instance_id is null then
    raise exception using
      errcode = '23514',
      message = 'Connection application grant already exists';
  end if;

  perform vortex_connection.append_application_grant_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    p_application_root_id,
    'connection_application_granted',
    operation_at
  );
end
$function$;

comment on function vortex_connection.grant_connection_application_internal(uuid, uuid, uuid) is null;

revoke all on function
  vortex_connection.grant_connection_application_internal(uuid, uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_connection.grant_connection_application_internal(uuid, uuid, uuid) to vortex_runtime;

grant execute on function vortex_connection.grant_connection_application_internal(uuid, uuid, uuid) to vortex_connection_owner;

-- Canonical vortex_access.evaluate_organization_permission_eligibility.
create or replace function vortex_access.evaluate_organization_permission_eligibility(
  p_declaration jsonb
)
returns table (
  outcome text,
  operation_key text,
  target_kind text,
  target_application_root_id uuid,
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint,
  checked_at timestamptz,
  valid_until timestamptz,
  correlation_id uuid,
  reason_code text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  declaration_action jsonb;
  declaration_target jsonb;
  declaration_permission jsonb;
  declaration_authentication jsonb;
  declaration_authority jsonb;
  scope_candidate jsonb;
  permission_candidate jsonb;
  scope_name text;
  operation_value text;
  target_kind_value text;
  target_application_value uuid;
  permission_application_value uuid;
  permission_owner_kind_value text;
  authority_kind_value text;
  context_value jsonb;
  context_organization_value uuid;
  context_account_value uuid;
  context_access_version_value bigint;
  context_application_value uuid;
  context_expires_value timestamptz;
  context_correlation_value uuid;
  authentication_deadline timestamptz;
  authentication_satisfied boolean := true;
  context_current boolean := true;
  target_context_satisfied boolean := true;
  unsupported_context boolean := false;
  decision_checked_at timestamptz;
begin
  if p_declaration is null
    or pg_catalog.jsonb_typeof(p_declaration) <> 'object'
    or not p_declaration ?& array[
      'operationKey', 'action', 'target', 'requiredPermission',
      'recentAuthentication', 'authority'
    ]
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_declaration) as supplied(key)
      where supplied.key <> all (array[
        'operationKey', 'action', 'target', 'requiredPermission',
        'recentAuthentication', 'authority'
      ])
    )
    or pg_catalog.jsonb_typeof(p_declaration -> 'operationKey') <> 'string'
    or pg_catalog.char_length(p_declaration ->> 'operationKey') not between 3 and 120
    or (p_declaration ->> 'operationKey') !~
      '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
    or (p_declaration ->> 'operationKey') ~ '(^|\.)[^.]{41,}(\.|$)' then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  declaration_action := p_declaration -> 'action';
  declaration_target := p_declaration -> 'target';
  declaration_permission := p_declaration -> 'requiredPermission';
  declaration_authentication := p_declaration -> 'recentAuthentication';
  declaration_authority := p_declaration -> 'authority';

  if pg_catalog.jsonb_typeof(declaration_action) <> 'object'
    or not declaration_action ? 'actionKind'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_action) as supplied(key)
      where supplied.key <> all (array['actionKind', 'namedAction'])
    )
    or pg_catalog.jsonb_typeof(declaration_action -> 'actionKind') <> 'string'
    or declaration_action ->> 'actionKind' not in (
      'create', 'read', 'update', 'delete', 'restore', 'export', 'share', 'manage', 'named'
    )
    or (
      (declaration_action ->> 'actionKind') = 'named'
      and (
        not declaration_action ? 'namedAction'
        or pg_catalog.jsonb_typeof(declaration_action -> 'namedAction') <> 'string'
        or pg_catalog.char_length(declaration_action ->> 'namedAction') not between 1 and 40
        or (declaration_action ->> 'namedAction') !~
          '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      )
    )
    or (
      (declaration_action ->> 'actionKind') <> 'named'
      and declaration_action ? 'namedAction'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_target) <> 'object'
    or not declaration_target ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_target -> 'kind') <> 'string'
    or declaration_target ->> 'kind' not in ('organization', 'application')
    or (
      declaration_target ->> 'kind' = 'organization'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_target) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_target ->> 'kind' = 'application'
      and (
        not declaration_target ? 'applicationRootId'
        or not vortex_context.is_non_nil_uuid(
          declaration_target ->> 'applicationRootId'
        )
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_target) as supplied(key)
          where supplied.key <> all (array['kind', 'applicationRootId'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_authentication) <> 'object'
    or not declaration_authentication ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_authentication -> 'kind') <> 'string'
    or declaration_authentication ->> 'kind' not in ('none', 'primary', 'multi_factor')
    or (
      declaration_authentication ->> 'kind' = 'none'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_authentication) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_authentication ->> 'kind' in ('primary', 'multi_factor')
      and (
        not declaration_authentication ? 'maximumAgeSeconds'
        or pg_catalog.jsonb_typeof(
          declaration_authentication -> 'maximumAgeSeconds'
        ) <> 'number'
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_authentication) as supplied(key)
          where supplied.key <> all (array['kind', 'maximumAgeSeconds'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if declaration_authentication ->> 'kind' in ('primary', 'multi_factor')
    and (
      (declaration_authentication ->> 'maximumAgeSeconds')::numeric < 1
      or (declaration_authentication ->> 'maximumAgeSeconds')::numeric >
        9007199254740991
      or (declaration_authentication ->> 'maximumAgeSeconds')::numeric <>
        pg_catalog.trunc(
          (declaration_authentication ->> 'maximumAgeSeconds')::numeric
        )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_authority) <> 'object'
    or not declaration_authority ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_authority -> 'kind') <> 'string'
    or declaration_authority ->> 'kind' not in ('permission', 'delegated_management')
    or (
      declaration_authority ->> 'kind' = 'permission'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_authority) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_authority ->> 'kind' = 'delegated_management'
      and (
        not declaration_authority ?& array['before', 'after']
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_authority) as supplied(key)
          where supplied.key <> all (array['kind', 'before', 'after'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if declaration_authority ->> 'kind' = 'delegated_management' then
    foreach scope_name in array array['before', 'after'] loop
      scope_candidate := declaration_authority -> scope_name;
      if pg_catalog.jsonb_typeof(scope_candidate) <> 'object'
        or not scope_candidate ? 'kind'
        or pg_catalog.jsonb_typeof(scope_candidate -> 'kind') <> 'string'
        or scope_candidate ->> 'kind' not in (
          'none', 'organization_catalogue', 'bounded'
        )
        or (
          scope_candidate ->> 'kind' in ('none', 'organization_catalogue')
          and exists (
            select 1
            from pg_catalog.jsonb_object_keys(scope_candidate) as supplied(key)
            where supplied.key <> 'kind'
          )
        )
        or (
          scope_candidate ->> 'kind' = 'bounded'
          and (
            not scope_candidate ? 'permissions'
            or pg_catalog.jsonb_typeof(scope_candidate -> 'permissions') <> 'array'
            or pg_catalog.jsonb_array_length(scope_candidate -> 'permissions') = 0
            or exists (
              select 1
              from pg_catalog.jsonb_object_keys(scope_candidate) as supplied(key)
              where supplied.key <> all (array['kind', 'permissions'])
            )
          )
        ) then
        raise exception using errcode = '22023',
          message = 'Organization permission declaration is invalid';
      end if;
    end loop;

    if declaration_authority -> 'before' ->> 'kind' = 'none'
      and declaration_authority -> 'after' ->> 'kind' = 'none' then
      raise exception using errcode = '22023',
        message = 'Organization permission declaration is invalid';
    end if;
  end if;

  for permission_candidate in
    select candidate.value
    from (
      select declaration_permission as value
      union all
      select scoped.value
      from pg_catalog.jsonb_array_elements(
        case
          when declaration_authority ->> 'kind' = 'delegated_management'
            and declaration_authority -> 'before' ->> 'kind' = 'bounded'
          then declaration_authority -> 'before' -> 'permissions'
          else '[]'::jsonb
        end
      ) as scoped(value)
      union all
      select scoped.value
      from pg_catalog.jsonb_array_elements(
        case
          when declaration_authority ->> 'kind' = 'delegated_management'
            and declaration_authority -> 'after' ->> 'kind' = 'bounded'
          then declaration_authority -> 'after' -> 'permissions'
          else '[]'::jsonb
        end
      ) as scoped(value)
    ) as candidate
  loop
    if pg_catalog.jsonb_typeof(permission_candidate) <> 'object'
      or not permission_candidate ?& array['ownerKind', 'ownerId', 'permissionId']
      or pg_catalog.jsonb_typeof(permission_candidate -> 'ownerKind') <> 'string'
      or permission_candidate ->> 'ownerKind' not in ('platform', 'application', 'module')
      or not vortex_context.is_non_nil_uuid(permission_candidate ->> 'ownerId')
      or not vortex_context.is_non_nil_uuid(permission_candidate ->> 'permissionId')
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(permission_candidate) as supplied(key)
        where supplied.key <> all (array[
          'applicationRootId', 'ownerKind', 'ownerId', 'permissionId'
        ])
      )
      or (
        permission_candidate ->> 'ownerKind' = 'platform'
        and permission_candidate ? 'applicationRootId'
      )
      or (
        permission_candidate ->> 'ownerKind' in ('application', 'module')
        and (
          not permission_candidate ? 'applicationRootId'
          or not vortex_context.is_non_nil_uuid(
            permission_candidate ->> 'applicationRootId'
          )
        )
      )
      or (
        permission_candidate ->> 'ownerKind' = 'application'
        and pg_catalog.lower(permission_candidate ->> 'ownerId') <>
          pg_catalog.lower(permission_candidate ->> 'applicationRootId')
      ) then
      raise exception using errcode = '22023',
        message = 'Organization permission declaration is invalid';
    end if;
  end loop;

  if declaration_authority ->> 'kind' = 'delegated_management' then
    foreach scope_name in array array['before', 'after'] loop
      scope_candidate := declaration_authority -> scope_name;
      if scope_candidate ->> 'kind' = 'bounded'
        and (
          select pg_catalog.count(*)
          from pg_catalog.jsonb_array_elements(scope_candidate -> 'permissions')
        ) <> (
          select pg_catalog.count(distinct pg_catalog.concat_ws(
            ':',
            pg_catalog.lower(permission.value ->> 'applicationRootId'),
            permission.value ->> 'ownerKind',
            pg_catalog.lower(permission.value ->> 'ownerId'),
            pg_catalog.lower(permission.value ->> 'permissionId')
          ))
          from pg_catalog.jsonb_array_elements(
            scope_candidate -> 'permissions'
          ) as permission(value)
        ) then
        raise exception using errcode = '22023',
          message = 'Organization permission declaration is invalid';
      end if;
    end loop;
  end if;

  operation_value := p_declaration ->> 'operationKey';
  target_kind_value := declaration_target ->> 'kind';
  target_application_value := case
    when target_kind_value = 'application'
      then (declaration_target ->> 'applicationRootId')::uuid
    else null
  end;
  permission_application_value := case
    when declaration_permission ? 'applicationRootId'
      then (declaration_permission ->> 'applicationRootId')::uuid
    else null
  end;
  permission_owner_kind_value := declaration_permission ->> 'ownerKind';
  authority_kind_value := declaration_authority ->> 'kind';

  if (target_kind_value = 'organization' and permission_owner_kind_value <> 'platform')
    or (
      target_kind_value = 'application'
      and (
        permission_owner_kind_value = 'platform'
        or permission_application_value is distinct from target_application_value
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_value := (context_value ->> 'organizationId')::uuid;
  context_account_value := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version_value := (context_value ->> 'accessVersion')::bigint;
  context_application_value := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  context_expires_value := (context_value ->> 'expiresAt')::timestamptz;
  context_correlation_value := (context_value ->> 'correlationId')::uuid;
  decision_checked_at := pg_catalog.clock_timestamp();
  context_current := context_expires_value > decision_checked_at;

  unsupported_context := context_value ? 'delegatedContext'
    or context_value ? 'supportContext';
  target_context_satisfied := target_kind_value = 'organization'
    or coalesce(context_application_value = target_application_value, false);

  authentication_deadline := vortex_access.recent_authentication_deadline_internal(
    context_value, decision_checked_at, declaration_authentication
  );
  authentication_satisfied := authentication_deadline is not null;

  return query
  with permission_eligibility as materialized (
    select evaluated.path_valid_until
    from vortex_access.evaluate_permission_role_path_internal(
      context_value, decision_checked_at, declaration_permission,
      declaration_action, null::uuid
    ) as evaluated
  ), management_scopes as materialized (
    select declaration_authority -> 'before' as scope
    where authority_kind_value = 'delegated_management'
    union all
    select declaration_authority -> 'after'
    where authority_kind_value = 'delegated_management'
  ), delegation_requirements as materialized (
    select 'organization_catalogue'::text as requirement_kind,
      null::uuid as application_root_id, null::text as owner_kind,
      null::uuid as owner_id, null::uuid as permission_id
    where exists (
      select 1 from management_scopes as managed
      where managed.scope ->> 'kind' = 'organization_catalogue'
    )
    union all
    select distinct 'bounded',
      case when permission.value ? 'applicationRootId'
        then (permission.value ->> 'applicationRootId')::uuid
        else null::uuid
      end,
      permission.value ->> 'ownerKind',
      (permission.value ->> 'ownerId')::uuid,
      (permission.value ->> 'permissionId')::uuid
    from management_scopes as managed
    cross join lateral pg_catalog.jsonb_array_elements(
      case when managed.scope ->> 'kind' = 'bounded'
        then managed.scope -> 'permissions'
        else '[]'::jsonb
      end
    ) as permission(value)
  ), current_delegation_paths as materialized (
    select 1 as route_rank, delegation.delegation_authority_id,
      null::uuid as membership_id, delegation.scope_kind,
      delegation.bounded_permissions,
      least(
        context_expires_value,
        coalesce(delegation.expires_at, context_expires_value)
      ) as path_valid_until
    from vortex_access.organization_delegation_authorities as delegation
    where delegation.organization_id = context_organization_value
      and delegation.holder_kind = 'organization_account'
      and delegation.organization_account_id = context_account_value
      and delegation.state = 'live'
      and delegation.starts_at <= decision_checked_at
      and (
        delegation.expires_at is null
        or delegation.expires_at > decision_checked_at
      )

    union all

    select 2, delegation.delegation_authority_id,
      membership.membership_id, delegation.scope_kind,
      delegation.bounded_permissions,
      least(
        context_expires_value,
        coalesce(delegation.expires_at, context_expires_value),
        coalesce(membership.expires_at, context_expires_value)
      )
    from vortex_access.organization_delegation_authorities as delegation
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = delegation.organization_id
      and organization_group.group_id = delegation.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = delegation.organization_id
      and membership.group_id = delegation.group_id
      and membership.organization_account_id = context_account_value
      and membership.state = 'live'
      and membership.starts_at <= decision_checked_at
      and (
        membership.expires_at is null
        or membership.expires_at > decision_checked_at
      )
    where delegation.organization_id = context_organization_value
      and delegation.holder_kind = 'group'
      and delegation.state = 'live'
      and delegation.starts_at <= decision_checked_at
      and (
        delegation.expires_at is null
        or delegation.expires_at > decision_checked_at
      )
  ), current_bounded_path_permissions as materialized (
    select path.delegation_authority_id, path.membership_id,
      case when stored.value ? 'applicationRootId'
        then (stored.value ->> 'applicationRootId')::uuid
        else null::uuid
      end as application_root_id,
      stored.value ->> 'ownerKind' as owner_kind,
      (stored.value ->> 'ownerId')::uuid as owner_id,
      (stored.value ->> 'permissionId')::uuid as permission_id
    from current_delegation_paths as path
    cross join lateral pg_catalog.jsonb_array_elements(
      path.bounded_permissions
    ) as stored(value)
    join vortex_access.permission_registrations as registration
      on registration.organization_id = context_organization_value
      and registration.state = 'active'
    join vortex_access.permission_catalogue_entries as catalogue
      on catalogue.organization_id = registration.organization_id
      and catalogue.registration_kind = registration.registration_kind
      and catalogue.registration_owner_id is not distinct from
        registration.registration_owner_id
      and catalogue.registration_revision = registration.revision
      and catalogue.application_root_id is not distinct from case
        when stored.value ? 'applicationRootId'
          then (stored.value ->> 'applicationRootId')::uuid
        else null::uuid
      end
      and catalogue.owner_kind = stored.value ->> 'ownerKind'
      and catalogue.owner_id = (stored.value ->> 'ownerId')::uuid
      and catalogue.permission_id = (stored.value ->> 'permissionId')::uuid
      and catalogue.meaning_fingerprint =
        stored.value ->> 'meaningFingerprint'
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = catalogue.organization_id
      and continuity.application_root_id is not distinct from
        catalogue.application_root_id
      and continuity.owner_kind = catalogue.owner_kind
      and continuity.owner_id = catalogue.owner_id
      and continuity.permission_id = catalogue.permission_id
      and continuity.registration_kind = catalogue.registration_kind
      and continuity.registration_owner_id is not distinct from
        catalogue.registration_owner_id
      and continuity.last_processed_registration_revision = registration.revision
      and continuity.state = 'available'
      and continuity.continuity_revision =
        (stored.value ->> 'continuityRevision')::numeric::bigint
      and continuity.meaning_fingerprint =
        stored.value ->> 'meaningFingerprint'
    where path.scope_kind = 'bounded'
  ), delegation_path_candidates as (
    select requirement.requirement_kind, requirement.application_root_id,
      requirement.owner_kind, requirement.owner_id,
      requirement.permission_id, path.route_rank,
      path.delegation_authority_id, path.membership_id,
      path.path_valid_until,
      pg_catalog.row_number() over (
        partition by requirement.requirement_kind,
          requirement.application_root_id, requirement.owner_kind,
          requirement.owner_id, requirement.permission_id
        order by path.route_rank, path.delegation_authority_id,
          path.membership_id nulls first
      ) as path_ordinal
    from delegation_requirements as requirement
    join current_delegation_paths as path
      on path.scope_kind = 'organization_catalogue'
      or (
        requirement.requirement_kind = 'bounded'
        and exists (
          select 1
          from current_bounded_path_permissions as covered
          where covered.delegation_authority_id =
              path.delegation_authority_id
            and covered.membership_id is not distinct from path.membership_id
            and covered.application_root_id is not distinct from
              requirement.application_root_id
            and covered.owner_kind = requirement.owner_kind
            and covered.owner_id = requirement.owner_id
            and covered.permission_id = requirement.permission_id
        )
      )
    where requirement.requirement_kind <> 'organization_catalogue'
      or path.scope_kind = 'organization_catalogue'
  ), selected_delegation_paths as materialized (
    select candidate.requirement_kind, candidate.application_root_id,
      candidate.owner_kind, candidate.owner_id, candidate.permission_id,
      candidate.path_valid_until
    from delegation_path_candidates as candidate
    where candidate.path_ordinal = 1
  ), delegation_summary as (
    select pg_catalog.count(*) as requirement_count,
      pg_catalog.count(selected.requirement_kind) as selected_count,
      pg_catalog.min(selected.path_valid_until) as path_valid_until
    from delegation_requirements as requirement
    left join selected_delegation_paths as selected
      on selected.requirement_kind = requirement.requirement_kind
      and selected.application_root_id is not distinct from
        requirement.application_root_id
      and selected.owner_kind is not distinct from requirement.owner_kind
      and selected.owner_id is not distinct from requirement.owner_id
      and selected.permission_id is not distinct from requirement.permission_id
  ), decision as (
    select exists(select 1 from permission_eligibility) as permission_available,
      (
        select pg_catalog.min(selected.path_valid_until)
        from permission_eligibility as selected
      ) as path_valid_until,
      authority_kind_value = 'permission'
        or (
          delegation.requirement_count > 0
          and delegation.requirement_count = delegation.selected_count
        ) as delegation_satisfied,
      delegation.path_valid_until as delegation_valid_until
    from (select 1) as singleton
    cross join delegation_summary as delegation
  )
  select
    case
      when not context_current
        or unsupported_context or not target_context_satisfied then 'refused'
      when not decision.permission_available then 'refused'
      when decision.path_valid_until is null then 'refused'
      when not authentication_satisfied then 'refused'
      when not decision.delegation_satisfied then 'refused'
      else 'eligible'
    end,
    operation_value,
    target_kind_value,
    target_application_value,
    context_organization_value,
    context_account_value,
    context_access_version_value,
    decision_checked_at,
    case
      when context_current
        and not unsupported_context
        and target_context_satisfied
        and decision.permission_available
        and decision.path_valid_until is not null
        and authentication_satisfied
        and decision.delegation_satisfied
      then least(
        decision.path_valid_until,
        authentication_deadline,
        coalesce(decision.delegation_valid_until, context_expires_value)
      )
      else null
    end,
    context_correlation_value,
    case
      when not context_current
        or unsupported_context or not target_context_satisfied
        then 'target_policy_unavailable'
      when not decision.permission_available then 'permission_unavailable'
      when decision.path_valid_until is null then 'permission_not_effective'
      when not authentication_satisfied then 'authentication_unsatisfied'
      when not decision.delegation_satisfied then 'delegation_insufficient'
      else null
    end
  from decision;
end
$function$;

revoke execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_request, vortex_module_owner, vortex_record_owner, postgres;

grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_connection_owner, vortex_definition_owner;

comment on function vortex_access.evaluate_organization_permission_eligibility(jsonb) is
  'Returns transaction-bound permission and current delegation eligibility from one trusted operation declaration; it is not a final protected-operation decision.';

alter function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  owner to vortex_access_owner;

-- Canonical vortex_context.validated_service_context.
create or replace function vortex_context.validated_service_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  established jsonb := vortex_context.current_context();
begin
  case established ->> 'callerKind'
    when 'human' then
      return vortex_access.validated_human_request_context();
    when 'system' then
      return vortex_definition.validated_system_context();
    else
      raise exception using
        errcode = '42501',
        message = 'Request requires a validated human or system context';
  end case;
end
$function$;

revoke execute on function vortex_context.validated_service_context()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_context.validated_service_context()
  to vortex_connection_owner;

comment on function vortex_context.validated_service_context() is
  'Dispatches an established request context through the authoritative human or system validator.';

-- Canonical vortex_module.read_active_installation_for_scope_internal.
create or replace function vortex_module.read_active_installation_for_scope_internal(
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

alter function vortex_module.read_active_installation_for_scope_internal(uuid,uuid) owner to vortex_module_owner;

revoke all on function vortex_module.read_active_installation_for_scope_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter;

grant execute on function vortex_module.read_active_installation_for_scope_internal(uuid, uuid)
  to postgres;

grant execute on function vortex_module.read_active_installation_for_scope_internal(uuid, uuid)
  to vortex_definition_owner;

comment on function vortex_module.read_active_installation_for_scope_internal(uuid, uuid) is
  'Resolves the complete exact active Module binding set for one already-validated organisation/Application scope.';

-- Grant access to the non-canonical cross-schema helper functions used by these definers.
grant usage on schema vortex_context, vortex_access to vortex_connection_owner;
grant usage on schema vortex_access, vortex_module to vortex_definition_owner;
grant execute on function vortex_context.current_context() to vortex_connection_owner;
grant execute on function vortex_context.organization_id() to vortex_connection_owner;
grant execute on function vortex_access.validated_human_request_context() to vortex_definition_owner;

-- Grant Connection owners the columns used by their in-schema writers and readers.
revoke all privileges on table vortex_connection.connection_instances
  from vortex_connection_owner;
grant select on table vortex_connection.connection_instances to vortex_connection_owner;
grant insert (
  connection_instance_id,
  organization_id,
  connection_type_id,
  connection_type_version,
  destination_key,
  destination_fingerprint,
  state,
  last_health_outcome,
  revision,
  administrator_activity_id,
  token_expires_at,
  created_at,
  updated_at
) on table vortex_connection.connection_instances to vortex_connection_owner;
grant update (
  destination_fingerprint,
  token_expires_at,
  last_health_outcome,
  state,
  revision,
  administrator_activity_id,
  updated_at
) on table vortex_connection.connection_instances to vortex_connection_owner;
create policy connection_instances_owner_select
  on vortex_connection.connection_instances
  for select to vortex_connection_owner
  using (organization_id = vortex_context.organization_id());
create policy connection_instances_owner_insert
  on vortex_connection.connection_instances
  for insert to vortex_connection_owner
  with check (organization_id = vortex_context.organization_id());
create policy connection_instances_owner_update
  on vortex_connection.connection_instances
  for update to vortex_connection_owner
  using (organization_id = vortex_context.organization_id())
  with check (organization_id = vortex_context.organization_id());

revoke all privileges on table vortex_connection.connection_application_grants
  from vortex_connection_owner;
grant select (connection_instance_id, application_root_id, organization_id)
  on table vortex_connection.connection_application_grants to vortex_connection_owner;
-- PostgreSQL requires UPDATE on one selected column for SELECT FOR UPDATE; this role only locks grant rows.
grant update (granted_at)
  on table vortex_connection.connection_application_grants to vortex_connection_owner;
grant delete on table vortex_connection.connection_application_grants to vortex_connection_owner;
create policy connection_application_grants_owner_select
  on vortex_connection.connection_application_grants
  for select to vortex_connection_owner
  using (organization_id = vortex_context.organization_id());
create policy connection_application_grants_owner_update
  on vortex_connection.connection_application_grants
  for update to vortex_connection_owner
  using (organization_id = vortex_context.organization_id())
  with check (organization_id = vortex_context.organization_id());
create policy connection_application_grants_owner_delete
  on vortex_connection.connection_application_grants
  for delete to vortex_connection_owner
  using (organization_id = vortex_context.organization_id());

-- Restrict Definition owner reads to the validated human request organisation.
revoke all privileges on table vortex_definition.roots, vortex_definition.releases
  from vortex_definition_owner;
grant select (root_id, organization_id, kind, current_release_revision)
  on table vortex_definition.roots to vortex_definition_owner;
grant select (root_id, release_revision, release_version)
  on table vortex_definition.releases to vortex_definition_owner;
create policy roots_owner_select
  on vortex_definition.roots
  for select to vortex_definition_owner
  using (
    organization_id = (
      vortex_access.validated_human_request_context() ->> 'organizationId'
    )::uuid
  );
create policy releases_owner_select
  on vortex_definition.releases
  for select to vortex_definition_owner
  using (
    exists (
      select 1
      from vortex_definition.roots as root
      where root.root_id = vortex_definition.releases.root_id
        and root.organization_id = (
          vortex_access.validated_human_request_context() ->> 'organizationId'
        )::uuid
    )
  );

commit;
