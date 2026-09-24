-- #962: register the security- and support-operator platform permissions as the
-- next exact platform catalogue revision (revision 5 / source version 1.3.0),
-- carrying forward every revision-4 identity, meaning and continuity unchanged.
--
-- The three permissions are `platform.security.identities.disable`,
-- `platform.support.access.request` and `platform.organization.support.approve`.
-- They are ordinary catalogue entries only: registering them makes them
-- available for role assignment in every organisation and grants nobody
-- authority. No role receives them automatically.
--
-- Revision 5 contains the 15 revision-4 entries plus these three additive
-- entries, so its catalogue fingerprint changes while the earlier catalogue
-- fingerprints, permission keys, action kinds, administrative flags and
-- meaning fingerprints stay byte-for-byte identical. Continuities carry
-- forward from revision 4 and three new continuities are recorded.
--
-- The live dispatcher `platform_permission_catalogue_revision_is_exact` and the
-- live `initialize_platform_permission_catalogue` are patched in place from
-- their current `pg_get_functiondef` with an exactly-once guard, so their OIDs,
-- grants, comments and callers are untouched and drift fails the migration.
-- The revision-5 catalogue fingerprint is the exact canonical fingerprint the
-- TypeScript catalogue computes for version 1.3.0, and the three new meaning
-- fingerprints are `fingerprintPermissionMeaning` of their declarations. The
-- revision-4 catalogue fingerprint and the connection permission's meaning
-- fingerprint were not derived that way, so the canonical functions do not
-- reproduce them. They stay opaque, immutable evidence: the connection entry's
-- stored meaning fingerprint is copied unchanged because its continuity and
-- every existing role grant are bound to it, and authority is evaluated by
-- permission identity, not by recomputing a platform meaning fingerprint.

begin;

set local role postgres;

