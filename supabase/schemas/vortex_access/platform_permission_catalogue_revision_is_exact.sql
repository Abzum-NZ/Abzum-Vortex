create or replace function vortex_access.platform_permission_catalogue_revision_is_exact(
  p_organization_id uuid,
  p_registration_revision bigint
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  with expected as materialized (
    select declaration.*
    from vortex_access.read_platform_permission_declaration_catalogue_internal(6)
      as declaration
  ),
  entries as materialized (
    select entry.*
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = p_organization_id
      and entry.registration_kind = 'platform'
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      and entry.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
      and entry.registration_revision = 6
  )
  select coalesce(
    p_organization_id is not null
    and p_organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and p_registration_revision = 6
    and (select pg_catalog.count(*) from expected) = 23
    and (select pg_catalog.count(*) from entries) = 23
    and exists (
      select 1
      from vortex_access.permission_registrations as registration
      join vortex_access.permission_registration_revisions as history
        on history.organization_id = registration.organization_id
        and history.registration_kind = registration.registration_kind
        and history.registration_owner_id = registration.registration_owner_id
        and history.revision = registration.revision
      where registration.organization_id = p_organization_id
        and registration.registration_kind = 'platform'
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        and registration.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
        and registration.state = 'active'
        and registration.revision = 6
        and registration.source_definition_key is null
        and registration.source_version = '1.4.0'
        and registration.source_revision is null
        and registration.validation_contract_version is null
        and registration.permission_catalogue_fingerprint =
          'sha256:60d2c42cab03723fda56198083a70e8703792587546379372334d99609b15538'
        and registration.candidate_fingerprint = registration.permission_catalogue_fingerprint
        and registration.changed_by is not null
        and registration.change_correlation_id is not null
        and history.operation = 'platform_initialize'
        and row(history.state, history.source_definition_key, history.source_version,
          history.source_revision, history.validation_contract_version,
          history.permission_catalogue_fingerprint, history.candidate_fingerprint,
          history.changed_at, history.changed_by, history.change_correlation_id)
          is not distinct from row(registration.state, registration.source_definition_key,
          registration.source_version, registration.source_revision,
          registration.validation_contract_version,
          registration.permission_catalogue_fingerprint, registration.candidate_fingerprint,
          registration.changed_at, registration.changed_by, registration.change_correlation_id)
    )
    and not exists (
      select 1
      from vortex_access.permission_registration_revisions as history
      where history.organization_id = p_organization_id
        and history.registration_kind = 'platform'
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        and history.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
        and history.revision <> 6
    )
    and not exists (
      select entry.application_root_id, entry.owner_kind, entry.owner_id,
        entry.permission_id, entry.permission_key, entry.label, entry.description,
        entry.record_type_id, entry.record_scope, entry.field_policy,
        entry.action_kind, entry.named_action, entry.administrative,
        entry.source_kind, entry.source_definition_key, entry.source_root_id,
        entry.source_version, entry.source_revision,
        entry.source_validation_contract_version, entry.source_catalogue_fingerprint,
        entry.meaning_fingerprint
      from entries as entry
      except all
      select null::uuid, 'platform'::text,
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'cabe121e-0baf-4084-9471-cce915d460a8'::uuid,
        expected.permission_id, expected.permission_key, expected.label,
        expected.description, null::uuid, null::jsonb, null::jsonb,
        expected.action_kind, null::text, true, 'platform_catalogue'::text,
        null::text, null::uuid, expected.source_version, null::bigint,
        null::text, expected.catalogue_fingerprint, expected.meaning_fingerprint
      from expected
    )
    and (select pg_catalog.count(*) from vortex_access.permission_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.registration_kind = 'platform'
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        and continuity.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid) = 23
    and not exists (
      select 1 from expected
      where not exists (
        select 1 from vortex_access.permission_continuities as continuity
        where continuity.organization_id = p_organization_id
          and continuity.application_root_id is null
          and continuity.registration_kind = 'platform'
          -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
          and continuity.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
          and continuity.owner_kind = 'platform'
          and continuity.owner_id = continuity.registration_owner_id
          and continuity.permission_id = expected.permission_id
          and continuity.meaning_fingerprint = expected.meaning_fingerprint
          and continuity.state = 'available'
          and continuity.continuity_revision > 0
          and continuity.last_processed_registration_revision = 6
      )
    ), false
  )
$function$;

revoke all on function
  vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint) is
  'Owner-only assertion for the current platform catalogue registration, entries and continuities.';

alter function vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint)
  owner to vortex_owner;

grant execute on function vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint)
  to postgres;
