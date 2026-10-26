-- Product names instead of process vocabulary (N3): functions named for the "evidence" they read
-- are named for what they read. Each renamed function and every function that calls one is
-- re-created from its canonical file, so the canonical files and this migration hold the same
-- definitions; the role revision constraint trigger is renamed with its function.
set role vortex_owner;

alter function vortex_definition.read_restore_release_evidence(text, uuid, bigint) rename to read_release_for_restore;
alter function vortex_definition.read_preview_release_evidence() rename to read_preview_release;
alter function vortex_definition.project_consumer_release_evidence(text, uuid, bigint) rename to project_consumer_release;
alter function vortex_definition.validated_builder_evidence_read_context_internal() rename to validated_builder_read_context_internal;
alter function vortex_access.validate_organization_role_revision_evidence() rename to validate_organization_role_revision;
alter function vortex_access.read_organization_role_change_evidence_for_administration(jsonb) rename to read_organization_role_change_for_administration;
alter function vortex_access.private_management_scope_from_permission_evidence(jsonb) rename to private_management_scope_from_permission;
alter trigger organization_role_revisions_evidence on vortex_access.organization_role_revisions
  rename to organization_role_revisions_checked;

-- read_release_for_restore.sql
create or replace function vortex_definition.read_release_for_restore(
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
    if checked_context - 'draftWriteDeadline' is distinct from initial_human_context then
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
    if final_human_context - 'draftWriteDeadline' is distinct from initial_human_context then
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
          'ownerId', vortex_access.platform_permission_owner_id(),
          'permissionId', vortex_access.platform_permission_id('platform.organization.definition_drafts.manage')
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

revoke execute on function vortex_definition.read_release_for_restore(text, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_release_for_restore(text, uuid, bigint)
  to vortex_request;
comment on function vortex_definition.read_release_for_restore(text, uuid, bigint) is
  'Returns narrow private evidence needed to verify one immutable source before restoring its draft.';

alter function vortex_definition.read_release_for_restore(p_kind text, p_root_id uuid, p_release_revision bigint) owner to vortex_owner;

-- read_preview_release.sql
create or replace function vortex_definition.read_preview_release()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  installation_value jsonb;
  application_value jsonb;
  modules_value jsonb;
begin
  installation_value := vortex_definition.read_current_active_installation();
  if not installation_value ? 'previewInstallationId' then
    raise exception using errcode = '42501', message = 'Preview installation address is required';
  end if;

  application_value := vortex_definition.project_consumer_release(
    'application',
    (installation_value ->> 'applicationRootId')::uuid,
    (installation_value ->> 'applicationReleaseRevision')::bigint
  );
  select pg_catalog.jsonb_agg(
    vortex_definition.project_consumer_release(
      'module',
      (binding.value ->> 'moduleRootId')::uuid,
      (binding.value ->> 'moduleReleaseRevision')::bigint
    ) order by binding.value ->> 'moduleRootId' collate "C"
  ) into modules_value
  from pg_catalog.jsonb_array_elements(installation_value -> 'moduleBindings') as binding(value);
  if application_value is null
    or modules_value is null
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(modules_value) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
    ) then
    raise exception using errcode = '23514', message = 'Preview release evidence is unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'installation', installation_value,
    'correlationId', vortex_access.validated_human_request_context() ->> 'correlationId',
    'application', application_value,
    'modules', modules_value
  );
end
$function$;

alter function vortex_definition.read_preview_release() owner to vortex_owner;

revoke all on function vortex_definition.read_preview_release()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_preview_release()
  to vortex_request;
comment on function vortex_definition.read_preview_release() is
  'The exact release evidence of the preview the validated human Application request runs, from which its provisioning projects the release set the runtime renders.';

-- project_consumer_release.sql
create or replace function vortex_definition.project_consumer_release(
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
      from vortex_definition.runtime_release_dependencies as dependency
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
      from vortex_definition.runtime_release_dependencies as dependency
      join vortex_definition.runtime_releases as target
        on target.root_id = dependency.target_root_id
        and target.release_revision = dependency.target_release_revision
      where dependency.root_id = release.root_id
        and dependency.release_revision = release.release_revision
        and dependency.dependency_kind = 'module'
    ), '[]'::jsonb)
  )
  from vortex_definition.roots as root
  join vortex_definition.runtime_releases as release
    on release.root_id = root.root_id
    and release.release_revision = p_release_revision
  where root.root_id = p_root_id
    and root.kind = p_kind
$function$;