-- Fixed evidence assertion for exact platform catalogue revision 5. It keeps
-- the revision-4 snapshot intact and proves the additive successor is exact.
create function vortex_access.platform_permission_catalogue_revision_is_exact_v1_3_0(
  p_organization_id uuid,
  p_registration_revision bigint
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  security_permission_id constant uuid := 'e85c2232-2ed7-4ce8-b1e5-7e2ad8e2b847';
  support_request_permission_id constant uuid := '014d2898-1969-4434-805c-eeb0f0e6f797';
  support_approve_permission_id constant uuid := '07e4653c-d358-489f-8067-46e085d99478';
  catalogue_fingerprint constant text :=
    'sha256:a434c97c26cd25dfce1e95b83f0dbfe5c5b6de739b35b2729d7f4306bc62285a';
  security_meaning_fingerprint constant text :=
    'sha256:d3b44fd282d1155370c5325aecc38590891afebf6172a29d1b3afcc8501ce745';
  support_request_meaning_fingerprint constant text :=
    'sha256:1cd6a404fef31df331259055de726ca6f176b58994e79946ceb069bac113ce4c';
  support_approve_meaning_fingerprint constant text :=
    'sha256:84b1f9b314ca426256aceec5c156dcc3e771a9d5612505ab77dbcfd89df9c659';
  security_description constant text :=
    'Disable an identity and revoke its active sessions through the identity owner''s protected operation without receiving general identity-administration or business-record authority.';
  support_request_description constant text :=
    'Request time-bounded support access to another organisation for a named operator and exact scope without receiving standing access to that organisation.';
  support_approve_description constant text :=
    'Approve or refuse a time-bounded support-access request for one''s own organisation without granting the requester standing authority.';
begin
  if p_registration_revision is distinct from 5 then
    return false;
  end if;

  return
    (select pg_catalog.count(*) = 1
     from vortex_access.permission_registrations as registration
     join vortex_access.permission_registration_revisions as history
       on history.organization_id = registration.organization_id
       and history.registration_kind = registration.registration_kind
       and history.registration_owner_id = registration.registration_owner_id
       and history.revision = registration.revision
     where registration.organization_id = p_organization_id
       and registration.registration_kind = 'platform'
       and registration.registration_owner_id = platform_owner_id
       and registration.state = 'active'
       and registration.revision = 5
       and registration.source_version = '1.3.0'
       and registration.permission_catalogue_fingerprint = catalogue_fingerprint
       and registration.candidate_fingerprint = catalogue_fingerprint
       and history.operation = 'platform_metadata_revision'
       and row(
         registration.state, registration.source_definition_key,
         registration.source_version, registration.source_revision,
         registration.validation_contract_version,
         registration.source_content_fingerprint,
         registration.source_resolution_fingerprint,
         registration.permission_catalogue_fingerprint,
         registration.candidate_fingerprint, registration.changed_at,
         registration.changed_by, registration.change_correlation_id
       ) is not distinct from row(
         history.state, history.source_definition_key,
         history.source_version, history.source_revision,
         history.validation_contract_version,
         history.source_content_fingerprint,
         history.source_resolution_fingerprint,
         history.permission_catalogue_fingerprint,
         history.candidate_fingerprint, history.changed_at,
         history.changed_by, history.change_correlation_id
       ))
    and (select pg_catalog.count(*) = 18
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 5)
    and (select pg_catalog.count(*) = 15
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 4)
    and not exists (
      select 1
      from vortex_access.permission_catalogue_entries as previous
      left join vortex_access.permission_catalogue_entries as current_entry
        on current_entry.organization_id = previous.organization_id
        and current_entry.registration_kind = previous.registration_kind
        and current_entry.registration_owner_id = previous.registration_owner_id
        and current_entry.registration_revision = 5
        and current_entry.owner_kind = previous.owner_kind
        and current_entry.owner_id = previous.owner_id
        and current_entry.permission_id = previous.permission_id
      where previous.organization_id = p_organization_id
        and previous.registration_kind = 'platform'
        and previous.registration_owner_id = platform_owner_id
        and previous.registration_revision = 4
        and (
          current_entry.permission_id is null
          or current_entry.source_version is distinct from '1.3.0'
          or current_entry.source_catalogue_fingerprint is distinct from
            catalogue_fingerprint
          or (pg_catalog.to_jsonb(current_entry)
                - 'registration_revision' - 'source_version'
                - 'source_catalogue_fingerprint')
             is distinct from
             (pg_catalog.to_jsonb(previous)
                - 'registration_revision' - 'source_version'
                - 'source_catalogue_fingerprint')
        )
    )
    and (select pg_catalog.count(*) = 1
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 5
           and entry.application_root_id is null
           and entry.owner_kind = 'platform'
           and entry.owner_id = platform_owner_id
           and entry.permission_id = security_permission_id
           and entry.permission_key = 'platform.security.identities.disable'
           and entry.label = 'Disable identities'
           and entry.description = security_description
           and entry.record_type_id is null
           and entry.record_scope is null
           and entry.field_policy is null
           and entry.action_kind = 'manage'
           and entry.named_action is null
           and entry.administrative
           and entry.source_kind = 'platform_catalogue'
           and entry.source_definition_key is null
           and entry.source_root_id is null
           and entry.source_version = '1.3.0'
           and entry.source_revision is null
           and entry.source_validation_contract_version is null
           and entry.source_content_fingerprint is null
           and entry.source_resolution_fingerprint is null
           and entry.source_catalogue_fingerprint = catalogue_fingerprint
           and entry.meaning_fingerprint = security_meaning_fingerprint)
    and (select pg_catalog.count(*) = 1
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 5
           and entry.application_root_id is null
           and entry.owner_kind = 'platform'
           and entry.owner_id = platform_owner_id
           and entry.permission_id = support_request_permission_id
           and entry.permission_key = 'platform.support.access.request'
           and entry.label = 'Request support access'
           and entry.description = support_request_description
           and entry.record_type_id is null
           and entry.record_scope is null
           and entry.field_policy is null
           and entry.action_kind = 'manage'
           and entry.named_action is null
           and entry.administrative
           and entry.source_kind = 'platform_catalogue'
           and entry.source_definition_key is null
           and entry.source_root_id is null
           and entry.source_version = '1.3.0'
           and entry.source_revision is null
           and entry.source_validation_contract_version is null
           and entry.source_content_fingerprint is null
           and entry.source_resolution_fingerprint is null
           and entry.source_catalogue_fingerprint = catalogue_fingerprint
           and entry.meaning_fingerprint = support_request_meaning_fingerprint)
    and (select pg_catalog.count(*) = 1
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 5
           and entry.application_root_id is null
           and entry.owner_kind = 'platform'
           and entry.owner_id = platform_owner_id
           and entry.permission_id = support_approve_permission_id
           and entry.permission_key = 'platform.organization.support.approve'
           and entry.label = 'Approve support access'
           and entry.description = support_approve_description
           and entry.record_type_id is null
           and entry.record_scope is null
           and entry.field_policy is null
           and entry.action_kind = 'manage'
           and entry.named_action is null
           and entry.administrative
           and entry.source_kind = 'platform_catalogue'
           and entry.source_definition_key is null
           and entry.source_root_id is null
           and entry.source_version = '1.3.0'
           and entry.source_revision is null
           and entry.source_validation_contract_version is null
           and entry.source_content_fingerprint is null
           and entry.source_resolution_fingerprint is null
           and entry.source_catalogue_fingerprint = catalogue_fingerprint
           and entry.meaning_fingerprint = support_approve_meaning_fingerprint)
    and (select pg_catalog.count(*) = 18
         from vortex_access.permission_continuities as continuity
         where continuity.organization_id = p_organization_id
           and continuity.application_root_id is null
           and continuity.registration_kind = 'platform'
           and continuity.registration_owner_id = platform_owner_id
           and continuity.state = 'available'
           and continuity.last_processed_registration_revision = 5)
    and not exists (
      select 1
      from vortex_access.permission_catalogue_entries as entry
      left join vortex_access.permission_continuities as continuity
        on continuity.organization_id = entry.organization_id
        and continuity.application_root_id is null
        and continuity.owner_kind = entry.owner_kind
        and continuity.owner_id = entry.owner_id
        and continuity.permission_id = entry.permission_id
        and continuity.registration_kind = entry.registration_kind
        and continuity.registration_owner_id = entry.registration_owner_id
        and continuity.state = 'available'
        and continuity.meaning_fingerprint = entry.meaning_fingerprint
        and continuity.last_processed_registration_revision = 5
      where entry.organization_id = p_organization_id
        and entry.registration_kind = 'platform'
        and entry.registration_owner_id = platform_owner_id
        and entry.registration_revision = 5
        and continuity.permission_id is null
    );
end
$function$;

-- Keep the current checker OID and its callers. Every older revision retains
-- its live body; revision 5 delegates to the additive exact checker.
do $patch_catalogue_checker$
declare
  definition text := pg_catalog.replace(
    pg_catalog.pg_get_functiondef(
      'vortex_access.platform_permission_catalogue_revision_is_exact(uuid,bigint)'::pg_catalog.regprocedure
    ), E'\r\n', E'\n'
  );
  old_text constant text := $old$begin
  if p_registration_revision = 4 then$old$;
  new_text constant text := $new$begin
  if p_registration_revision = 5 then
    return vortex_access.platform_permission_catalogue_revision_is_exact_v1_3_0(
      p_organization_id, p_registration_revision
    );
  end if;
  if p_registration_revision = 4 then$new$;
begin
  if definition is null
    or (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, old_text, '')))
      / pg_catalog.length(old_text) <> 1 then
    raise exception using errcode = '55000',
      message = 'Platform catalogue checker patch does not match exactly once';
  end if;
  execute pg_catalog.replace(definition, old_text, new_text);
