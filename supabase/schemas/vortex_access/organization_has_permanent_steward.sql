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