revoke all on function vortex_definition.project_consumer_release(text, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.project_consumer_release(text, uuid, bigint) to vortex_owner;
comment on function vortex_definition.project_consumer_release(text, uuid, bigint) is
  'Owner-private projection of one exact immutable release; performs no scope selection.';

alter function vortex_definition.project_consumer_release(p_kind text, p_root_id uuid, p_release_revision bigint) owner to vortex_owner;

grant execute on function vortex_definition.project_consumer_release(p_kind text, p_root_id uuid, p_release_revision bigint) to postgres;

-- validated_builder_read_context_internal.sql
create or replace function vortex_definition.validated_builder_read_context_internal()
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
  caller_context := vortex_platform.current_context();
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
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.definition_drafts.manage')
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

revoke all on function vortex_definition.validated_builder_read_context_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_definition.validated_builder_read_context_internal() is
  'Returns the validated current system or human context for Definition evidence reads; human requests require definition-draft management permission.';

alter function vortex_definition.validated_builder_read_context_internal() owner to vortex_owner;

grant execute on function vortex_definition.validated_builder_read_context_internal() to postgres;

-- validate_organization_role_revision.sql
create or replace function vortex_access.validate_organization_role_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  target_organization_id uuid;
  target_role_id uuid;
  target_role_revision bigint;
  target_role_kind text;
  target_lifecycle text;
  target_privilege_classification text;
  target_assignment_policy text;
  target_policy_continuity_revision bigint;
  target_authority_continuity_revision bigint;
  target_activation_policy_id uuid;
  target_activation_policy_revision bigint;
  target_application_root_id uuid;
  target_registration_revision bigint;
  previous_lifecycle text;
  previous_assignment_policy text;
  previous_policy_continuity_revision bigint;
  previous_authority_continuity_revision bigint;
  previous_activation_policy_id uuid;
  previous_activation_policy_revision bigint;
  policy_unchanged boolean;
  authority_broadened boolean;
  permission_count bigint;
  administrative_permission_count bigint;
  inconsistent_permission_count bigint;
  inconsistent_source_count bigint;
begin
  target_organization_id := new.organization_id;
  target_role_id := new.role_id;
  target_role_revision := new.revision;

  select revision.role_kind, revision.lifecycle, revision.privilege_classification,
    revision.assignment_policy, revision.policy_continuity_revision,
    revision.authority_continuity_revision, revision.activation_policy_id,
    revision.activation_policy_revision,
    revision.application_root_id,
    revision.accepted_registration_revision
  into target_role_kind, target_lifecycle, target_privilege_classification,
    target_assignment_policy, target_policy_continuity_revision,
    target_authority_continuity_revision, target_activation_policy_id,
    target_activation_policy_revision,
    target_application_root_id,
    target_registration_revision
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = target_organization_id
    and revision.role_id = target_role_id
    and revision.revision = target_role_revision;

  if not found then
    return null;
  end if;

  if target_role_revision = 1 then
    if target_policy_continuity_revision <> 1 then
      raise exception using errcode = '23514',
        message = 'An initial organization role policy continuity revision must be one';
    end if;
    if target_authority_continuity_revision <> 1 then
      raise exception using errcode = '23514',
        message = 'An initial organization role authority continuity revision must be one';
    end if;
  else
    select revision.lifecycle, revision.assignment_policy,
      revision.policy_continuity_revision,
      revision.authority_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision
    into previous_lifecycle, previous_assignment_policy,
      previous_policy_continuity_revision,
      previous_authority_continuity_revision, previous_activation_policy_id,
      previous_activation_policy_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = target_organization_id
      and revision.role_id = target_role_id
      and revision.revision = target_role_revision - 1;

    if not found then
      raise exception using errcode = '23514',
        message = 'An organization role revision requires its immediate predecessor';
    end if;

    policy_unchanged :=
      target_assignment_policy = previous_assignment_policy
      and target_activation_policy_id is not distinct from previous_activation_policy_id
      and target_activation_policy_revision is not distinct
        from previous_activation_policy_revision;

    if policy_unchanged and
      target_policy_continuity_revision <> previous_policy_continuity_revision then
      raise exception using errcode = '23514',
        message = 'Unchanged role policy must preserve policy continuity';
    end if;

    if not policy_unchanged and (
      previous_policy_continuity_revision = 9007199254740991
      or target_policy_continuity_revision <> previous_policy_continuity_revision + 1
    ) then
      raise exception using errcode = '23514',
        message = 'Changed role policy must advance policy continuity exactly once';
    end if;

    select exists (
      select 1
      from vortex_access.organization_role_permission_entries as current_permission
      where current_permission.organization_id = target_organization_id
        and current_permission.role_id = target_role_id
        and current_permission.role_revision = target_role_revision
        and not exists (
          select 1
          from vortex_access.organization_role_permission_entries as previous_permission
          where previous_permission.organization_id = current_permission.organization_id
            and previous_permission.role_id = current_permission.role_id
            and previous_permission.role_revision = target_role_revision - 1
            and previous_permission.application_root_id is not distinct
              from current_permission.application_root_id
            and previous_permission.owner_kind = current_permission.owner_kind
            and previous_permission.owner_id = current_permission.owner_id
            and previous_permission.permission_id = current_permission.permission_id
            and previous_permission.continuity_revision =
              current_permission.continuity_revision
            and previous_permission.meaning_fingerprint =
              current_permission.meaning_fingerprint
        )
    ) into authority_broadened;

    if authority_broadened
      or (
        previous_lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      ) then
      if previous_authority_continuity_revision = 9007199254740991
        or target_authority_continuity_revision <>
          previous_authority_continuity_revision + 1 then
        raise exception using errcode = '23514',
          message = 'Broadened or restored role authority must advance continuity exactly once';
      end if;
    elsif target_authority_continuity_revision <>
      previous_authority_continuity_revision then
      raise exception using errcode = '23514',
        message = 'Preserved or narrowed role authority must preserve continuity';
    end if;
  end if;

  select pg_catalog.count(*) into permission_count
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = target_organization_id
    and permission.role_id = target_role_id
    and permission.role_revision = target_role_revision;

  if (target_role_kind = 'custom' or target_lifecycle = 'active')
    and permission_count = 0 then
    raise exception using errcode = '23514',
      message = 'This organization role lifecycle requires accepted permissions';
  end if;

  select pg_catalog.count(*) into inconsistent_source_count
  from vortex_access.organization_role_permission_entries as permission
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = permission.organization_id
    and registration.registration_kind = permission.registration_kind
    and registration.registration_owner_id = permission.registration_owner_id
    and registration.revision = permission.accepted_registration_revision
  join vortex_access.permission_catalogue_entries as catalogue
    on catalogue.organization_id = permission.organization_id
    and catalogue.registration_kind = permission.registration_kind
    and catalogue.registration_owner_id = permission.registration_owner_id
    and catalogue.registration_revision = permission.accepted_registration_revision
    and catalogue.owner_kind = permission.owner_kind
    and catalogue.owner_id = permission.owner_id
    and catalogue.permission_id = permission.permission_id
  where permission.organization_id = target_organization_id
    and permission.role_id = target_role_id
    and permission.role_revision = target_role_revision
    and (
      permission.catalogue_fingerprint <> registration.permission_catalogue_fingerprint
      or permission.meaning_fingerprint <> catalogue.meaning_fingerprint
    );

  if inconsistent_source_count <> 0 then
    raise exception using errcode = '23514',
      message = 'Role permissions must retain exact catalogue and meaning evidence';
  end if;

  select pg_catalog.count(*) into administrative_permission_count
  from vortex_access.organization_role_permission_entries as permission
  join vortex_access.permission_catalogue_entries as catalogue
    on catalogue.organization_id = permission.organization_id
    and catalogue.registration_kind = permission.registration_kind
    and catalogue.registration_owner_id = permission.registration_owner_id
    and catalogue.registration_revision = permission.accepted_registration_revision
    and catalogue.owner_kind = permission.owner_kind
    and catalogue.owner_id = permission.owner_id
    and catalogue.permission_id = permission.permission_id
  where permission.organization_id = target_organization_id
    and permission.role_id = target_role_id
    and permission.role_revision = target_role_revision
    and catalogue.administrative;

  if target_privilege_classification = 'standard'
    and administrative_permission_count <> 0 then
    raise exception using errcode = '23514',
      message = 'Administrative permissions require privileged role classification';
  end if;

  if target_role_kind = 'application' then
    select pg_catalog.count(*) into inconsistent_source_count
    from vortex_access.organization_role_revisions as revision
    join vortex_access.permission_registration_revisions as registration
      on registration.organization_id = revision.organization_id
      and registration.registration_kind = revision.source_registration_kind
      and registration.registration_owner_id = revision.application_root_id
      and registration.revision = revision.accepted_registration_revision
    where revision.organization_id = target_organization_id
      and revision.role_id = target_role_id
      and revision.revision = target_role_revision
      and (
        revision.source_definition_key <> registration.source_definition_key
        or revision.source_release_revision <> registration.source_revision
        or revision.source_release_version <> registration.source_version
        or revision.source_validation_contract_version <>
          registration.validation_contract_version
      );

    if inconsistent_source_count <> 0 then
      raise exception using errcode = '23514',
        message = 'Application role source must match exact registration evidence';
    end if;

    select pg_catalog.count(*) into inconsistent_permission_count
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = target_organization_id
      and permission.role_id = target_role_id
      and permission.role_revision = target_role_revision
      and (
        permission.application_root_id is distinct from target_application_root_id
        or permission.accepted_registration_revision <> target_registration_revision
      );

    if inconsistent_permission_count <> 0 then
      raise exception using errcode = '23514',
        message = 'Application role permissions must match accepted registration evidence';
    end if;
  end if;

  return null;
end
$function$;
alter function vortex_access.validate_organization_role_revision() owner to vortex_owner;


revoke execute on function vortex_access.validate_organization_role_revision()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.validate_organization_role_revision() is
  'Deferred evidence check of one organisation role revision and its accepted permission entries. Definer, because it fires at commit under the request role, which has no table access.';

alter function vortex_access.validate_organization_role_revision()
  owner to vortex_owner;

-- read_organization_role_change_for_administration.sql
create or replace function vortex_access.read_organization_role_change_for_administration(
  p_preparation jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
  context_organization_id uuid;
  operation_name text;
  accepted_truth text;
  requested jsonb;
  refs jsonb;
  permissions_value jsonb;
  has_administrative_permissions boolean;
  target_application_root_id uuid;
  target_source_role_id uuid;
  application_registration vortex_access.permission_registrations%rowtype;
  selected_continuity vortex_access.application_role_template_continuities%rowtype;
  live_permissions jsonb;
  template_source jsonb;
  role_identity vortex_access.organization_roles%rowtype;
  current_revision vortex_access.organization_role_revisions%rowtype;
  role_configuration jsonb;
  target_role_id uuid;
  expected_role_revision bigint;
  target_lifecycle text := 'active';
  authority_broadened boolean := false;
  manifest_required boolean := false;
  affected_assignments jsonb;
begin
  -- New-role callers supply bounded configuration only. Existing-Application-revision callers
  -- supply only the selected role identity and expected revision; this function derives that
  -- role's configuration and application source from the verified organisation's stored rows.
  -- Neither path accepts a fingerprint or organisation from its caller.
  if p_preparation is null
    or pg_catalog.jsonb_typeof(p_preparation) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_preparation -> 'operation') is distinct from 'string'
    or p_preparation ->> 'operation' not in (
      'create_custom', 'accept_new_application_role', 'accept_application_role_revision'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization role-change preparation input is invalid';
  end if;
  operation_name := p_preparation ->> 'operation';

  if operation_name = 'accept_application_role_revision' then
    if p_preparation - array[
      'operation', 'roleId', 'expectedRoleRevision', 'acceptBroadenedAuthority'
    ]::text[] <> '{}'::jsonb
      or not (p_preparation ?& array[
        'operation', 'roleId', 'expectedRoleRevision', 'acceptBroadenedAuthority'
      ])
      or pg_catalog.jsonb_typeof(p_preparation -> 'roleId') is distinct from 'string'
      or vortex_platform.is_non_nil_uuid(p_preparation ->> 'roleId') is not true
      or (p_preparation ->> 'roleId') <> (p_preparation ->> 'roleId')::uuid::text
      or pg_catalog.jsonb_typeof(p_preparation -> 'expectedRoleRevision')
        is distinct from 'number'
      or (p_preparation ->> 'expectedRoleRevision')::numeric not between
        1 and 9007199254740991
      or (p_preparation ->> 'expectedRoleRevision')::numeric <>
        pg_catalog.trunc((p_preparation ->> 'expectedRoleRevision')::numeric)
      or pg_catalog.jsonb_typeof(p_preparation -> 'acceptBroadenedAuthority')
        is distinct from 'string'
      or p_preparation ->> 'acceptBroadenedAuthority' not in ('accept', 'decline') then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
  elsif pg_catalog.jsonb_typeof(p_preparation -> 'roleKey') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_preparation -> 'label') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_preparation -> 'description') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_preparation -> 'privilegeClassification') is distinct from 'string'
    or p_preparation ->> 'privilegeClassification' not in ('standard', 'privileged')
    or pg_catalog.jsonb_typeof(p_preparation -> 'acceptBroadenedAuthority') is distinct from 'string'
    or p_preparation ->> 'acceptBroadenedAuthority' not in ('accept', 'decline') then
    raise exception using errcode = '22023',
      message = 'Organization role-change preparation input is invalid';
  end if;
  accepted_truth := p_preparation ->> 'acceptBroadenedAuthority';

  -- Explicit acceptance of broadened authority is a visible choice, never inferred from a
  -- submitted form. Declining is an ordinary unavailability, not an error.
  if accepted_truth is distinct from 'accept' then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;

  -- The verified request context and the caller's own current authority decide the organisation;
  -- the caller never names it. A custom role needs role management. Accepting an application's
  -- role template or role revision is part of installing or upgrading that application, so it
  -- needs the installation permission instead; the writer keeps the delegated-scope and recent
  -- sign-in checks for both.
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', case when operation_name = 'create_custom'
        then 'platform.organization.roles.manage'
        else 'platform.organization.applications.manage' end,
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission(
        case when operation_name = 'create_custom'
          then 'platform.organization.roles.manage'
          else 'platform.organization.applications.manage' end
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Organization role-change preparation is unavailable';
  end if;
  context_organization_id := decision.organization_id;

  if operation_name = 'accept_application_role_revision' then
    target_role_id := (p_preparation ->> 'roleId')::uuid;
    expected_role_revision :=
      (p_preparation ->> 'expectedRoleRevision')::numeric::bigint;
    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = context_organization_id
      and stored.role_id = target_role_id;
    if not found
      or role_identity.role_kind <> 'application'
      or role_identity.application_root_id is null
      or role_identity.application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
      or role_identity.source_role_id is null
      or role_identity.source_role_id = '00000000-0000-0000-0000-000000000000'::uuid
      or role_identity.live_revision <> expected_role_revision then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;
    if role_identity.live_revision = 9007199254740991 then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    select revision.* into current_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = context_organization_id
      and revision.role_id = target_role_id
      and revision.revision = expected_role_revision;
    if not found
      or current_revision.lifecycle is null
      or current_revision.lifecycle not in ('active', 'acceptance_required') then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    target_application_root_id := role_identity.application_root_id;
    target_source_role_id := role_identity.source_role_id;
    role_configuration := pg_catalog.jsonb_build_object(
      'roleId', role_identity.role_id,
      'expectedRoleRevision', current_revision.revision,
      'key', current_revision.role_key,
      'label', current_revision.label,
      'description', current_revision.description,
      'privilegeClassification', current_revision.privilege_classification,
      'assignmentPolicy', case current_revision.assignment_policy
        when 'standing' then pg_catalog.jsonb_build_object('kind', 'standing')
        else pg_catalog.jsonb_build_object(
          'kind', 'activation_required',
          'activationPolicy', pg_catalog.jsonb_build_object(
            'selection', 'existing',
            'reference', pg_catalog.jsonb_build_object(
              'activationPolicyId', current_revision.activation_policy_id,
              'revision', current_revision.activation_policy_revision
            )
          )
        )
      end,
      'sourceRoleId', role_identity.source_role_id
    );
  end if;

  if operation_name = 'create_custom' then
    requested := p_preparation -> 'permissions';
    if pg_catalog.jsonb_typeof(requested) is distinct from 'array'
      or pg_catalog.jsonb_array_length(requested) = 0 then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(requested) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not (item.value ?& array['ownerKind', 'ownerId', 'permissionId'])
        or pg_catalog.jsonb_typeof(item.value -> 'ownerKind') is distinct from 'string'
        or item.value ->> 'ownerKind' not in ('platform', 'application', 'module')
        or pg_catalog.jsonb_typeof(item.value -> 'ownerId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(item.value ->> 'ownerId') is not true
        or pg_catalog.jsonb_typeof(item.value -> 'permissionId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(item.value ->> 'permissionId') is not true
        or ((item.value ->> 'ownerKind' = 'platform') = (item.value ? 'applicationRootId'))
        or (
          item.value ->> 'ownerKind' <> 'platform'
          and (
            pg_catalog.jsonb_typeof(item.value -> 'applicationRootId') is distinct from 'string'
            or vortex_platform.is_non_nil_uuid(item.value ->> 'applicationRootId') is not true
            or (item.value ->> 'ownerKind' = 'application'
              and (item.value ->> 'ownerId')::uuid
                <> (item.value ->> 'applicationRootId')::uuid)
          )
        )
    ) then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
    select pg_catalog.jsonb_agg(distinct pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'applicationRootId', case when item.value ->> 'ownerKind' = 'platform'
          then null else (item.value ->> 'applicationRootId')::uuid end,
        'ownerKind', item.value ->> 'ownerKind',
        'ownerId', (item.value ->> 'ownerId')::uuid,
        'permissionId', (item.value ->> 'permissionId')::uuid
      )
    ))
    into refs
    from pg_catalog.jsonb_array_elements(requested) as item(value);
    if refs is null
      or pg_catalog.jsonb_array_length(refs) <> pg_catalog.jsonb_array_length(requested) then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
  else
    if operation_name <> 'accept_application_role_revision' then
      if pg_catalog.jsonb_typeof(p_preparation -> 'applicationRootId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(p_preparation ->> 'applicationRootId') is not true
        or pg_catalog.jsonb_typeof(p_preparation -> 'sourceRoleId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(p_preparation ->> 'sourceRoleId') is not true then
        raise exception using errcode = '22023',
          message = 'Organization role-change preparation input is invalid';
      end if;
      target_application_root_id := (p_preparation ->> 'applicationRootId')::uuid;
      target_source_role_id := (p_preparation ->> 'sourceRoleId')::uuid;
    end if;

    select registration.* into application_registration
    from vortex_access.permission_registrations as registration
    where registration.organization_id = context_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = target_application_root_id
      and registration.state = 'active';
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    select continuity.* into selected_continuity
    from vortex_access.application_role_template_continuities as continuity
    where continuity.organization_id = context_organization_id
      and continuity.application_root_id = target_application_root_id
      and continuity.source_role_id = target_source_role_id
      and continuity.state = 'available'
      and continuity.last_processed_registration_revision = application_registration.revision;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    -- The writer reads the same projection, so the evidence names the registration revision and
    -- its catalogue fingerprint instead of carrying the registered entries.
    live_permissions := vortex_access.application_role_template_live_permissions_internal(
      context_organization_id, target_application_root_id, application_registration.revision,
      target_source_role_id
    );
    if live_permissions is null then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;
    template_source := pg_catalog.jsonb_build_object(
      'applicationRootId', target_application_root_id,
      'registrationRevision', application_registration.revision,
      'catalogueFingerprint', application_registration.permission_catalogue_fingerprint
    );

    select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', item.value -> 'applicationRootId',
        'ownerKind', item.value ->> 'ownerKind',
        'ownerId', item.value ->> 'ownerId',
        'permissionId', item.value ->> 'permissionId'
      )))
    into refs
    from pg_catalog.jsonb_array_elements(live_permissions) as item(value);
  end if;

  -- Every requested identity must still resolve to exactly one current, available accepted
  -- permission. The returned scope is exactly the references the role entry names, never wider.
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'kind', 'exact',
      'applicationRootId', continuity.application_root_id,
      'ownerKind', continuity.owner_kind,
      'ownerId', continuity.owner_id,
      'permissionId', continuity.permission_id,
      'acceptedRegistrationRevision', registration.revision,
      'catalogueFingerprint', registration.permission_catalogue_fingerprint,
      'continuityRevision', continuity.continuity_revision,
      'meaningFingerprint', continuity.meaning_fingerprint
    )) order by continuity.application_root_id nulls last,
      continuity.owner_kind collate "C", continuity.owner_id, continuity.permission_id),
    pg_catalog.bool_or(catalogue.administrative)
  into permissions_value, has_administrative_permissions
  from pg_catalog.jsonb_array_elements(refs) as requested_permission(value)
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = context_organization_id
    and continuity.state = 'available'
    and continuity.application_scope_id = coalesce(case when requested_permission.value ? 'applicationRootId'
        then (requested_permission.value ->> 'applicationRootId')::uuid else null end, '00000000-0000-0000-0000-000000000000'::uuid)
      and (requested_permission.value ->> 'applicationRootId') is distinct from '00000000-0000-0000-0000-000000000000'
    and continuity.owner_kind = requested_permission.value ->> 'ownerKind'
    and continuity.owner_id = (requested_permission.value ->> 'ownerId')::uuid
    and continuity.permission_id = (requested_permission.value ->> 'permissionId')::uuid
  join vortex_access.permission_registrations as registration
    on registration.organization_id = continuity.organization_id
    and registration.registration_kind = continuity.registration_kind
    and registration.registration_owner_id = continuity.registration_owner_id
    and registration.state = 'active'
  join vortex_access.permission_catalogue_entries as catalogue
    on catalogue.organization_id = continuity.organization_id
    and catalogue.registration_kind = continuity.registration_kind
    and catalogue.registration_owner_id = continuity.registration_owner_id
    and catalogue.registration_revision = registration.revision
    and catalogue.owner_kind = continuity.owner_kind
    and catalogue.owner_id = continuity.owner_id
    and catalogue.permission_id = continuity.permission_id
    and catalogue.application_root_id is not distinct from continuity.application_root_id
    and catalogue.meaning_fingerprint = continuity.meaning_fingerprint;
  if permissions_value is null
    or pg_catalog.jsonb_array_length(permissions_value)
      <> pg_catalog.jsonb_array_length(refs) then
    raise exception using errcode = '40001',
      message = 'Organization role permission evidence is stale or unavailable';
  end if;

  -- Reject the submitted classification before sealing evidence for a write whose deferred
  -- revision constraint would reject the same administrative permissions at commit.
  if operation_name <> 'accept_application_role_revision'
    and p_preparation ->> 'privilegeClassification' = 'standard'
    and has_administrative_permissions then
    return pg_catalog.jsonb_build_object(
      'outcome', 'invalid_privilege_classification',
      'organizationId', context_organization_id
    );
  end if;

  if operation_name = 'accept_application_role_revision' then
    select exists (
      select 1
      from pg_catalog.jsonb_array_elements(permissions_value) as proposed(value)
      where not exists (
        select 1
        from vortex_access.organization_role_permission_entries as existing
        where existing.organization_id = context_organization_id
          and existing.role_id = target_role_id
          and existing.role_revision = current_revision.revision
          and existing.application_root_id is not distinct from
            case when proposed.value ? 'applicationRootId'
              then (proposed.value ->> 'applicationRootId')::uuid else null end
          and existing.owner_kind = proposed.value ->> 'ownerKind'
          and existing.owner_id = (proposed.value ->> 'ownerId')::uuid
          and existing.permission_id = (proposed.value ->> 'permissionId')::uuid
          and existing.continuity_revision =
            (proposed.value ->> 'continuityRevision')::numeric::bigint
          and existing.meaning_fingerprint = proposed.value ->> 'meaningFingerprint'
      )
    ) into authority_broadened;

    -- The candidate preserves the current assignment policy and either moves from
    -- acceptance_required to active or keeps an active revision active. This is the writer's
    -- manifest predicate, so the only additional true term for this operation is a broadened
    -- permission projection.
    manifest_required :=
      current_revision.assignment_policy is distinct from
        (role_configuration #>> '{assignmentPolicy,kind}')
      or (
        current_revision.lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      )
      or authority_broadened;

    if manifest_required then
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'roleAssignmentId', assignment.role_assignment_id,
            'expectedRevision', assignment.revision,
            'assignee', case
              when assignment.assignee_kind = 'organization_account' then
                pg_catalog.jsonb_build_object(
                  'kind', 'organization_account',
                  'organizationAccountId', assignment.organization_account_id
                )
              else pg_catalog.jsonb_build_object(
                'kind', 'group',
                'groupId', assignment.group_id
              )
            end
          ) order by assignment.role_assignment_id
        ),
        '[]'::jsonb
      ) into affected_assignments
      from vortex_access.organization_role_assignments as assignment
      where assignment.organization_id = context_organization_id
        and assignment.role_id = target_role_id
        and assignment.state = 'live';
    end if;

    return pg_catalog.jsonb_build_object(
      'outcome', 'available',
      'organizationId', context_organization_id,
      'roleConfiguration', role_configuration,
      'permissions', permissions_value,
      'templateContinuityRevision', selected_continuity.continuity_revision,
      'templateSource', template_source,
      'manifestRequired', manifest_required,
      'affectedAssignments', affected_assignments
    );
  end if;

  if operation_name = 'create_custom' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'available',
      'organizationId', context_organization_id,
      'permissions', permissions_value,
      'templateContinuityRevision', null,
      'templateSource', null
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'available',
    'organizationId', context_organization_id,
    'permissions', permissions_value,
    'templateContinuityRevision', selected_continuity.continuity_revision,
    'templateSource', template_source
  );