end
$patch_catalogue_checker$;

-- Publish revision 5 without changing the meaning or continuity of the
-- revision-4 permissions. Unlike the connection revision, no existing role is
-- modified: the three operator permissions stay grantable through ordinary
-- role assignment and are never appended to a role automatically.
create function vortex_access.adopt_security_and_support_operator_permission_catalogue(
  p_organization_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  security_permission_id constant uuid := 'e85c2232-2ed7-4ce8-b1e5-7e2ad8e2b847';
  support_request_permission_id constant uuid := '014d2898-1969-4434-805c-eeb0f0e6f797';
  support_approve_permission_id constant uuid := '07e4653c-d358-489f-8067-46e085d99478';
  catalogue_fingerprint constant text :=
    'sha256:a434c97c26cd25dfce1e95b83f0dbfe5c5b6de739b35b2729d7f4306bc62285a';
  security_meaning_fingerprint constant text :=
    'sha256:d3b44fd282d1155370c5325aecc38590891afebf6172a29d1b3afcc8501ce745';
  support_request_meaning_fingerprint constant text :=
    'sha256:1cd6a404fef31df331259055de726ca6f176b58994e79946ceb069bac113ce4c';
  support_approve_meaning_fingerprint constant text :=
    'sha256:84b1f9b314ca426256aceec5c156dcc3e771a9d5612505ab77dbcfd89df9c659';
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_registration vortex_access.permission_registrations%rowtype;
  transition_count bigint;
  resulting_version bigint;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Operator permission catalogue adoption input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Operator permission catalogue scope is unavailable';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = platform_owner_id
  for update;
  if not found then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue is unavailable';
  end if;

  if current_registration.revision = 5 then
    if not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 5
    ) then
      raise exception using errcode = '55000',
        message = 'Operator permission catalogue evidence is invalid';
    end if;
    select version.current_version into strict resulting_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
    return resulting_version;
  end if;

  if current_registration.revision <> 4
    or not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 4
    ) then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue source evidence is invalid';
  end if;

  perform 1
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id
  order by continuity.owner_kind collate "C", continuity.owner_id,
    continuity.permission_id
  for update;

  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision,
    state, operation, source_definition_key, source_version,
    source_revision, validation_contract_version,
    source_content_fingerprint, source_resolution_fingerprint,
    permission_catalogue_fingerprint, candidate_fingerprint,
    changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'platform', platform_owner_id, 5,
    'active', 'platform_metadata_revision', null, '1.3.0',
    null, null, null, null, catalogue_fingerprint, catalogue_fingerprint,
    operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id,
    registration_revision, application_root_id, owner_kind, owner_id,
    permission_id, permission_key, label, description, record_type_id,
    action_kind, named_action, administrative, source_kind,
    source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint,
    meaning_fingerprint, record_scope, field_policy
  )
  select entry.organization_id, entry.registration_kind,
    entry.registration_owner_id, 5, entry.application_root_id,
    entry.owner_kind, entry.owner_id, entry.permission_id,
    entry.permission_key, entry.label, entry.description,
    entry.record_type_id, entry.action_kind, entry.named_action,
    entry.administrative, entry.source_kind, entry.source_definition_key,
    entry.source_root_id, '1.3.0', entry.source_revision,
    entry.source_validation_contract_version,
    entry.source_content_fingerprint, entry.source_resolution_fingerprint,
    catalogue_fingerprint, entry.meaning_fingerprint,
    entry.record_scope, entry.field_policy
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'platform'
    and entry.registration_owner_id = platform_owner_id
    and entry.registration_revision = 4;
  get diagnostics transition_count = row_count;
  if transition_count <> 15 then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue copy is incomplete';
  end if;

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id,
    registration_revision, application_root_id, owner_kind, owner_id,
    permission_id, permission_key, label, description, record_type_id,
    action_kind, named_action, administrative, source_kind,
    source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint,
    meaning_fingerprint
  ) values
    (
      p_organization_id, 'platform', platform_owner_id, 5, null,
      'platform', platform_owner_id, security_permission_id,
      'platform.security.identities.disable', 'Disable identities',
      'Disable an identity and revoke its active sessions through the identity owner''s protected operation without receiving general identity-administration or business-record authority.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.3.0', null, null, null, null, catalogue_fingerprint,
      security_meaning_fingerprint
    ),
    (
      p_organization_id, 'platform', platform_owner_id, 5, null,
      'platform', platform_owner_id, support_request_permission_id,
      'platform.support.access.request', 'Request support access',
      'Request time-bounded support access to another organisation for a named operator and exact scope without receiving standing access to that organisation.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.3.0', null, null, null, null, catalogue_fingerprint,
      support_request_meaning_fingerprint
    ),
    (
      p_organization_id, 'platform', platform_owner_id, 5, null,
      'platform', platform_owner_id, support_approve_permission_id,
      'platform.organization.support.approve', 'Approve support access',
      'Approve or refuse a time-bounded support-access request for one''s own organisation without granting the requester standing authority.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.3.0', null, null, null, null, catalogue_fingerprint,
      support_approve_meaning_fingerprint
    );

  update vortex_access.permission_continuities as continuity
  set last_processed_registration_revision = 5,
      changed_at = operation_at
  where continuity.organization_id = p_organization_id
    and continuity.application_root_id is null
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id
    and continuity.state = 'available'
    and continuity.last_processed_registration_revision = 4;
  get diagnostics transition_count = row_count;
  if transition_count <> 15 then
    raise exception using errcode = '55000',
      message = 'Platform permission continuity transition is incomplete';
  end if;

  insert into vortex_access.permission_continuities (
    organization_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id, state,
    continuity_revision, meaning_fingerprint,
    last_processed_registration_revision, changed_at
  ) values
    (
      p_organization_id, null, 'platform', platform_owner_id,
      security_permission_id, 'platform', platform_owner_id,
      'available', 1, security_meaning_fingerprint, 5, operation_at
    ),
    (
      p_organization_id, null, 'platform', platform_owner_id,
      support_request_permission_id, 'platform', platform_owner_id,
      'available', 1, support_request_meaning_fingerprint, 5, operation_at
    ),
    (
      p_organization_id, null, 'platform', platform_owner_id,
      support_approve_permission_id, 'platform', platform_owner_id,
      'available', 1, support_approve_meaning_fingerprint, 5, operation_at
    );

  update vortex_access.permission_registrations as registration
  set revision = 5,
      source_version = '1.3.0',
      permission_catalogue_fingerprint = catalogue_fingerprint,
      candidate_fingerprint = catalogue_fingerprint,
      changed_at = operation_at,
      changed_by = p_changed_by,
      change_correlation_id = p_correlation_id
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = platform_owner_id
    and registration.revision = 4;
  if not found then
    raise exception using errcode = '40001',
      message = 'Platform permission catalogue changed concurrently';
  end if;

  if not vortex_access.platform_permission_catalogue_revision_is_exact(
    p_organization_id, 5
  ) then
    raise exception using errcode = '55000',
      message = 'Operator permission catalogue evidence is incomplete';
  end if;

  if exists (
    select 1 from vortex_access.organization_roles as role
    where role.organization_id = p_organization_id
  ) then
    perform vortex_access.assert_organization_has_permanent_steward(
      p_organization_id
    );
  end if;

  select incremented.current_version into strict resulting_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id,
    'application_access_changed'
  ) as incremented;
  return resulting_version;
