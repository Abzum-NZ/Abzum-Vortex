CREATE FUNCTION vortex_access.application_permission_registration_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_candidate jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  release_value jsonb;
  actual_entries jsonb;
  actual_application_permission_ids jsonb;
  registration_exact boolean;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_registration_revision is null
    or p_registration_revision not between 1 and 9007199254740991
    or p_candidate is null
    or pg_catalog.jsonb_typeof(p_candidate) is distinct from 'object'
    or p_candidate - array[
      'contractVersion', 'organizationId', 'applicationRootId', 'applicationRelease',
      'applicationCatalogueFingerprint', 'applicationPermissionIds', 'entries',
      'candidateFingerprint'
    ]::text[] <> '{}'::jsonb
    or not (p_candidate ?& array[
      'contractVersion', 'organizationId', 'applicationRootId', 'applicationRelease',
      'applicationCatalogueFingerprint', 'applicationPermissionIds', 'entries',
      'candidateFingerprint'
    ])
    or p_candidate ->> 'contractVersion' is distinct from '1.0.0'
    or (p_candidate ->> 'organizationId')::uuid is distinct from p_organization_id
    or (p_candidate ->> 'applicationRootId')::uuid is distinct from p_application_root_id
    or pg_catalog.jsonb_typeof(p_candidate -> 'applicationRelease') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_candidate -> 'applicationPermissionIds') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_candidate -> 'entries') is distinct from 'array' then
    return false;
  end if;

  release_value := p_candidate -> 'applicationRelease';

  select pg_catalog.count(*) = 1 into registration_exact
  from vortex_access.permission_registrations as registration
  join vortex_access.permission_registration_revisions as history
    on history.organization_id = registration.organization_id
    and history.registration_kind = registration.registration_kind
    and history.registration_owner_id = registration.registration_owner_id
    and history.revision = registration.revision
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id
    and registration.state = 'active'
    and registration.revision = p_registration_revision
    and registration.source_definition_key = release_value ->> 'definitionKey'
    and registration.source_version = release_value ->> 'releaseVersion'
    and registration.source_revision = (release_value ->> 'releaseRevision')::bigint
    and registration.validation_contract_version =
      release_value ->> 'validationContractVersion'
    and registration.source_content_fingerprint = release_value ->> 'contentFingerprint'
    and registration.source_resolution_fingerprint = release_value ->> 'resolutionFingerprint'
    and registration.permission_catalogue_fingerprint =
      p_candidate ->> 'applicationCatalogueFingerprint'
    and registration.candidate_fingerprint = p_candidate ->> 'candidateFingerprint'
    and history.operation in ('register', 'update', 'reactivate')
    and row(
      registration.state, registration.source_definition_key, registration.source_version,
      registration.source_revision, registration.validation_contract_version,
      registration.source_content_fingerprint, registration.source_resolution_fingerprint,
      registration.permission_catalogue_fingerprint, registration.candidate_fingerprint,
      registration.changed_at, registration.changed_by, registration.change_correlation_id
    ) is not distinct from row(
      history.state, history.source_definition_key, history.source_version,
      history.source_revision, history.validation_contract_version,
      history.source_content_fingerprint, history.source_resolution_fingerprint,
      history.permission_catalogue_fingerprint, history.candidate_fingerprint,
      history.changed_at, history.changed_by, history.change_correlation_id
    );

  if not registration_exact then
    return false;
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'applicationRootId', entry.application_root_id,
        'ownerKind', entry.owner_kind,
        'ownerId', entry.owner_id,
        'permission', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'permissionId', entry.permission_id,
          'key', entry.permission_key,
          'label', entry.label,
          'description', entry.description,
          'recordTypeId', entry.record_type_id,
          'recordScope', entry.record_scope,
          'fieldPolicy', entry.field_policy,
          'actionKind', entry.action_kind,
          'namedAction', entry.named_action,
          'administrative', entry.administrative
        )),
        'sourceRelease', pg_catalog.jsonb_build_object(
          'kind', entry.source_kind,
          'definitionKey', entry.source_definition_key,
          'rootId', entry.source_root_id,
          'releaseRevision', entry.source_revision,
          'releaseVersion', entry.source_version,
          'validationContractVersion', entry.source_validation_contract_version,
          'contentFingerprint', entry.source_content_fingerprint,
          'resolutionFingerprint', entry.source_resolution_fingerprint
        ),
        'meaningFingerprint', entry.meaning_fingerprint
      ) order by
        entry.owner_kind collate "C", entry.owner_id,
        entry.permission_key collate "C", entry.permission_id
    ),
    '[]'::jsonb
  ) into actual_entries
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = p_application_root_id
    and entry.registration_revision = p_registration_revision;

  select coalesce(
    pg_catalog.jsonb_agg(entry.permission_id order by
      entry.permission_key collate "C", entry.permission_id),
    '[]'::jsonb
  ) into actual_application_permission_ids
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = p_application_root_id
    and entry.registration_revision = p_registration_revision
    and entry.owner_kind = 'application'
    and not entry.administrative;

  return actual_entries = p_candidate -> 'entries'
    and actual_application_permission_ids = p_candidate -> 'applicationPermissionIds';
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end
$$;


ALTER FUNCTION vortex_access.application_permission_registration_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_candidate jsonb) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.application_permission_registration_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_candidate jsonb) FROM PUBLIC;