exception
  when invalid_text_representation or invalid_parameter_value
      or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Organization role-change preparation input is invalid';
end
$function$;

revoke execute on function vortex_access.read_organization_role_change_for_administration(jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.read_organization_role_change_for_administration(jsonb)
to vortex_request;

comment on function vortex_access.read_organization_role_change_for_administration(jsonb) is
  'Server-side preparation read: given bounded role configuration or an existing Application role identity and expected revision, it returns complete, fingerprinted permission and template evidence for the verified caller organisation only, deriving stored role configuration, actor and organisation from protected context and including an exact live-assignment snapshot only when the writer requires it.';

alter function vortex_access.read_organization_role_change_for_administration(p_preparation jsonb) owner to vortex_owner;

grant execute on function vortex_access.read_organization_role_change_for_administration(p_preparation jsonb) to postgres;

-- private_management_scope_from_permission.sql
CREATE OR REPLACE FUNCTION vortex_access.private_management_scope_from_permission(p_permissions jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  projected jsonb;
begin
  if p_permissions is null
    or pg_catalog.jsonb_typeof(p_permissions) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Private management permission evidence is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_permissions) = 0 then
    return pg_catalog.jsonb_build_object('kind', 'none');
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_permissions) as item(value)
    where (
      pg_catalog.jsonb_typeof(item.value) = 'object'
      and item.value ?& array[
        'ownerKind', 'ownerId', 'permissionId',
        'acceptedRegistrationRevision', 'meaningFingerprint'
      ]
      and pg_catalog.jsonb_typeof(item.value -> 'ownerKind') = 'string'
      and item.value ->> 'ownerKind' in ('platform', 'application', 'module')
      and pg_catalog.jsonb_typeof(item.value -> 'ownerId') = 'string'
      and vortex_platform.is_non_nil_uuid(item.value ->> 'ownerId')
      and pg_catalog.jsonb_typeof(item.value -> 'permissionId') = 'string'
      and vortex_platform.is_non_nil_uuid(item.value ->> 'permissionId')
      and pg_catalog.jsonb_typeof(item.value -> 'acceptedRegistrationRevision') = 'number'
      and (item.value ->> 'acceptedRegistrationRevision')::numeric
        between 1 and 9007199254740991
      and (item.value ->> 'acceptedRegistrationRevision')::numeric =
        pg_catalog.trunc((item.value ->> 'acceptedRegistrationRevision')::numeric)
      and pg_catalog.jsonb_typeof(item.value -> 'meaningFingerprint') = 'string'
      and item.value ->> 'meaningFingerprint' ~ '^sha256:[a-f0-9]{64}$'
      and (
        (
          item.value ->> 'ownerKind' = 'platform'
          and not item.value ? 'applicationRootId'
        ) or (
          item.value ->> 'ownerKind' in ('application', 'module')
          and pg_catalog.jsonb_typeof(item.value -> 'applicationRootId') = 'string'
          and vortex_platform.is_non_nil_uuid(item.value ->> 'applicationRootId')
          and (
            item.value ->> 'ownerKind' <> 'application'
            or (item.value ->> 'ownerId')::uuid =
              (item.value ->> 'applicationRootId')::uuid
          )
        )
      )
    ) is not true
  ) then
    raise exception using errcode = '22023',
      message = 'Private management permission evidence is invalid';
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(
    pg_catalog.jsonb_build_object(
      'applicationRootId', parsed.application_root_id,
      'ownerKind', parsed.owner_kind,
      'ownerId', parsed.owner_id,
      'permissionId', parsed.permission_id,
      'acceptedRegistrationRevision', parsed.accepted_registration_revision,
      'meaningFingerprint', parsed.meaning_fingerprint
    )
  ) order by parsed.application_root_id nulls first,
    parsed.owner_kind collate "C", parsed.owner_id, parsed.permission_id)
  into projected
  from (
    select distinct
      case when item.value ->> 'ownerKind' = 'platform' then null::uuid
        else (item.value ->> 'applicationRootId')::uuid end as application_root_id,
      item.value ->> 'ownerKind' as owner_kind,
      (item.value ->> 'ownerId')::uuid as owner_id,
      (item.value ->> 'permissionId')::uuid as permission_id,
      (item.value ->> 'acceptedRegistrationRevision')::bigint as accepted_registration_revision,
      item.value ->> 'meaningFingerprint' as meaning_fingerprint
    from pg_catalog.jsonb_array_elements(p_permissions) as item(value)
  ) as parsed;

  return pg_catalog.jsonb_build_object(
    'kind', 'bounded', 'permissions', projected
  );
