create or replace function vortex_access.platform_permission_catalogue_revision_is_exact(
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
  catalogue_fingerprint constant text :=
    'sha256:57453282c9a853912b2b67baeefaca81e21d076761d200ac812a7573d7dc7c9c';
  catalogue_entries constant jsonb := $catalogue$[
    {"permissionId":"687d5649-62ee-43dd-b684-b8af3a5394c1","key":"platform.organization.permissions.read","label":"View available permissions","description":"View the selected organisation's registered permission catalogue without receiving use or assignment authority.","actionKind":"read","meaningFingerprint":"sha256:be47b7066dd31f8797452f035cadcb18ef6ead6ff06bec6d3ec54ff769812567"},
    {"permissionId":"ca5f56d4-5382-4bf8-9a91-fbfdc77642b2","key":"platform.organization.roles.read","label":"View roles","description":"View the selected organisation's live roles and registered application role templates.","actionKind":"read","meaningFingerprint":"sha256:87c065a43a5dc6676c3276aea10d4ad848665c07a39393dae237e72d6582367b"},
    {"permissionId":"87c96495-c806-4692-9bc2-250ddb10613c","key":"platform.organization.roles.manage","label":"Manage roles","description":"Create, change or retire roles only within the actor's explicit delegated scope.","actionKind":"manage","meaningFingerprint":"sha256:91eb8281f4905ef55dbe5acf537d49febeede8df37aeaf2ff69292107a59ae2b"},
    {"permissionId":"290ae49f-4cab-4159-9c20-6e664f07d50b","key":"platform.organization.groups.read","label":"View groups","description":"View the selected organisation's Groups and membership administration data.","actionKind":"read","meaningFingerprint":"sha256:cfb428fda5934cc18c54bc71bcbb4b6e7038714550587b189df0a3c0a3e44f8a"},
    {"permissionId":"6185dc64-464b-4776-97dc-c64a6f299550","key":"platform.organization.groups.manage","label":"Manage groups","description":"Manage Groups and memberships subject to delegated scope and permanent-steward safeguards.","actionKind":"manage","meaningFingerprint":"sha256:a44b20bb994a4519ca283fbd7cc933b7dbba7f7c6c4c0e036492cb84f432b22e"},
    {"permissionId":"9901c0dc-8bac-45c7-be0b-3642cb839bb1","key":"platform.organization.assignments.read","label":"View access assignments","description":"View the selected organisation's role and delegation assignments and their effective scope.","actionKind":"read","meaningFingerprint":"sha256:e46f5f2b4e9dcf77e6f96918828c7421044605b35216c5eecc0e29909c9a6848"},
    {"permissionId":"156d01f3-8f80-45fb-8fc8-b31c47dbb1df","key":"platform.organization.assignments.manage","label":"Manage access assignments","description":"Grant, change or revoke use and delegation assignments only within the actor's explicit delegated scope.","actionKind":"manage","meaningFingerprint":"sha256:9c2cf2b688335a1c3edf32d397c7a9e611743736680e30c3672dfaf11c7a9f36"},
    {"permissionId":"02c772e5-2921-4300-ad90-4f5772a7fa46","key":"platform.organization.accounts.read","label":"View organisation accounts","description":"View the selected organisation's safe account-administration information.","actionKind":"read","meaningFingerprint":"sha256:51234f517c9a62379cecc8ef047c3b5266096381dbc58e77d8a889fc3be32641"},
    {"permissionId":"630a980c-0ff5-40b1-a329-7326a2122395","key":"platform.organization.accounts.manage","label":"Manage organisation accounts","description":"Change organisation-account lifecycle through the protected operation without changing global identity or removing the final permanent steward.","actionKind":"manage","meaningFingerprint":"sha256:59439415b18b92167020f82086693b45cd238c9c4b8ac6fdd3ce071bc6d5b9e0"},
    {"permissionId":"9300e501-6d56-41b1-b203-3361dbace9bc","key":"platform.organization.invitations.read","label":"View invitations","description":"View safe invitation administration metadata without the raw invitation secret or its stored fingerprint.","actionKind":"read","meaningFingerprint":"sha256:b4462ee4471b7c93d820caef5690a31f7e7be4070e3ba8b7e83fe2e68b024cd8"},
    {"permissionId":"c2e03f58-debe-478e-b1e0-a4a8b8f1b9cb","key":"platform.organization.invitations.manage","label":"Manage invitations","description":"Create or revoke invitations through the protected operation; role assignment additionally requires the actor's assignment authority.","actionKind":"manage","meaningFingerprint":"sha256:65b1804f9f5148adfb06d50ac16243b9711cab368b8c9950ff935e2e89a69154"},
    {"permissionId":"6dffcb0b-ded8-4cd5-acc8-c50f7d4269a5","key":"platform.organization.runtime_settings.read","label":"View organisation display settings","description":"View the organisation's default language, time zone, currency, date and number display settings.","actionKind":"read","meaningFingerprint":"sha256:cba574ab17eff487cc68f32e8ce013eea83570060f17f73b02e91764f665120a"},
    {"permissionId":"c658c254-2884-414a-9012-512c0cfe4b34","key":"platform.organization.runtime_settings.manage","label":"Manage organisation display settings","description":"Change the organisation's validated default display settings through the protected revision-checked operation.","actionKind":"manage","meaningFingerprint":"sha256:e79914b57f2c0b37bb07698bee58dc8557762020d3f082e19a4ceb8304b8e4f7"},
    {"permissionId":"7ecd3304-f16c-47d4-94db-0964980091ba","key":"platform.organization.applications.manage","label":"Manage applications","description":"Install, upgrade or detach exact application bindings in the selected organisation without receiving business-record use or role-assignment authority.","actionKind":"manage","meaningFingerprint":"sha256:f3c8f4195e1d61f27a1cc65b82f6aa46ac45629195f3a8ea125925c7f12f3f81"}
  ]$catalogue$::jsonb;
  registration_exact boolean;
begin
  if p_registration_revision = 6 then
    return vortex_access.platform_permission_catalogue_revision_is_exact_v1_4_0(
      p_organization_id, p_registration_revision
    );
  end if;
  if p_registration_revision = 5 then
    return vortex_access.platform_permission_catalogue_revision_is_exact_v1_3_0(
      p_organization_id, p_registration_revision
    );
  end if;
  if p_registration_revision = 4 then
    return vortex_access.platform_permission_catalogue_revision_is_exact_v1_2_0(
      p_organization_id, p_registration_revision
    );
  end if;
  if p_registration_revision in (1, 2) then
    return vortex_access.platform_permission_catalogue_revision_is_exact_v1_0_1(
      p_organization_id, p_registration_revision
    );
  end if;
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_registration_revision is distinct from 3 then
    return false;
  end if;

  select pg_catalog.count(*) = 1 into registration_exact
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
    and registration.revision = 3
    and registration.source_definition_key is null
    and registration.source_version = '1.1.0'
    and registration.source_revision is null
    and registration.validation_contract_version is null
    and registration.source_content_fingerprint is null
    and registration.source_resolution_fingerprint is null
    and registration.permission_catalogue_fingerprint = catalogue_fingerprint
    and registration.candidate_fingerprint = catalogue_fingerprint
    and history.operation = 'platform_metadata_revision'
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

  return registration_exact
    and (select pg_catalog.count(*) from vortex_access.permission_catalogue_entries as entry
      where entry.organization_id = p_organization_id
        and entry.registration_kind = 'platform'
        and entry.registration_owner_id = platform_owner_id
        and entry.registration_revision = 3) = pg_catalog.jsonb_array_length(catalogue_entries)
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(catalogue_entries) as expected(value)
      where not exists (
        select 1
        from vortex_access.permission_catalogue_entries as entry
        where entry.organization_id = p_organization_id
          and entry.registration_kind = 'platform'
          and entry.registration_owner_id = platform_owner_id
          and entry.registration_revision = 3
          and entry.application_root_id is null
          and entry.owner_kind = 'platform'
          and entry.owner_id = platform_owner_id
          and entry.permission_id = (expected.value ->> 'permissionId')::uuid
          and entry.permission_key = expected.value ->> 'key'
          and entry.label = expected.value ->> 'label'
          and entry.description = expected.value ->> 'description'
          and entry.record_type_id is null
          and entry.action_kind = expected.value ->> 'actionKind'
          and entry.named_action is null
          and entry.administrative
          and entry.source_kind = 'platform_catalogue'
          and entry.source_definition_key is null
          and entry.source_root_id is null
          and entry.source_version = '1.1.0'
          and entry.source_revision is null
          and entry.source_validation_contract_version is null
          and entry.source_content_fingerprint is null
          and entry.source_resolution_fingerprint is null
          and entry.source_catalogue_fingerprint = catalogue_fingerprint
          and entry.meaning_fingerprint = expected.value ->> 'meaningFingerprint'
      )
    );
end
$function$;

revoke all on function
  vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint) is
  'Owner-only fixed evidence assertion for the exact platform catalogue revisions 1 to 6; each additive revision delegates to its own exact checker.';