end
$function$;

-- Provisioning calls this entry point for every new organisation. Advance
-- through the actual immutable catalogue history before publishing revision 5,
-- so future stewards adopt the operator permissions with the platform set.
create function vortex_access.initialize_platform_permission_catalogue_v1_3_0(
  p_organization_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  organization_id uuid,
  registration_revision bigint,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  current_revision bigint;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Platform permission registration input is invalid';
  end if;

  select registration.revision into current_revision
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id =
      'cabe121e-0baf-4084-9471-cce915d460a8'::uuid;

  if not found then
    raise exception using errcode = '55000',
      message = 'Platform permission registration evidence is invalid';
  end if;

  if current_revision = 1 then
    perform 1
    from vortex_access.revise_platform_permission_catalogue_metadata(
      p_organization_id, 1, '1.0.0', '1.0.1',
      p_changed_by, p_correlation_id
    );
    current_revision := 2;
  end if;

  if current_revision = 2 then
    perform 1
    from vortex_access.adopt_shipped_platform_permission_catalogue(
      p_organization_id, 2, '1.1.0',
      'sha256:57453282c9a853912b2b67baeefaca81e21d076761d200ac812a7573d7dc7c9c',
      p_changed_by, p_correlation_id
    );
    current_revision := 3;
  end if;

  if current_revision = 3 then
    perform vortex_access.adopt_connection_administration_permission_catalogue(
      p_organization_id, p_changed_by, p_correlation_id
    );
    current_revision := 4;
  end if;

  if current_revision = 4 then
    perform vortex_access.adopt_security_and_support_operator_permission_catalogue(
      p_organization_id, p_changed_by, p_correlation_id
    );
    current_revision := 5;
  end if;

  if current_revision is distinct from 5
    or not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 5
    ) then
    raise exception using errcode = '55000',
      message = 'Platform permission registration evidence is invalid';
  end if;

  return query
  select p_organization_id, 5::bigint, version.current_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id;