end
$$;

alter function vortex_access.private_management_scope_from_permission(p_permissions jsonb) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.private_management_scope_from_permission(p_permissions jsonb) FROM PUBLIC;

grant execute on function vortex_access.private_management_scope_from_permission(p_permissions jsonb) to postgres;

-- coordinate_private_organization_role_authority_change.sql
create or replace function vortex_access.coordinate_private_organization_role_authority_change(
  p_prepared_evidence jsonb,
  p_activity_id uuid
)
returns table (
  outcome text,
  operation text,
  role jsonb,
  created_activation_policy jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  candidate jsonb;
  operation_name text;
  operation_key text;
  target_organization_id uuid;
  target_role_id uuid;
  expected_role_revision bigint;
  role_identity vortex_access.organization_roles%rowtype;
  current_revision vortex_access.organization_role_revisions%rowtype;
  authority_before jsonb;
  authority_after jsonb;
  policy_choice jsonb;
  policy_changed boolean;
  decision record;
  changed record;
  activity_result text;
begin
  if p_prepared_evidence is null
    or pg_catalog.jsonb_typeof(p_prepared_evidence) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_prepared_evidence -> 'candidate')
      is distinct from 'object'
    or vortex_platform.is_non_nil_uuid(p_activity_id::text) is not true then
    raise exception using errcode = '22023',
      message = 'Private Organization role-authority input is invalid';
  end if;

  candidate := p_prepared_evidence -> 'candidate';
  operation_name := candidate ->> 'operation';
  if operation_name is null or operation_name not in (
    'create_custom', 'create_custom_from_template',
    'accept_new_application_role', 'revise_metadata_policy',
    'revise_custom_permissions', 'accept_application_role_revision'
  )
    or pg_catalog.jsonb_typeof(candidate -> 'organizationId')
      is distinct from 'string'
    or not vortex_platform.is_non_nil_uuid(candidate ->> 'organizationId')
    or pg_catalog.jsonb_typeof(candidate -> 'roleId') is distinct from 'string'
    or not vortex_platform.is_non_nil_uuid(candidate ->> 'roleId') then
    raise exception using errcode = '22023',
      message = 'Private Organization role-authority input is invalid';
  end if;
  target_organization_id := (candidate ->> 'organizationId')::uuid;
  target_role_id := (candidate ->> 'roleId')::uuid;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  if target_organization_id is distinct from context_organization_id then
    raise exception using errcode = '42501',
      message = 'Private Organization role-authority change is unavailable';
  end if;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Private Organization role-authority change is unavailable';
  end if;

  if operation_name in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    if exists (
      select 1 from vortex_access.organization_roles as stored
      where stored.organization_id = context_organization_id
        and stored.role_id = target_role_id
    ) then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority change is stale or unavailable';
    end if;
    authority_before := pg_catalog.jsonb_build_object('kind', 'none');
  else
    if pg_catalog.jsonb_typeof(candidate -> 'expectedRoleRevision')
        is distinct from 'number'
      or (candidate ->> 'expectedRoleRevision')::numeric not between
        1 and 9007199254740991
      or (candidate ->> 'expectedRoleRevision')::numeric <>
        pg_catalog.trunc((candidate ->> 'expectedRoleRevision')::numeric) then
      raise exception using errcode = '22023',
        message = 'Private Organization role-authority input is invalid';
    end if;
    expected_role_revision :=
      (candidate ->> 'expectedRoleRevision')::numeric::bigint;
    select identity.* into role_identity
    from vortex_access.organization_roles as identity
    where identity.organization_id = context_organization_id
      and identity.role_id = target_role_id
    for update of identity;
    if not found or role_identity.live_revision is distinct from expected_role_revision then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority change is stale or unavailable';
    end if;
    select revision.* into current_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = context_organization_id
      and revision.role_id = target_role_id
      and revision.revision = role_identity.live_revision;
    if not found then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority change is stale or unavailable';
    end if;
    authority_before := vortex_access.private_current_role_management_scope(
      context_organization_id, target_role_id, expected_role_revision
    );
  end if;

  -- Installation acceptance changes the supplied permissions, never the organization's local
  -- role settings. Compare the complete policy choice, including the immutable activation-policy
  -- revision, under the same Access lock as the write. Changing settings uses role management.
  if operation_name = 'accept_application_role_revision' and (
    candidate -> 'key' is distinct from pg_catalog.to_jsonb(current_revision.role_key)
    or candidate -> 'label' is distinct from pg_catalog.to_jsonb(current_revision.label)
    or candidate -> 'description' is distinct from pg_catalog.to_jsonb(current_revision.description)
    or candidate -> 'privilegeClassification' is distinct from
      pg_catalog.to_jsonb(current_revision.privilege_classification)
    or candidate -> 'assignmentPolicy' is distinct from case current_revision.assignment_policy
      when 'standing' then pg_catalog.jsonb_build_object('kind', 'standing')
      else pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'activationPolicy', pg_catalog.jsonb_build_object(
          'selection', 'existing',
          'reference', pg_catalog.jsonb_build_object(
            'activationPolicyId', current_revision.activation_policy_id,
            'revision', current_revision.activation_policy_revision
          )
        )
      )
    end
  ) then
    raise exception using errcode = 'V3151',
      message = 'Accepting application role changes must keep the role settings. Use Manage roles to change its name, description, classification or assignment and activation settings.';
  end if;

  if operation_name = 'revise_metadata_policy' then
    policy_choice := candidate -> 'assignmentPolicy';
    if pg_catalog.jsonb_typeof(policy_choice) is distinct from 'object'
      or pg_catalog.jsonb_typeof(policy_choice -> 'kind') is distinct from 'string'
      or policy_choice ->> 'kind' not in ('standing', 'activation_required') then
      raise exception using errcode = '22023',
        message = 'Private Organization role-authority input is invalid';
    end if;
    if policy_choice ->> 'kind' = 'standing' then
      policy_changed := current_revision.assignment_policy <> 'standing';
    elsif policy_choice #>> '{activationPolicy,selection}' = 'new' then
      policy_changed := true;
    elsif policy_choice #>> '{activationPolicy,selection}' = 'existing'
      and vortex_platform.is_non_nil_uuid(
        policy_choice #>> '{activationPolicy,reference,activationPolicyId}'
      )
      and pg_catalog.jsonb_typeof(
        policy_choice #> '{activationPolicy,reference,revision}'
      ) = 'number'
      and (policy_choice #>>
        '{activationPolicy,reference,revision}')::numeric between
        1 and 9007199254740991
      and (policy_choice #>>
        '{activationPolicy,reference,revision}')::numeric =
        pg_catalog.trunc((policy_choice #>>
          '{activationPolicy,reference,revision}')::numeric) then
      policy_changed := current_revision.assignment_policy <> 'activation_required'
        or current_revision.activation_policy_id is distinct from
          (policy_choice #>>
            '{activationPolicy,reference,activationPolicyId}')::uuid
        or current_revision.activation_policy_revision is distinct from
          (policy_choice #>> '{activationPolicy,reference,revision}')::numeric::bigint;
    else
      raise exception using errcode = '22023',
        message = 'Private Organization role-authority input is invalid';
    end if;
    if policy_changed is not true then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority candidate changes no authority';
    end if;
    authority_after := authority_before;
  else
    authority_after := vortex_access.private_management_scope_from_permission(
      candidate -> 'permissions'
    );
  end if;

  if authority_before ->> 'kind' = 'none'
    and authority_after ->> 'kind' = 'none' then
    raise exception using errcode = '40001',
      message = 'Private Organization role-authority scope is unavailable';
  end if;

  -- Accepting an application's role template or role revision is part of installing or upgrading
  -- that application, so it needs the installation permission (Manage applications) instead of
  -- role management; the delegated scope over every permission and the recent sign-in stay.
  operation_key := 'platform.organization.roles.' || operation_name;
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', operation_key,
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', case
          when operation_name in ('accept_new_application_role', 'accept_application_role_revision')
            then vortex_access.platform_permission_id('platform.organization.applications.manage')
          else vortex_access.platform_permission_id('platform.organization.roles.manage')
        end
      ),
      'recentAuthentication', case
        when operation_name in (
          'create_custom_from_template', 'accept_new_application_role',
          'accept_application_role_revision'
        ) then pg_catalog.jsonb_build_object(
          'kind', 'primary', 'maximumAgeSeconds', 900
        )
        else pg_catalog.jsonb_build_object('kind', 'none')
      end,
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', authority_before,
        'after', authority_after
      )
    )
  ) as evaluated;
  if decision.operation_key is distinct from operation_key
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Private Organization role-authority change is unavailable';
  end if;

  if decision.outcome = 'refused' and decision.reason_code = 'authentication_unsatisfied' then
    raise exception using errcode = 'V3150',
      message = 'Organization role-authority change requires recent primary authentication';
  end if;
  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Private Organization role-authority change is unavailable';
  end if;

  select result.* into strict changed
  from vortex_access.coordinate_organization_role_change(
    p_prepared_evidence, context_account_id, context_correlation_id
  ) as result;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    (changed.role ->> 'changedAt')::timestamptz,
    'organization_account', context_account_id, operation_name,
    array[target_role_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Private Organization role-authority Activity is stale';
  end if;

  return query select changed.outcome, changed.operation, changed.role,
    changed.created_activation_policy, changed.access_version,
    changed.correlation_id;
exception
  when invalid_text_representation or invalid_parameter_value
      or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Private Organization role-authority input is invalid';
end
$function$;

revoke execute on function vortex_access.coordinate_private_organization_role_authority_change(jsonb, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_private_organization_role_authority_change(jsonb, uuid) is
  'Owner-only authority-establishing role composition. It checks exact current/candidate permission scope, then reuses canonical role evidence, manifests, stewardship and Activity without exposing a grant endpoint.';

alter function vortex_access.coordinate_private_organization_role_authority_change(p_prepared_evidence jsonb, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.coordinate_private_organization_role_authority_change(p_prepared_evidence jsonb, p_activity_id uuid) to postgres;

-- list_organization_builder_roots.sql
create or replace function vortex_definition.list_organization_builder_roots(p_after_key text)
returns table (
  root_id uuid,
  kind text,
  definition_key text,
  display_name text,
  draft_revision bigint,
  current_release_revision bigint,
  application_origin_kind text,
  description text,
  icon text,
  edited_at timestamptz,
  edited_by uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
begin
  checked_context := vortex_definition.validated_builder_read_context_internal();
  if checked_context ->> 'callerKind' is distinct from 'human'
    or checked_context ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Definition builder root listing requires a human organization context';
  end if;

  return query
  select
    root.root_id,
    root.kind,
    root.key,
    coalesce(
      nullif(pg_catalog.btrim(draft.draft_source -> 'body' ->> 'name'), ''),
      nullif(pg_catalog.btrim(release.authored_source -> 'body' ->> 'name'), '')
    ),
    draft.draft_revision,
    root.current_release_revision,
    root.application_origin_kind,
    coalesce(draft.draft_source, release.authored_source) -> 'body' ->> 'description',
    coalesce(draft.draft_source, release.authored_source) -> 'body' ->> 'icon',
    coalesce(draft.updated_at, root.created_at),
    coalesce(draft.updated_by, root.created_by)
  from vortex_definition.roots as root
  left join vortex_definition.drafts as draft on draft.root_id = root.root_id
  left join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = root.current_release_revision
  where root.organization_id = (checked_context ->> 'organizationId')::uuid
    and root.kind = 'application'
    and (p_after_key is null or root.key > p_after_key)
  order by root.key
  limit 41;
end
$function$;

revoke all on function vortex_definition.list_organization_builder_roots(text)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.list_organization_builder_roots(text)
  to vortex_request;

comment on function vortex_definition.list_organization_builder_roots(text) is
  'Lists a keyset page of 40 Application roots plus one continuation row in the validated human request organization for a permitted builder; Modules are internal to the Application that owns them.';

alter function vortex_definition.list_organization_builder_roots(text) owner to vortex_owner;

-- lock_active_installation_runtime_mapping_internal.sql
create or replace function vortex_definition.lock_active_installation_runtime_mapping_internal(p_expected_identity jsonb)
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare
  checked_context jsonb;
  selected_org uuid;
  selected_app uuid;
  selected_revision bigint;
  active_count integer;
  registered_app record;
  registered_identity jsonb;
  bindings jsonb;
  pin_facts jsonb;
  pin_hash text;
  identity_value jsonb;
  before_identity jsonb;
  item jsonb;
  installation jsonb;
  application_evidence jsonb;
  module_evidence jsonb;
  release_identity jsonb;
begin
  checked_context:=vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human'
    or not checked_context ? 'applicationRootId'
    or pg_catalog.clock_timestamp()>=(checked_context ->> 'expiresAt')::timestamptz
    or (checked_context ? 'delegatedContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{delegatedContext,expiresAt}')::timestamptz)
    or (checked_context ? 'supportContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{supportContext,expiresAt}')::timestamptz) then
    raise exception using errcode='42501', message='Active Application context is unavailable';
  end if;
  selected_org:=(checked_context ->> 'organizationId')::uuid;
  selected_app:=(checked_context ->> 'applicationRootId')::uuid;
  select pg_catalog.min(binding.application_release_revision),pg_catalog.count(*)::integer
  into selected_revision,active_count from vortex_definition.installation_bindings as binding
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if active_count not between 1 and 10000 or selected_revision is null or exists(
    select 1 from vortex_definition.installation_bindings as binding
    where binding.organization_id=selected_org and binding.application_root_id=selected_app
      and binding.state<>'detached'
      and (binding.state<>'active' or binding.application_release_revision<>selected_revision)) then
    raise exception using errcode='P0002', message='Active Application installation is unavailable';
  end if;
  select snapshot.* into strict registered_app
  from vortex_access.read_application_permission_snapshot(selected_org,selected_app) as snapshot;
  if registered_app.release_revision is distinct from selected_revision then
    raise exception using errcode='40001', message='Active Application registration changed';
  end if;
  registered_identity:=pg_catalog.jsonb_build_object(
    'rootId',selected_app,'definitionKey',registered_app.definition_key,
    'releaseRevision',selected_revision,'releaseVersion',registered_app.release_version,
    'validationContractVersion',registered_app.validation_contract_version,
    'contentFingerprint',registered_app.content_fingerprint,
    'resolutionFingerprint',registered_app.resolution_fingerprint);
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'bindingRevision',binding.binding_revision,'state',binding.state) order by binding.module_root_id),
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'contentFingerprint',module_release.content_fingerprint,
      'resolutionFingerprint',module_release.resolution_fingerprint) order by binding.module_root_id)
  into bindings,pin_facts from vortex_definition.installation_bindings as binding
  join vortex_definition.releases as module_release
    on module_release.root_id=binding.module_root_id
    and module_release.release_revision=binding.module_release_revision
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if exists(select 1 from pg_catalog.jsonb_array_elements(pin_facts) as pin(value)
    where (pin.value ->> 'contentFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or (pin.value ->> 'resolutionFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or pin.value ->> 'contentFingerprint' is null
      or pin.value ->> 'resolutionFingerprint' is null) then
    raise exception using errcode='55000', message='Active Application pins are unavailable';
  end if;
  pin_hash:='sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pin_facts::text,'UTF8')),'hex');
  identity_value:=pg_catalog.jsonb_build_object(
    'tenantId',checked_context -> 'tenantId','organizationId',selected_org,
    'organizationAccountId',checked_context -> 'organizationAccountId',
    'identityId',checked_context -> 'identityId','sessionId',checked_context -> 'sessionId',
    'accessVersion',checked_context -> 'accessVersion','correlationId',checked_context -> 'correlationId',
    'applicationRootId',selected_app,'applicationReleaseRevision',selected_revision,
    'registeredApplication',registered_identity,'moduleBindings',bindings,
    'pinFacts',pin_facts,'pinFingerprint',pin_hash);
  if p_expected_identity is distinct from identity_value then
    raise exception using errcode='40001', message='Active Application identity changed';
  end if;
  before_identity:=identity_value;
  for item in select pin.value from pg_catalog.jsonb_array_elements(bindings) as pin(value)
    order by (pin.value ->> 'moduleRootId')::uuid
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'vortex_definition.binding:' || selected_org::text || ':' || selected_app::text || ':' ||
        (item ->> 'moduleRootId'),0));
    perform 1 from vortex_definition.installation_bindings as binding
    where binding.organization_id=selected_org and binding.application_root_id=selected_app
      and binding.module_root_id=(item ->> 'moduleRootId')::uuid for update;
  checked_context:=vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human'
    or not checked_context ? 'applicationRootId'
    or pg_catalog.clock_timestamp()>=(checked_context ->> 'expiresAt')::timestamptz
    or (checked_context ? 'delegatedContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{delegatedContext,expiresAt}')::timestamptz)
    or (checked_context ? 'supportContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{supportContext,expiresAt}')::timestamptz) then
    raise exception using errcode='42501', message='Active Application context is unavailable';
  end if;
  selected_org:=(checked_context ->> 'organizationId')::uuid;
  selected_app:=(checked_context ->> 'applicationRootId')::uuid;
  select pg_catalog.min(binding.application_release_revision),pg_catalog.count(*)::integer
  into selected_revision,active_count from vortex_definition.installation_bindings as binding
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if active_count not between 1 and 10000 or selected_revision is null or exists(
    select 1 from vortex_definition.installation_bindings as binding
    where binding.organization_id=selected_org and binding.application_root_id=selected_app
      and binding.state<>'detached'
      and (binding.state<>'active' or binding.application_release_revision<>selected_revision)) then
    raise exception using errcode='P0002', message='Active Application installation is unavailable';
  end if;
  select snapshot.* into strict registered_app
  from vortex_access.read_application_permission_snapshot(selected_org,selected_app) as snapshot;
  if registered_app.release_revision is distinct from selected_revision then
    raise exception using errcode='40001', message='Active Application registration changed';
  end if;
  registered_identity:=pg_catalog.jsonb_build_object(
    'rootId',selected_app,'definitionKey',registered_app.definition_key,
    'releaseRevision',selected_revision,'releaseVersion',registered_app.release_version,
    'validationContractVersion',registered_app.validation_contract_version,
    'contentFingerprint',registered_app.content_fingerprint,
    'resolutionFingerprint',registered_app.resolution_fingerprint);
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'bindingRevision',binding.binding_revision,'state',binding.state) order by binding.module_root_id),
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'contentFingerprint',module_release.content_fingerprint,
      'resolutionFingerprint',module_release.resolution_fingerprint) order by binding.module_root_id)
  into bindings,pin_facts from vortex_definition.installation_bindings as binding
  join vortex_definition.releases as module_release
    on module_release.root_id=binding.module_root_id
    and module_release.release_revision=binding.module_release_revision
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if exists(select 1 from pg_catalog.jsonb_array_elements(pin_facts) as pin(value)
    where (pin.value ->> 'contentFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or (pin.value ->> 'resolutionFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or pin.value ->> 'contentFingerprint' is null
      or pin.value ->> 'resolutionFingerprint' is null) then
    raise exception using errcode='55000', message='Active Application pins are unavailable';
  end if;
  pin_hash:='sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pin_facts::text,'UTF8')),'hex');
  identity_value:=pg_catalog.jsonb_build_object(
    'tenantId',checked_context -> 'tenantId','organizationId',selected_org,
    'organizationAccountId',checked_context -> 'organizationAccountId',
    'identityId',checked_context -> 'identityId','sessionId',checked_context -> 'sessionId',
    'accessVersion',checked_context -> 'accessVersion','correlationId',checked_context -> 'correlationId',
    'applicationRootId',selected_app,'applicationReleaseRevision',selected_revision,
    'registeredApplication',registered_identity,'moduleBindings',bindings,
    'pinFacts',pin_facts,'pinFingerprint',pin_hash);
    if identity_value is distinct from before_identity then
      raise exception using errcode='40001', message='Active Application identity changed while waiting';
    end if;
  end loop;
  installation:=vortex_definition.read_active_installation_for_scope_internal(selected_org,selected_app);
  if (installation ->> 'applicationReleaseRevision')::bigint is distinct from selected_revision
    or exists(select 1 from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as current(value)
      where not exists(select 1 from pg_catalog.jsonb_array_elements(bindings) as expected(value)
        where current.value -> 'moduleRootId'=expected.value -> 'moduleRootId'
          and current.value -> 'moduleReleaseRevision'=expected.value -> 'moduleReleaseRevision'
          and current.value -> 'bindingRevision'=expected.value -> 'bindingRevision'
          and current.value ->> 'state'='active'))
    or pg_catalog.jsonb_array_length(installation -> 'moduleBindings')<>active_count then
    raise exception using errcode='40001', message='Active Application pin closure changed';
  end if;
  application_evidence:=vortex_definition.project_consumer_release('application',selected_app,selected_revision);
  release_identity:=pg_catalog.jsonb_build_object(
    'rootId',application_evidence -> 'rootId','definitionKey',application_evidence -> 'key',
    'releaseRevision',application_evidence -> 'releaseRevision','releaseVersion',application_evidence -> 'releaseVersion',
    'validationContractVersion',application_evidence -> 'validationContractVersion',
    'contentFingerprint',application_evidence -> 'contentFingerprint',
    'resolutionFingerprint',application_evidence -> 'resolutionFingerprint');
  if application_evidence ->> 'kind' is distinct from 'application'
    or (application_evidence ->> 'organizationId')::uuid is distinct from selected_org
    or release_identity is distinct from registered_identity then
    raise exception using errcode='23514', message='Active Application publication differs';
  end if;
  select pg_catalog.jsonb_agg(vortex_definition.project_consumer_release(
    'module',(pin.value ->> 'moduleRootId')::uuid,(pin.value ->> 'moduleReleaseRevision')::bigint)
    order by (pin.value ->> 'moduleRootId')::uuid)
  into module_evidence from pg_catalog.jsonb_array_elements(bindings) as pin(value);
  if pg_catalog.jsonb_array_length(module_evidence)<>active_count or exists(
    select 1 from pg_catalog.jsonb_array_elements(module_evidence) as module(value)
    where module.value ->> 'kind' is distinct from 'module'
      or (module.value ->> 'organizationId')::uuid is distinct from selected_org
      or not exists(select 1 from pg_catalog.jsonb_array_elements(pin_facts) as pin(value)
        where pin.value -> 'moduleRootId'=module.value -> 'rootId'
          and pin.value -> 'moduleReleaseRevision'=module.value -> 'releaseRevision'
          and pin.value -> 'contentFingerprint'=module.value -> 'contentFingerprint'
          and pin.value -> 'resolutionFingerprint'=module.value -> 'resolutionFingerprint')) then
    raise exception using errcode='23514', message='Active Module publication differs';
  end if;
  checked_context:=vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human'
    or not checked_context ? 'applicationRootId'
    or pg_catalog.clock_timestamp()>=(checked_context ->> 'expiresAt')::timestamptz
    or (checked_context ? 'delegatedContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{delegatedContext,expiresAt}')::timestamptz)
    or (checked_context ? 'supportContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{supportContext,expiresAt}')::timestamptz) then
    raise exception using errcode='42501', message='Active Application context is unavailable';
  end if;
  selected_org:=(checked_context ->> 'organizationId')::uuid;
  selected_app:=(checked_context ->> 'applicationRootId')::uuid;
  select pg_catalog.min(binding.application_release_revision),pg_catalog.count(*)::integer
  into selected_revision,active_count from vortex_definition.installation_bindings as binding
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if active_count not between 1 and 10000 or selected_revision is null or exists(
    select 1 from vortex_definition.installation_bindings as binding
    where binding.organization_id=selected_org and binding.application_root_id=selected_app
      and binding.state<>'detached'
      and (binding.state<>'active' or binding.application_release_revision<>selected_revision)) then
    raise exception using errcode='P0002', message='Active Application installation is unavailable';
  end if;
  select snapshot.* into strict registered_app
  from vortex_access.read_application_permission_snapshot(selected_org,selected_app) as snapshot;
  if registered_app.release_revision is distinct from selected_revision then
    raise exception using errcode='40001', message='Active Application registration changed';
  end if;
  registered_identity:=pg_catalog.jsonb_build_object(
    'rootId',selected_app,'definitionKey',registered_app.definition_key,
    'releaseRevision',selected_revision,'releaseVersion',registered_app.release_version,
    'validationContractVersion',registered_app.validation_contract_version,
    'contentFingerprint',registered_app.content_fingerprint,
    'resolutionFingerprint',registered_app.resolution_fingerprint);
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'bindingRevision',binding.binding_revision,'state',binding.state) order by binding.module_root_id),
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'contentFingerprint',module_release.content_fingerprint,
      'resolutionFingerprint',module_release.resolution_fingerprint) order by binding.module_root_id)
  into bindings,pin_facts from vortex_definition.installation_bindings as binding
  join vortex_definition.releases as module_release
    on module_release.root_id=binding.module_root_id
    and module_release.release_revision=binding.module_release_revision
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if exists(select 1 from pg_catalog.jsonb_array_elements(pin_facts) as pin(value)
    where (pin.value ->> 'contentFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or (pin.value ->> 'resolutionFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or pin.value ->> 'contentFingerprint' is null
      or pin.value ->> 'resolutionFingerprint' is null) then
    raise exception using errcode='55000', message='Active Application pins are unavailable';
  end if;
  pin_hash:='sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pin_facts::text,'UTF8')),'hex');
  identity_value:=pg_catalog.jsonb_build_object(
    'tenantId',checked_context -> 'tenantId','organizationId',selected_org,
    'organizationAccountId',checked_context -> 'organizationAccountId',
    'identityId',checked_context -> 'identityId','sessionId',checked_context -> 'sessionId',
    'accessVersion',checked_context -> 'accessVersion','correlationId',checked_context -> 'correlationId',
    'applicationRootId',selected_app,'applicationReleaseRevision',selected_revision,
    'registeredApplication',registered_identity,'moduleBindings',bindings,
    'pinFacts',pin_facts,'pinFingerprint',pin_hash);
  if identity_value is distinct from before_identity then
    raise exception using errcode='40001', message='Active Application mapping changed';
  end if;
  return pg_catalog.jsonb_build_object('identity',identity_value,'installation',installation,
    'application',application_evidence,'modules',module_evidence);
exception when no_data_found or too_many_rows then
  raise exception using errcode='P0002', message='Active Application mapping is unavailable';
end
$function$;
alter function vortex_definition.lock_active_installation_runtime_mapping_internal(jsonb) owner to vortex_owner;
revoke all on function vortex_definition.lock_active_installation_runtime_mapping_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.lock_active_installation_runtime_mapping_internal(jsonb) to vortex_owner, vortex_record_adapter;
comment on function vortex_definition.lock_active_installation_runtime_mapping_internal(jsonb) is 'Locks and proves exact active publication mapping under the current HUMAN request; expected identity is only a guard.';

-- read_application_bound_release_set.sql
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

  select vortex_definition.project_consumer_release(
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
    vortex_definition.project_consumer_release(
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

grant execute on function vortex_definition.read_application_bound_release_set(bigint) to vortex_owner;

comment on function vortex_definition.read_application_bound_release_set(bigint) is
  'Returns the exact local Application and complete exact Module dependency closure selected by validated human application context.';

alter function vortex_definition.read_application_bound_release_set(p_application_release_revision bigint) owner to vortex_owner;

grant execute on function vortex_definition.read_application_bound_release_set(p_application_release_revision bigint) to postgres;

-- read_application_draft_consistency.sql
create or replace function vortex_definition.read_application_draft_consistency(
  p_root_id uuid,
  p_expected_draft_revision bigint,
  p_expected_source_fingerprint text,
  p_expected_published_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  consistency jsonb;
begin
  checked_context := vortex_definition.validated_builder_read_context_internal();
  if p_root_id is null or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_expected_source_fingerprint is null then
    raise exception using errcode = '22023', message = 'Draft consistency requires a root, revision and source fingerprint';
  end if;
  if exists (select 1 from vortex_definition.roots as root
    where root.root_id = p_root_id
      and root.organization_id <> (checked_context ->> 'organizationId')::uuid
  ) then
    raise exception using errcode = '42501', message = 'Definition root does not belong to the context organization';
  end if;
  select pg_catalog.jsonb_build_object(
    'draftRevision', draft.draft_revision,
    'sourceFingerprint', draft.source_fingerprint,
    'publishedRevision', root.current_release_revision
  ) into consistency
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.root_id = p_root_id and root.kind = 'application'
    and root.organization_id = (checked_context ->> 'organizationId')::uuid
    and draft.draft_revision = p_expected_draft_revision
    and draft.source_fingerprint = p_expected_source_fingerprint
    and root.current_release_revision is not distinct from p_expected_published_revision;
  return consistency;
end
$function$;

revoke all on function vortex_definition.read_application_draft_consistency(uuid, bigint, text, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_application_draft_consistency(uuid, bigint, text, bigint) to vortex_request;
alter function vortex_definition.read_application_draft_consistency(uuid, bigint, text, bigint) owner to vortex_owner;

-- read_builder_application_root_key.sql
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
  checked_context := vortex_definition.validated_builder_read_context_internal();
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

alter function vortex_definition.read_builder_application_root_key(p_root_id uuid) owner to vortex_owner;

grant execute on function vortex_definition.read_builder_application_root_key(p_root_id uuid) to postgres;

-- read_first_install_application_release_set.sql
create or replace function vortex_definition.read_first_install_application_release_set(
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
  initial_context jsonb;
  permission_decision record;
  locked_access_version bigint;
  origin_kind text;
  application_evidence jsonb;
  module_evidence jsonb;
  pin_count bigint;
  completion_time timestamptz;
  permission_deadline timestamptz;
  pass integer;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'First installation release selector is invalid';
  end if;

  initial_context := vortex_access.validated_human_request_context();
  if initial_context is null
    or initial_context ->> 'callerKind' is distinct from 'human'
    or initial_context ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'First installation release authority is unavailable';
  end if;

  -- The normal HUMAN org request has acquired Access before this store read.
  -- Retain the same lock even for a direct protected request-role invocation.
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = (initial_context ->> 'organizationId')::uuid
  for share;
  if not found or locked_access_version
    is distinct from (initial_context ->> 'accessVersion')::bigint then
    raise exception using errcode = '42501',
      message = 'First installation release authority is unavailable';
  end if;
  permission_deadline := (initial_context ->> 'expiresAt')::timestamptz;

  for pass in 1..2 loop
    select evaluated.* into strict permission_decision
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', 'platform.organization.applications.manage',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform',
          'ownerId', vortex_access.platform_permission_owner_id(),
          'permissionId', vortex_access.platform_permission_id('platform.organization.applications.manage')
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    ) as evaluated;
    checked_context := vortex_access.validated_human_request_context();
    completion_time := pg_catalog.clock_timestamp();
    if checked_context is distinct from initial_context
      or permission_decision.outcome is distinct from 'eligible'
      or permission_decision.operation_key
        is distinct from 'platform.organization.applications.manage'
      or permission_decision.target_kind is distinct from 'organization'
      or permission_decision.target_application_root_id is not null
      or permission_decision.organization_id
        is distinct from (initial_context ->> 'organizationId')::uuid
      or permission_decision.organization_account_id
        is distinct from (initial_context ->> 'organizationAccountId')::uuid
      or permission_decision.access_version is distinct from locked_access_version
      or permission_decision.correlation_id
        is distinct from (initial_context ->> 'correlationId')::uuid
      or permission_decision.checked_at is null
      or not pg_catalog.isfinite(permission_decision.checked_at)
      or permission_decision.checked_at > completion_time
      or permission_decision.valid_until is null
      or not pg_catalog.isfinite(permission_decision.valid_until)
      or permission_decision.valid_until <= completion_time
      or permission_deadline is null
      or not pg_catalog.isfinite(permission_deadline)
      or permission_deadline <= completion_time
      or (initial_context ->> 'issuedAt')::timestamptz > completion_time then
      raise exception using errcode = '42501',
        message = 'First installation release authority is unavailable';
    end if;
    permission_deadline := least(permission_deadline, permission_decision.valid_until);

    if pass = 1 then
      select root.application_origin_kind into origin_kind
      from vortex_definition.roots as root
      where root.root_id = p_application_root_id
        and root.organization_id = (initial_context ->> 'organizationId')::uuid
        and root.kind = 'application'
      for share;
      if not found or origin_kind is distinct from 'ordinary' then
        raise exception using errcode = 'P0002',
          message = 'First installation release is unavailable';
      end if;

      application_evidence := vortex_definition.project_consumer_release(
        'application', p_application_root_id, p_application_release_revision
      );
      if application_evidence is null then
        raise exception using errcode = 'P0002',
          message = 'First installation release is unavailable';
      end if;

      -- One authoritative immutable closure; no caller pins or current/latest lookup.
      select pg_catalog.count(*), coalesce(pg_catalog.jsonb_agg(
        vortex_definition.project_consumer_release(
          'module', pin.target_root_id, pin.target_release_revision
        ) order by pin.target_root_id
      ), '[]'::jsonb)
      into pin_count, module_evidence
      from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as pin;
      if pin_count > 10000
        or exists (
          select 1 from pg_catalog.jsonb_array_elements(module_evidence) as entry(value)
          where entry.value is null or entry.value = 'null'::jsonb
            or entry.value ->> 'kind' is distinct from 'module'
            or (entry.value ->> 'organizationId')::uuid
              is distinct from (initial_context ->> 'organizationId')::uuid
        ) then
        raise exception using errcode = '23514',
          message = 'First installation release evidence is incomplete';
      end if;
    end if;
  end loop;

  if permission_deadline <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '42501',
      message = 'First installation release authority is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'correlationId', initial_context -> 'correlationId',
    'application', application_evidence,
    'modules', module_evidence
  );
end
$function$;

revoke all on function vortex_definition.read_first_install_application_release_set(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.read_first_install_application_release_set(uuid, bigint)
  to vortex_request;
comment on function vortex_definition.read_first_install_application_release_set(uuid, bigint) is
  'Returns the exact same-organization ordinary published Application and complete immutable Module pin closure to an org-only HUMAN who may manage application installations, before Application permission registration; grants no installation or mutation authority.';

alter function vortex_definition.read_first_install_application_release_set(p_application_root_id uuid, p_application_release_revision bigint) owner to vortex_owner;

-- read_module_release.sql
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
  checked_context := vortex_definition.validated_builder_read_context_internal();
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

-- read_module_release_page.sql
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
  checked_context := vortex_definition.validated_builder_read_context_internal();
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

-- read_owned_module_publication.sql
create or replace function vortex_definition.read_owned_module_publication(
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
  publication jsonb;
  invalid_field_key boolean;
begin
  checked_context := vortex_definition.validated_builder_read_context_internal();
  if p_application_root_id is null or not exists (
    select 1 from vortex_definition.roots as root
    where root.root_id = p_application_root_id and root.kind = 'application'
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
  ) then
    raise exception using errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;

  -- A broken current-release pointer is a storage defect, never an empty publication.
  if exists (
    select 1 from vortex_definition.roots as root
    left join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = root.current_release_revision
    where root.owner_application_root_id = p_application_root_id
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind = 'module' and root.current_release_revision is not null
      and (release.root_id is null
        or pg_catalog.jsonb_typeof(release.compilation_output #> '{canonical,content,recordTypes}') is distinct from 'array')
  ) then
    raise exception using errcode = '23514', message = 'Owned Module publication is inconsistent';
  end if;

  if exists (
    select 1 from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,recordTypes}'
    ) as record(value)
    where root.owner_application_root_id = p_application_root_id
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind = 'module'
      and (pg_catalog.jsonb_typeof(record.value -> 'key') is distinct from 'string'
        or pg_catalog.length(record.value ->> 'key') not between 1 and 40
        or (record.value ->> 'key') !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
        or pg_catalog.jsonb_typeof(record.value -> 'fields') is distinct from 'array')
  ) then
    raise exception using errcode = '23514', message = 'Owned Module publication record is inconsistent';
  end if;

  -- Storage remains published even when a later release removes it. Preview plans
  -- live on preview_installations, so only real publications contribute here.
  with records as materialized (
    select root.key as module_key, record.value as record, record.ordinality
    from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,recordTypes}'
    ) with ordinality as record(value, ordinality)
    where root.owner_application_root_id = p_application_root_id
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind = 'module'
  ), fields as materialized (
    select module_key, record ->> 'key' as record_key,
      records.ordinality as record_ordinality, field.value, field.ordinality
    from records cross join lateral pg_catalog.jsonb_array_elements(record -> 'fields')
      with ordinality as field(value, ordinality)
  )
  select pg_catalog.jsonb_build_object(
    'recordTypes', coalesce((select pg_catalog.jsonb_agg(qualified_key order by qualified_key collate "C")
      from (select distinct module_key || ':' || (record ->> 'key') as qualified_key from records) as names
    ), '[]'::jsonb),
    'fields', coalesce((select pg_catalog.jsonb_agg(qualified_key order by qualified_key collate "C")
      from (select distinct module_key || ':' || record_key || '.' || (value ->> 'key') as qualified_key from fields) as names
    ), '[]'::jsonb)
  ), exists (
    select 1 from fields
    where pg_catalog.jsonb_typeof(value -> 'key') is distinct from 'string'
      or pg_catalog.length(value ->> 'key') not between 1 and 40
      or (value ->> 'key') !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
  ) into publication, invalid_field_key;
  if invalid_field_key then
    raise exception using errcode = '23514', message = 'Owned Module publication field is inconsistent';
  end if;

  -- Only actual contribution targets count. A dependency on the owner alone is not a use.
  -- Include current published contributors and older releases still bound to an installation.
  with owned_points as (
    select distinct root.root_id, root.key as module_key,
      point.value ->> 'extensionPointId' as point_id, point.value ->> 'key' as point_key
    from vortex_definition.roots as root
    join vortex_definition.releases as release on release.root_id = root.root_id
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,extensionPoints}'
    ) as point(value)
    where root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.owner_application_root_id = p_application_root_id and root.kind = 'module'
  ), contributor_releases as (
    select root.root_id, root.current_release_revision as release_revision
    from vortex_definition.roots as root
    where root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind = 'module' and root.current_release_revision is not null
    union
    select binding.module_root_id, binding.module_release_revision
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = (checked_context ->> 'organizationId')::uuid
      and binding.state in ('provisioned', 'active')
  ), uses as (
    select distinct point.module_key, point.point_key,
      contribution.value ->> 'kind' as kind,
      release.compilation_output #>> '{canonical,content,name}' as contributor_name
    from contributor_releases as contributor
    join vortex_definition.releases as release
      on release.root_id = contributor.root_id and release.release_revision = contributor.release_revision
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,contributions}'
    ) as contribution(value)
    join owned_points as point
      on point.root_id::text = contribution.value #>> '{targetModule,moduleRootId}'
      and point.point_id = contribution.value ->> 'targetExtensionPointId'
  )
  select publication || pg_catalog.jsonb_build_object('extensionPointUses', coalesce(
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleKey', module_key, 'extensionPointKey', point_key,
      'kind', kind, 'contributorName', contributor_name
    ) order by module_key collate "C", point_key collate "C", contributor_name collate "C", kind collate "C"),
    '[]'::jsonb
  )) into publication from uses;
  return publication;
