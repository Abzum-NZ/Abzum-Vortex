-- Issue #1057 retires the first-owner composition and management-application requirement.
create or replace function vortex_access.protect_organization_stewardship_requirement()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Organization stewardship requirements cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization stewardship requirement revision is exhausted';
  end if;

  if new.organization_id <> old.organization_id
    or new.original_organization_account_id <>
      old.original_organization_account_id
    or new.original_role_id <> old.original_role_id
    or new.original_role_assignment_id <> old.original_role_assignment_id
    or new.original_delegation_authority_id <>
      old.original_delegation_authority_id
    or new.adopted_by <> old.adopted_by
    or new.adopted_at <> old.adopted_at
    or new.adoption_correlation_id <> old.adoption_correlation_id
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at
    or new.changed_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or new.changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or new.change_correlation_id =
      '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '23514',
      message = 'Organization stewardship requirement transition is invalid';
  end if;

  return new;
end
$function$;

revoke execute on function vortex_access.protect_organization_stewardship_requirement()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_access.protect_organization_stewardship_requirement() is
  'Protects immutable original stewardship evidence and requires each attributed change to advance its revision.';

create or replace function vortex_access.organization_has_permanent_steward(
  p_organization_id uuid,
  p_checked_at timestamptz
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  with current_platform_registration as (
    select registration.revision
    from vortex_access.permission_registrations as registration
    where registration.organization_id = p_organization_id
      and registration.registration_kind = 'platform'
      and registration.state = 'active'
      and vortex_access.platform_permission_catalogue_revision_is_exact(
        p_organization_id, registration.revision
      )
  ), original_permission(permission_id, meaning_fingerprint) as (
    values
      ('687d5649-62ee-43dd-b684-b8af3a5394c1'::uuid, 'sha256:be47b7066dd31f8797452f035cadcb18ef6ead6ff06bec6d3ec54ff769812567'::text),
      ('ca5f56d4-5382-4bf8-9a91-fbfdc77642b2'::uuid, 'sha256:87c065a43a5dc6676c3276aea10d4ad848665c07a39393dae237e72d6582367b'::text),
      ('87c96495-c806-4692-9bc2-250ddb10613c'::uuid, 'sha256:91eb8281f4905ef55dbe5acf537d49febeede8df37aeaf2ff69292107a59ae2b'::text),
      ('290ae49f-4cab-4159-9c20-6e664f07d50b'::uuid, 'sha256:cfb428fda5934cc18c54bc71bcbb4b6e7038714550587b189df0a3c0a3e44f8a'::text),
      ('6185dc64-464b-4776-97dc-c64a6f299550'::uuid, 'sha256:a44b20bb994a4519ca283fbd7cc933b7dbba7f7c6c4c0e036492cb84f432b22e'::text),
      ('9901c0dc-8bac-45c7-be0b-3642cb839bb1'::uuid, 'sha256:e46f5f2b4e9dcf77e6f96918828c7421044605b35216c5eecc0e29909c9a6848'::text),
      ('156d01f3-8f80-45fb-8fc8-b31c47dbb1df'::uuid, 'sha256:9c2cf2b688335a1c3edf32d397c7a9e611743736680e30c3672dfaf11c7a9f36'::text),
      ('02c772e5-2921-4300-ad90-4f5772a7fa46'::uuid, 'sha256:51234f517c9a62379cecc8ef047c3b5266096381dbc58e77d8a889fc3be32641'::text),
      ('630a980c-0ff5-40b1-a329-7326a2122395'::uuid, 'sha256:59439415b18b92167020f82086693b45cd238c9c4b8ac6fdd3ce071bc6d5b9e0'::text),
      ('9300e501-6d56-41b1-b203-3361dbace9bc'::uuid, 'sha256:b4462ee4471b7c93d820caef5690a31f7e7be4070e3ba8b7e83fe2e68b024cd8'::text),
      ('c2e03f58-debe-478e-b1e0-a4a8b8f1b9cb'::uuid, 'sha256:65b1804f9f5148adfb06d50ac16243b9711cab368b8c9950ff935e2e89a69154'::text),
      ('6dffcb0b-ded8-4cd5-acc8-c50f7d4269a5'::uuid, 'sha256:cba574ab17eff487cc68f32e8ce013eea83570060f17f73b02e91764f665120a'::text),
      ('c658c254-2884-414a-9012-512c0cfe4b34'::uuid, 'sha256:e79914b57f2c0b37bb07698bee58dc8557762020d3f082e19a4ceb8304b8e4f7'::text)
  ), required_platform_permission as (
    select entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id, entry.meaning_fingerprint,
      registration.revision as registration_revision
    from current_platform_registration as registration
    join vortex_access.permission_catalogue_entries as entry
      on entry.organization_id = p_organization_id
      and entry.registration_kind = 'platform'
      and entry.registration_revision = registration.revision
    join original_permission as original
      on original.permission_id = entry.permission_id
      and original.meaning_fingerprint = entry.meaning_fingerprint
    where entry.application_root_id is null
      and entry.owner_kind = 'platform'
      and entry.owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
  ), candidate_steward as (
    select account.organization_account_id
    from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as identity
      on identity.identity_id = account.identity_id
      and identity.state = 'active'
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = account.organization_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = account.organization_account_id
      and assignment.group_id is null
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= p_checked_at
      and assignment.expires_at is null
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id
      and role.role_id = assignment.role_id
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
      and revision.lifecycle = 'active'
      and revision.assignment_policy = 'standing'
    join vortex_access.organization_delegation_authorities as delegation
      on delegation.organization_id = account.organization_id
      and delegation.holder_kind = 'organization_account'
      and delegation.organization_account_id = account.organization_account_id
      and delegation.group_id is null
      and delegation.scope_kind = 'organization_catalogue'
      and delegation.state = 'live'
      and delegation.starts_at <= p_checked_at
      and delegation.expires_at is null
    where account.organization_id = p_organization_id
      and account.state = 'active'
      and not exists (
        select 1
        from required_platform_permission as required
        where not exists (
          select 1
          from vortex_access.organization_role_permission_entries as permission
          join vortex_access.permission_continuities as continuity
            on continuity.organization_id = permission.organization_id
            and continuity.application_root_id is not distinct from permission.application_root_id
            and continuity.owner_kind = permission.owner_kind
            and continuity.owner_id = permission.owner_id
            and continuity.permission_id = permission.permission_id
            and continuity.state = 'available'
            and continuity.continuity_revision = permission.continuity_revision
            and continuity.meaning_fingerprint = permission.meaning_fingerprint
            and continuity.last_processed_registration_revision =
              required.registration_revision
          where permission.organization_id = role.organization_id
            and permission.role_id = role.role_id
            and permission.role_revision = role.live_revision
            and permission.application_root_id is not distinct from required.application_root_id
            and permission.owner_kind = required.owner_kind
            and permission.owner_id = required.owner_id
            and permission.permission_id = required.permission_id
            and permission.meaning_fingerprint = required.meaning_fingerprint
        )
      )
  )
  select (select pg_catalog.count(*) from required_platform_permission) = 13
    and exists (
      select 1 from candidate_steward
    )
$function$;

revoke execute on function vortex_access.organization_has_permanent_steward(uuid, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_access.organization_has_permanent_steward(uuid, timestamptz) is
  'Checks the direct permanent steward and original platform-permission invariant for an adopted organisation.';

set local role vortex_module_owner;
create or replace function vortex_module.drain_installation(
  p_activity_id uuid,
  p_root_id uuid,
  p_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  initial_authority record;
  current_authority record;
  target_kind text;
  application_release vortex_definition.releases%rowtype;
  pin record;
  expected_count integer;
  pin_count integer;
  all_active boolean;
  all_draining boolean;
  changed_value boolean;
  binding_evidence jsonb;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_expected_module_bindings) = 0
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'object'
        or not item.value ?& array['moduleRootId', 'bindingRevision']
        or item.value - array['moduleRootId', 'bindingRevision'] <> '{}'::jsonb
        or (item.value ->> 'moduleRootId')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid
        or (item.value ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      group by (item.value ->> 'moduleRootId')::uuid
      having pg_catalog.count(*) <> 1
    )
    or p_expected_module_bindings is distinct from (
      select pg_catalog.jsonb_agg(item.value order by (item.value ->> 'moduleRootId')::uuid)
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
    ) then
    raise exception using errcode = '22023',
      message = 'Installation drain command is invalid';
  end if;

  select locked.* into strict initial_authority
  from vortex_access.lock_application_installation_authority() as locked;

  select root.kind into target_kind
  from vortex_definition.roots as root
  where root.root_id = p_root_id
    and root.organization_id = initial_authority.organization_id;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Installation is unavailable';
  end if;

  -- A Module is never installed on its own; its storage and records exist because an
  -- installed Application binds that exact release. Uninstalling a Module an installed
  -- Application still depends on is refused.
  if target_kind = 'module' then
    if exists (
      select 1 from vortex_module.installation_bindings as binding
      where binding.organization_id = initial_authority.organization_id
        and binding.module_root_id = p_root_id
        and binding.state in ('provisioned', 'active', 'draining')
    ) then
      raise exception using errcode = '42501',
        message = 'Installation is required by an installed application';
    end if;
    raise exception using errcode = 'P0002',
      message = 'Installation is unavailable';
  end if;

  select release.* into strict application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where root.root_id = p_root_id
    and root.organization_id = initial_authority.organization_id
    and root.kind = 'application'
    and release.release_revision = p_release_revision
    and release.validation_contract_version = any (vortex_definition.accepted_contract_version('application'))
    and release.compilation_output #>> '{kind}' = 'application'
    and release.compilation_output #>> '{canonical,envelope,rootId}' = p_root_id::text
    and release.compilation_output #>> '{validationContractVersion}' = any (vortex_definition.accepted_contract_version('application'));

  select pg_catalog.count(*)::integer into pin_count
  from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision);
  expected_count := pg_catalog.jsonb_array_length(p_expected_module_bindings);
  if pin_count = 0 or expected_count <> pin_count
    or exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
        where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
      )
    ) then
    raise exception using errcode = '23514',
      message = 'Installation binding set is incomplete';
  end if;

  for pin in
    select required.*
    from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
    order by required.target_root_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'vortex_module.binding:' || initial_authority.organization_id::text || ':' ||
          p_root_id::text || ':' || pin.target_root_id::text,
        0
      )
    );
    perform 1
    from vortex_module.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_root_id
      and binding.module_root_id = pin.target_root_id
    for update;
  end loop;

  select locked.* into strict current_authority
  from vortex_access.lock_application_installation_authority() as locked;
  if current_authority.organization_id <> initial_authority.organization_id
    or current_authority.organization_account_id <> initial_authority.organization_account_id
    or current_authority.access_version <> initial_authority.access_version
    or current_authority.correlation_id <> initial_authority.correlation_id then
    raise exception using errcode = '40001',
      message = 'Installation authority changed';
  end if;

  select pg_catalog.bool_and(coalesce(
      binding.state = 'active'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    )),
    pg_catalog.bool_and(coalesce(
      binding.state = 'draining'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    ))
  into all_active, all_draining
  from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
  left join vortex_module.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_root_id
    and binding.module_root_id = required.target_root_id
  left join lateral (
    select (expected.value ->> 'bindingRevision')::bigint as binding_revision
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
    where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
  ) as expected on true;
  if all_active is null or (not all_active and not all_draining)
    or exists (
      select 1 from vortex_module.installation_bindings as binding
      where binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_root_id
        and binding.state <> 'detached'
        and not exists (
          select 1
          from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
          where required.target_root_id = binding.module_root_id
        )
    ) then
    raise exception using errcode = '40001',
      message = 'Installation bindings changed or are incomplete';
  end if;

  changed_value := all_active;
  if changed_value then
    if exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
      join vortex_module.installation_bindings as binding
        on binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_root_id
        and binding.module_root_id = required.target_root_id
      where binding.binding_revision = 9007199254740991
    ) then
      raise exception using errcode = '22003',
        message = 'Installation binding revision is exhausted';
    end if;
    update vortex_module.installation_bindings as binding
    set state = 'draining', binding_revision = binding.binding_revision + 1,
      changed_at = pg_catalog.statement_timestamp()
    from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_root_id
      and binding.module_root_id = required.target_root_id
      and binding.state = 'active';
    if not found then
      raise exception using errcode = '40001',
        message = 'Installation bindings changed';
    end if;
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'organizationId', binding.organization_id,
    'applicationRootId', binding.application_root_id,
    'moduleRootId', binding.module_root_id,
    'bindingRevision', binding.binding_revision,
    'applicationReleaseRevision', binding.application_release_revision,
    'moduleReleaseRevision', binding.module_release_revision,
    'state', binding.state
  ) order by binding.module_root_id) into binding_evidence
  from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
  join vortex_module.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_root_id
    and binding.module_root_id = required.target_root_id;

  if changed_value then
    perform vortex_module.append_application_installation_activity_internal(
      p_activity_id, p_root_id, 'drain_application_installation'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', initial_authority.organization_id,
    'applicationRootId', p_root_id,
    'applicationReleaseRevision', p_release_revision,
    'state', 'draining', 'changed', changed_value,
    'moduleBindings', binding_evidence
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installation evidence is ambiguous';
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Installation drain command is invalid';
end
$function$;

revoke all on function vortex_module.drain_installation(uuid, uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.drain_installation(uuid, uuid, bigint, jsonb)
  to vortex_request;
comment on function vortex_module.drain_installation(uuid, uuid, bigint, jsonb) is
  'Protected first uninstall step: moves one exact active Application installation to draining, or refuses a Module an installed Application depends on, recording Activity from the trusted channel.';

reset role;

drop function vortex_access.compose_initial_operating_role_grant(jsonb);
drop function vortex_access.coordinate_organization_management_application_requirement(
  text, uuid, bigint, uuid, uuid, bigint, uuid, uuid
);
drop function vortex_access.application_is_stewardship_management_application(uuid, uuid);
drop table vortex_access.organization_initial_operating_role_grants;

alter table vortex_access.organization_stewardship_requirements
  drop constraint organization_stewardship_requirements_management_shape,
  drop constraint organization_stewardship_requirements_management_role_fk,
  drop constraint organization_stewardship_requirements_management_revision_fk;

alter table vortex_access.organization_stewardship_requirements
  drop column management_application_root_id,
  drop column management_role_id,
  drop column management_required_role_revision;