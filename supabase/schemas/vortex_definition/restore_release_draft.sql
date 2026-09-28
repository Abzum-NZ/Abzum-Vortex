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