end
$function$;

revoke all on function vortex_definition.read_owned_module_publication(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_owned_module_publication(uuid) to vortex_request;
alter function vortex_definition.read_owned_module_publication(uuid) owner to vortex_owner;

-- read_owned_module_roots.sql
create or replace function vortex_definition.read_owned_module_roots(
  p_application_root_id uuid
)
returns table (
  root_id uuid,
  definition_key text,
  draft_revision bigint,
  current_release_revision bigint,
  source_fingerprint text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
begin
  checked_context := vortex_definition.validated_builder_read_context_internal();
  if p_application_root_id is null or not exists (
    select 1
    from vortex_definition.roots as owner_root
    where owner_root.root_id = p_application_root_id
      and owner_root.kind = 'application'
      and owner_root.organization_id = (checked_context ->> 'organizationId')::uuid
  ) then
    raise exception using errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;

  return query
  select root.root_id, root.key, draft.draft_revision, root.current_release_revision,
    draft.source_fingerprint
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.owner_application_root_id = p_application_root_id
    and root.organization_id = (checked_context ->> 'organizationId')::uuid
    and root.kind = 'module'
  order by root.key collate "C", root.root_id
  limit 200;
end
$function$;

revoke all on function vortex_definition.read_owned_module_roots(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_owned_module_roots(uuid) to vortex_request;

comment on function vortex_definition.read_owned_module_roots(uuid) is
  'Lists the internal Module roots one Application owns, with their draft and current release revisions, for its publication.';

alter function vortex_definition.read_owned_module_roots(uuid) owner to vortex_owner;

-- read_prepared_installation_runtime_source.sql
create or replace function vortex_definition.read_prepared_installation_runtime_source(
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
  mapping jsonb;
  prepared_record_plan jsonb;
  application_evidence jsonb;
  module_evidence jsonb;
begin
  mapping := vortex_definition.lock_prepared_installation_runtime_mapping_internal(
    p_application_root_id,
    p_application_release_revision,
    p_expected_module_bindings
  );
  select vortex_definition.project_consumer_release(
    'application', p_application_root_id, p_application_release_revision
  ) into application_evidence;
  if application_evidence is null
    or (application_evidence ->> 'organizationId')::uuid
      is distinct from (mapping ->> 'organizationId')::uuid then
    raise exception using errcode = 'P0002',
      message = 'Prepared Application source is unavailable';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
      vortex_definition.project_consumer_release(
        'module', (pin.value ->> 'moduleRootId')::uuid,
        (pin.value ->> 'moduleReleaseRevision')::bigint
      ) order by (pin.value ->> 'moduleRootId')::uuid
    ), '[]'::jsonb)
  into module_evidence
  from pg_catalog.jsonb_array_elements(mapping -> 'moduleBindings') as pin(value);

  prepared_record_plan := vortex_record.resolve_prepared_record_access_plan_internal(
    p_application_root_id,
    p_application_release_revision,
    mapping -> 'moduleBindings'
  );
  if prepared_record_plan is null
    or pg_catalog.jsonb_typeof(prepared_record_plan) is distinct from 'object'
    or not prepared_record_plan ?& array['planKey', 'mappingFingerprint', 'plan'] then
    raise exception using errcode = '55000',
      message = 'Prepared Record access plan is unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', mapping -> 'organizationId',
    'applicationRootId', mapping -> 'applicationRootId',
    'applicationReleaseRevision', mapping -> 'applicationReleaseRevision',
    'accessVersion', mapping -> 'accessVersion',
    'correlationId', mapping -> 'correlationId',
    'pinFingerprint', mapping -> 'pinFingerprint',
    'mappingFingerprint', prepared_record_plan -> 'mappingFingerprint',
    'moduleBindings', mapping -> 'moduleBindings',
    'application', application_evidence,
    'modules', module_evidence,
    'preparedRecordAccessPlan', prepared_record_plan
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Prepared runtime source evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Prepared runtime source evidence is ambiguous';
end
$function$;
alter function vortex_definition.read_prepared_installation_runtime_source(uuid,bigint,jsonb) owner to vortex_owner;


alter function vortex_definition.read_prepared_installation_runtime_source(uuid,bigint,jsonb)
  owner to vortex_owner;
revoke all on function vortex_definition.read_prepared_installation_runtime_source(uuid,bigint,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.read_prepared_installation_runtime_source(uuid,bigint,jsonb)
  to vortex_request;
comment on function vortex_definition.read_prepared_installation_runtime_source(uuid,bigint,jsonb) is
  'Reads exact immutable Application and complete Module source plus the current prepared Record plan inside the verified human installation transaction.';

-- read_publication_history_page.sql
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
  checked_context := vortex_definition.validated_builder_read_context_internal();
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
        and dependency.dependency_kind = 'module'), '[]'::jsonb)
      || coalesce((select pg_catalog.jsonb_agg(dependency.dependency_entry
        order by dependency.dependency_kind, dependency.dependency_reference)
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = release.root_id and dependency.release_revision = release.release_revision
        and dependency.dependency_kind in ('protected_operation', 'connection_type')), '[]'::jsonb),
      'releaseNote', release.release_note,
      'evidence', pg_catalog.jsonb_build_object('authoredSource',release.authored_source,
      'authoredSourceFingerprint',release.authored_source_fingerprint,
      'sourceContractVersion',release.source_contract_version,'compilationOutput',release.compilation_output,
      'resolutionSnapshot',release.resolution_snapshot,'resolutionFingerprint',release.resolution_fingerprint,
        'impactReasons',release.impact_reasons)
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

alter function vortex_definition.read_publication_history_page(p_root_id uuid, p_anchor_release_revision bigint, p_after_release_revision bigint, p_page_size integer) owner to vortex_owner;

grant execute on function vortex_definition.read_publication_history_page(p_root_id uuid, p_anchor_release_revision bigint, p_after_release_revision bigint, p_page_size integer) to postgres;

-- read_publication_state.sql
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
  history_latest_release_version text;
begin
  checked_context := vortex_definition.validated_builder_read_context_internal();
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
  select release.release_revision, release.release_version
  into history_latest_release_revision, history_latest_release_version
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
    'historyLatestReleaseVersion', history_latest_release_version,
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

alter function vortex_definition.read_publication_state(p_root_id uuid) owner to vortex_owner;

grant execute on function vortex_definition.read_publication_state(p_root_id uuid) to postgres;

-- read_saved_condition_history.sql
create or replace function vortex_definition.read_saved_condition_history(
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
  root_row vortex_definition.roots%rowtype;
begin
  checked_context := vortex_definition.validated_builder_read_context_internal();
  if p_root_id is null or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Saved condition history requires a non-nil root identifier';
  end if;
  select root.* into root_row from vortex_definition.roots as root where root.root_id = p_root_id;
  if not found then return null; end if;
  if root_row.organization_id <> (checked_context ->> 'organizationId')::uuid then
    raise exception using errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(last_seen.condition order by last_seen.condition_id)
    from (
      select distinct on (condition.value ->> 'conditionId')
        condition.value ->> 'conditionId' as condition_id,
        condition.value as condition
      from vortex_definition.releases as release
      cross join lateral pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(
            release.compilation_output -> 'canonical' -> 'content' -> 'sharingConditions'
          ) = 'array'
            then release.compilation_output -> 'canonical' -> 'content' -> 'sharingConditions'
          else '[]'::jsonb
        end
      ) as condition(value)
      where release.root_id = p_root_id
      order by condition.value ->> 'conditionId', release.release_revision desc
    ) as last_seen
  ), '[]'::jsonb);