end
$function$;

-- Keep the provisioning function's identity and existing caller dependencies.
-- Its original first-publication path still creates revision 1 before the
-- steward exists. Once a registration exists, advance it to revision 5.
do $patch_platform_initializer$
declare
  definition text := pg_catalog.replace(
    pg_catalog.pg_get_functiondef(
      'vortex_access.initialize_platform_permission_catalogue(uuid,uuid,uuid)'::pg_catalog.regprocedure
    ), E'\r\n', E'\n'
  );
  old_text constant text :=
    'vortex_access.initialize_platform_permission_catalogue_v1_2_0(';
  new_text constant text :=
    'vortex_access.initialize_platform_permission_catalogue_v1_3_0(';
begin
  if definition is null
    or (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, old_text, '')))
      / pg_catalog.length(old_text) <> 1 then
    raise exception using errcode = '55000',
      message = 'Platform catalogue initializer patch does not match exactly once';
  end if;
  execute pg_catalog.replace(definition, old_text, new_text);
end
$patch_platform_initializer$;

revoke all on function
  vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint),
  vortex_access.platform_permission_catalogue_revision_is_exact_v1_3_0(uuid, bigint),
  vortex_access.adopt_security_and_support_operator_permission_catalogue(uuid, uuid, uuid),
  vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid),
  vortex_access.initialize_platform_permission_catalogue_v1_3_0(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

-- A migration is the publisher of this additive platform catalogue revision.
-- Keep one correlation across its per-organisation upgrades. Inactive
-- organisations advance through the same initializer when reactivated.
do $backfill$
declare
  target record;
begin
  for target in
    select registration.organization_id
    from vortex_access.permission_registrations as registration
    join vortex_identity.organizations as organization
      on organization.organization_id = registration.organization_id
      and organization.state = 'active'
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
      and tenant.state = 'active'
    where registration.registration_kind = 'platform'
      and registration.registration_owner_id =
        'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
    order by registration.organization_id
  loop
    perform 1
    from vortex_access.initialize_platform_permission_catalogue(
      target.organization_id,
      'cabe121e-0baf-4084-9471-cce915d460a8'::uuid,
      '96200000-0000-4000-8000-000000000962'::uuid
    );
  end loop;
end
$backfill$;

reset role;

commit;
