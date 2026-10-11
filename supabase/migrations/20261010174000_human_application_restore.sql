begin;

set local role postgres;

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
  raw_context := vortex_context.current_context();
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
          when 'platform_theme' then pg_catalog.jsonb_build_object(
            'kind', 'platform_theme',
            'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint,
            'catalogueFingerprint', dependency.evidence_fingerprint
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
          'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
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

alter function vortex_definition.read_restore_release_evidence(text, uuid, bigint)
  owner to postgres;

revoke execute on function vortex_definition.read_restore_release_evidence(text, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_restore_release_evidence(text, uuid, bigint)
  to vortex_request;
comment on function vortex_definition.read_restore_release_evidence(text, uuid, bigint) is
  'Returns narrow private evidence needed to verify one immutable source before restoring its draft.';

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
  raw_context jsonb;
  initial_human_context jsonb;
  final_human_context jsonb;
  root_row vortex_definition.roots%rowtype;
  draft_row vortex_definition.drafts%rowtype;
  selected_release vortex_definition.releases%rowtype;
  permission_decision record;
  completion_at timestamptz;
  requested_identity_count bigint;
  snapshot_identity_count bigint;
  matched_identity_count bigint;
  unique_identity_count bigint;
begin
  raw_context := vortex_context.current_context();
  if raw_context ->> 'callerKind' = 'human' then
    if p_kind is distinct from 'application'
      or p_root_id is null
      or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_target_release_revision is null
      or p_target_release_revision not between 1 and 9007199254740991
      or p_expected_draft_revision is null
      or p_expected_draft_revision not between 1 and 9007199254740991
      or p_expected_source_fingerprint is null
      or p_expected_source_fingerprint !~ '^sha256:[a-f0-9]{64}$'
      or pg_catalog.jsonb_typeof(p_identity_requirements) is distinct from 'array' then
      raise exception using
        errcode = '22023',
        message = 'Definition restore has invalid verified evidence';
    end if;
    if pg_catalog.jsonb_array_length(p_identity_requirements) < 1 then
      raise exception using
        errcode = '22023',
        message = 'Definition restore has invalid verified evidence';
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
      or root_row.current_release_revision is null
      or p_target_release_revision > root_row.current_release_revision then
      return null;
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
    if draft_row.draft_revision is distinct from p_expected_draft_revision
      or draft_row.draft_revision >= 9007199254740991 then
      return null;
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value)
      where pg_catalog.jsonb_typeof(requirement.value) is distinct from 'object'
    ) then
      raise exception using
        errcode = '22023',
        message = 'Definition restore has invalid verified evidence';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value)
      where not (requirement.value ?& array[
          'definitionKey', 'ownerScope', 'scope', 'kind', 'componentOwner', 'aliases'
        ])
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(requirement.value) as supplied(key)
          where supplied.key <> all (array[
            'definitionKey', 'ownerScope', 'scope', 'kind', 'componentOwner', 'aliases'
          ])
        )
        or pg_catalog.jsonb_typeof(requirement.value -> 'definitionKey') is distinct from 'string'
        or pg_catalog.char_length(requirement.value ->> 'definitionKey') not between 1 and 500
        or pg_catalog.jsonb_typeof(requirement.value -> 'ownerScope') is distinct from 'string'
        or pg_catalog.char_length(requirement.value ->> 'ownerScope') not between 1 and 500
        or pg_catalog.jsonb_typeof(requirement.value -> 'scope') is distinct from 'string'
        or pg_catalog.char_length(requirement.value ->> 'scope') not between 1 and 500
        or pg_catalog.jsonb_typeof(requirement.value -> 'kind') is distinct from 'string'
        or pg_catalog.char_length(requirement.value ->> 'kind') not between 1 and 60
        or pg_catalog.jsonb_typeof(requirement.value -> 'componentOwner') is distinct from 'string'
        or pg_catalog.char_length(requirement.value ->> 'componentOwner') not between 1 and 240
    ) then
      raise exception using
        errcode = '22023',
        message = 'Definition restore has invalid verified evidence';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value)
      where pg_catalog.jsonb_typeof(requirement.value -> 'aliases') is distinct from 'array'
    ) then
      raise exception using
        errcode = '22023',
        message = 'Definition restore has invalid verified evidence';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value)
      where pg_catalog.jsonb_array_length(requirement.value -> 'aliases') < 1
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements(requirement.value -> 'aliases') as alias_value(value)
          where pg_catalog.jsonb_typeof(alias_value.value) is distinct from 'string'
            or pg_catalog.char_length(alias_value.value #>> '{}') not between 1 and 500
        )
    ) then
      raise exception using
        errcode = '22023',
        message = 'Definition restore has invalid verified evidence';
    end if;

    select coalesce(pg_catalog.sum(pg_catalog.jsonb_array_length(requirement.value -> 'aliases')), 0)
    into requested_identity_count
    from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value);

    select release_row.*
    into selected_release
    from vortex_definition.releases as release_row
    where release_row.root_id = root_row.root_id
      and release_row.release_revision = p_target_release_revision
      and release_row.authored_source_fingerprint = p_expected_source_fingerprint
      and release_row.release_revision <= root_row.current_release_revision;
    if not found then
      return null;
    end if;
    if pg_catalog.jsonb_typeof(selected_release.resolution_snapshot) is distinct from 'object'
      or pg_catalog.jsonb_typeof(selected_release.resolution_snapshot -> 'identities') is distinct from 'array' then
      raise exception using
        errcode = '23514',
        message = 'Definition restore identity evidence is inconsistent';
    end if;
    select count(*)::bigint
    into snapshot_identity_count
    from pg_catalog.jsonb_array_elements(
      selected_release.resolution_snapshot -> 'identities'
    ) as snapshot(value)
    where snapshot.value ->> 'definitionKey' = root_row.key;

    select
      count(*)::bigint,
      count(distinct pg_catalog.jsonb_build_array(
        requirement.value ->> 'definitionKey',
        requirement.value ->> 'ownerScope',
        requirement.value ->> 'scope',
        requirement.value ->> 'kind',
        requirement.value ->> 'componentOwner',
        requested_alias.alias
      )::text)::bigint
    into matched_identity_count, unique_identity_count
    from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value)
    cross join pg_catalog.jsonb_array_elements_text(requirement.value -> 'aliases') as requested_alias(alias)
    join pg_catalog.jsonb_array_elements(
      selected_release.resolution_snapshot -> 'identities'
    ) as snapshot(value)
      on snapshot.value ->> 'definitionKey' = root_row.key
      and snapshot.value ->> 'definitionKey' = requirement.value ->> 'definitionKey'
      and snapshot.value ->> 'scope' = requirement.value ->> 'scope'
      and snapshot.value ->> 'kind' = requirement.value ->> 'kind'
      and snapshot.value ->> 'componentOwner' = requirement.value ->> 'componentOwner'
      and snapshot.value ->> 'alias' = requested_alias.alias
    join vortex_definition.source_identity_aliases as existing_alias
      on existing_alias.root_id = root_row.root_id
      and existing_alias.owner_scope = requirement.value ->> 'ownerScope'
      and existing_alias.scope = requirement.value ->> 'scope'
      and existing_alias.kind = requirement.value ->> 'kind'
      and existing_alias.component_owner = requirement.value ->> 'componentOwner'
      and existing_alias.alias = requested_alias.alias
      and existing_alias.identity_id::text = (snapshot.value ->> 'identifier');

    if requested_identity_count < 1
      or requested_identity_count <> snapshot_identity_count
      or matched_identity_count <> requested_identity_count
      or unique_identity_count <> requested_identity_count
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value)
        where requirement.value ->> 'definitionKey' is distinct from root_row.key
      ) then
      raise exception using
        errcode = '23514',
        message = 'Definition restore identity evidence is inconsistent';
    end if;

    operation_at := pg_catalog.clock_timestamp();
    update vortex_definition.drafts as draft
    set
      draft_revision = draft.draft_revision + 1,
      draft_source = selected_release.authored_source,
      identity_requirements = p_identity_requirements,
      source_contract_version = selected_release.source_contract_version,
      source_fingerprint = selected_release.authored_source_fingerprint,
      restored_from_release_revision = selected_release.release_revision,
      restored_from_source_fingerprint = selected_release.authored_source_fingerprint,
      restored_by = (checked_context ->> 'organizationAccountId')::uuid,
      restored_at = operation_at,
      restore_correlation_id = (checked_context ->> 'correlationId')::uuid,
      updated_at = operation_at,
      updated_by = (checked_context ->> 'organizationAccountId')::uuid
    where draft.root_id = root_row.root_id
      and draft.draft_revision = p_expected_draft_revision
      and draft.draft_revision < 9007199254740991
    returning pg_catalog.jsonb_build_object(
      'organizationId', root_row.organization_id,
      'kind', root_row.kind,
      'key', root_row.key,
      'rootId', draft.root_id,
      'draftRevision', draft.draft_revision,
      'publishedRevision', root_row.current_release_revision,
      'source', draft.draft_source,
      'sourceContractVersion', draft.source_contract_version,
      'sourceFingerprint', draft.source_fingerprint,
      'createdAt', root_row.created_at,
      'createdBy', root_row.created_by,
      'updatedAt', draft.updated_at,
      'updatedBy', draft.updated_by,
      'restoredFromReleaseRevision', draft.restored_from_release_revision,
      'restoredFromSourceFingerprint', draft.restored_from_source_fingerprint,
      'restoredBy', draft.restored_by,
      'restoredAt', draft.restored_at,
      'restoreCorrelationId', draft.restore_correlation_id
    ) into restored_draft;
    if not found then
      return null;
    end if;

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
          'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
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
      or operation_at > completion_at then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    return restored_draft;
  end if;

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

alter function vortex_definition.restore_release_draft(text, uuid, bigint, bigint, text, jsonb)
  owner to postgres;

revoke execute on function vortex_definition.restore_release_draft(text, uuid, bigint, bigint, text, jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_definition.restore_release_draft(text, uuid, bigint, bigint, text, jsonb) to vortex_request;

comment on function vortex_definition.restore_release_draft(text, uuid, bigint, bigint, text, jsonb) is
  'Conditionally restores one verified immutable authored source into the expected draft revision without allocating identities or moving a release pointer.';

reset role;

commit;