end
$function$;

revoke execute on function vortex_definition.read_saved_condition_history(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_definition.read_saved_condition_history(uuid) to vortex_request;

comment on function vortex_definition.read_saved_condition_history(uuid) is
  'Returns, for each saved sharing condition ever published by one organisation-scoped Module root, its most recent published form, so the next release can assign condition revisions.';

alter function vortex_definition.read_saved_condition_history(p_root_id uuid) owner to vortex_owner;

grant execute on function vortex_definition.read_saved_condition_history(p_root_id uuid) to postgres;

-- read_source_identity_reservations.sql
create or replace function vortex_definition.read_source_identity_reservations(p_root_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  root_row vortex_definition.roots%rowtype;
begin
  checked_context := vortex_definition.validated_builder_read_context_internal();
  select root.* into root_row from vortex_definition.roots as root where root.root_id = p_root_id;
  if not found then
    raise exception using errcode = '23503', message = 'Definition root is missing';
  end if;
  if root_row.organization_id <> (checked_context ->> 'organizationId')::uuid then
    raise exception using errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'definitionKey', root.key, 'scope', alias.scope, 'kind', alias.kind,
      'componentOwner', alias.component_owner, 'alias', alias.alias
    ) order by root.key, alias.scope, alias.kind, alias.alias)
    from vortex_definition.roots as root
    join vortex_definition.source_identity_aliases as alias on alias.root_id = root.root_id
    where root.organization_id = root_row.organization_id
      and alias.scope = 'content' and alias.kind in ('role', 'permission')
      and (root.root_id = p_root_id or root.owner_application_root_id = p_root_id)
  ), '[]'::jsonb);
end
$function$;

alter function vortex_definition.read_source_identity_reservations(uuid) owner to vortex_owner;
revoke all on function vortex_definition.read_source_identity_reservations(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_source_identity_reservations(uuid) to vortex_request, postgres;

-- read_system_application_bound_release_set.sql
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

  select vortex_definition.project_consumer_release(
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
      vortex_definition.project_consumer_release(
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

alter function vortex_definition.read_system_application_bound_release_set(p_application_root_id uuid, p_application_release_revision bigint) owner to vortex_owner;

grant execute on function vortex_definition.read_system_application_bound_release_set(p_application_root_id uuid, p_application_release_revision bigint) to postgres;

reset role;
