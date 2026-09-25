-- #1134: builder permissions.
--
-- 1. Register the four builder permissions as platform catalogue release 1.4.0
--    (registration revision 6), carrying forward every revision-5 identity, meaning and
--    continuity unchanged.
--
--    The permissions are `platform.organization.definition_drafts.manage`,
--    `platform.organization.definition_releases.manage`,
--    `platform.organization.custom_code.manage` and
--    `platform.organization.system_applications.manage`. They are ordinary catalogue
--    entries only: registering them makes them available for role assignment in every
--    organisation and grants nobody authority. No role, including the ordinary
--    administrator role, receives them automatically.
--
--    Revision 6 contains the 18 revision-5 entries plus these four additive entries, so its
--    catalogue fingerprint changes while every earlier fingerprint, permission key, action
--    kind, administrative flag and meaning fingerprint stays byte-for-byte identical. Each
--    of the four meaning fingerprints is `fingerprintPermissionMeaning` of its declaration
--    and the catalogue fingerprint is the canonical fingerprint the TypeScript catalogue
--    computes for version 1.4.0. Release 1.3.0 (revision 5) is a published release and is
--    not edited. The live exact-revision checker and the live platform initializer are
--    restated in full with revision 6 added, so their identities, grants and callers are
--    unchanged.
--
-- 2. Require the person's recent authentication to accept a role template. The role-authority
--    coordinator already refuses a template whose permissions lie outside the actor's
--    delegated scope; its declaration now also requires primary authentication within 900
--    seconds for `create_custom_from_template`, `accept_new_application_role` and
--    `accept_application_role_revision`. Every other operation is unchanged.
--
-- Every function below is identical to its canonical file under supabase/schemas/vortex_access.

begin;

set local role postgres;

create or replace function vortex_access.platform_permission_catalogue_revision_is_exact_v1_4_0(
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
  drafts_permission_id constant uuid := '0548c061-b1a9-48e5-a04a-eb1d0dae0644';
  releases_permission_id constant uuid := 'dfdd5aba-2b85-4169-b570-92be284e7b5c';
  custom_code_permission_id constant uuid := 'd1be247f-094d-47c1-a38d-762290868c91';
  system_applications_permission_id constant uuid := 'eaade6fd-7390-44d2-a7ef-343324c7384a';
  catalogue_fingerprint constant text :=
    'sha256:1e5cceb04465d940f163ec926af7423efc9b37788551b00766d768fe9089195b';
  drafts_meaning_fingerprint constant text :=
    'sha256:29c4f706d6b65b54f4c3378de3f64816c01a22dc308ee7f6f0898d71eda216a0';
  releases_meaning_fingerprint constant text :=
    'sha256:b291e3a7d8a7f5cc0f346762914d1b1122be875d21fa70e5fdad819d28b1a80a';
  custom_code_meaning_fingerprint constant text :=
    'sha256:d8faa202f04c0c453cb87ed37f3b8f226b4171d133fc1277616a2b418db43c21';
  system_applications_meaning_fingerprint constant text :=
    'sha256:0c68ccc8a752c8009a5b84e5a22a584f3f22f666213121db1be7fb010cdbc50b';
  drafts_description constant text :=
    'Create and change module and application drafts, including flows, placements and role templates, without publication or installation authority.';
  releases_description constant text :=
    'Publish module and application drafts as immutable releases without receiving installation or business-record authority.';
  custom_code_description constant text :=
    'Required in addition to the application-management permission to install, upgrade or uninstall packages that bundle custom components or scripts.';
  system_applications_description constant text :=
    'Change system application definitions, including extension fields, theme, navigation and dependent applications, without uninstallation authority.';
begin
  if p_registration_revision is distinct from 6 then
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
       and registration.revision = 6
       and registration.source_version = '1.4.0'
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
    and (select pg_catalog.count(*) = 22
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 6)
    and (select pg_catalog.count(*) = 18
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 5)
    and not exists (
      select 1
      from vortex_access.permission_catalogue_entries as previous
      left join vortex_access.permission_catalogue_entries as current_entry
        on current_entry.organization_id = previous.organization_id
        and current_entry.registration_kind = previous.registration_kind
        and current_entry.registration_owner_id = previous.registration_owner_id
        and current_entry.registration_revision = 6
        and current_entry.owner_kind = previous.owner_kind
        and current_entry.owner_id = previous.owner_id
        and current_entry.permission_id = previous.permission_id
      where previous.organization_id = p_organization_id
        and previous.registration_kind = 'platform'
        and previous.registration_owner_id = platform_owner_id
        and previous.registration_revision = 5
        and (
          current_entry.permission_id is null
          or current_entry.source_version is distinct from '1.4.0'
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
           and entry.registration_revision = 6
           and entry.application_root_id is null
           and entry.owner_kind = 'platform'
           and entry.owner_id = platform_owner_id
           and entry.permission_id = drafts_permission_id
           and entry.permission_key = 'platform.organization.definition_drafts.manage'
           and entry.label = 'Manage definition drafts'
           and entry.description = drafts_description
           and entry.record_type_id is null
           and entry.record_scope is null
           and entry.field_policy is null
           and entry.action_kind = 'manage'
           and entry.named_action is null
           and entry.administrative
           and entry.source_kind = 'platform_catalogue'
           and entry.source_definition_key is null
           and entry.source_root_id is null
           and entry.source_version = '1.4.0'
           and entry.source_revision is null
           and entry.source_validation_contract_version is null
           and entry.source_content_fingerprint is null
           and entry.source_resolution_fingerprint is null
           and entry.source_catalogue_fingerprint = catalogue_fingerprint
           and entry.meaning_fingerprint = drafts_meaning_fingerprint)
    and (select pg_catalog.count(*) = 1
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 6
           and entry.application_root_id is null
           and entry.owner_kind = 'platform'
           and entry.owner_id = platform_owner_id
           and entry.permission_id = releases_permission_id
           and entry.permission_key = 'platform.organization.definition_releases.manage'
           and entry.label = 'Manage definition releases'
           and entry.description = releases_description
           and entry.record_type_id is null
           and entry.record_scope is null
           and entry.field_policy is null
           and entry.action_kind = 'manage'
           and entry.named_action is null
           and entry.administrative
           and entry.source_kind = 'platform_catalogue'
           and entry.source_definition_key is null
           and entry.source_root_id is null
           and entry.source_version = '1.4.0'
           and entry.source_revision is null
           and entry.source_validation_contract_version is null
           and entry.source_content_fingerprint is null
           and entry.source_resolution_fingerprint is null
           and entry.source_catalogue_fingerprint = catalogue_fingerprint
           and entry.meaning_fingerprint = releases_meaning_fingerprint)
    and (select pg_catalog.count(*) = 1
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 6
           and entry.application_root_id is null
           and entry.owner_kind = 'platform'
           and entry.owner_id = platform_owner_id
           and entry.permission_id = custom_code_permission_id
           and entry.permission_key = 'platform.organization.custom_code.manage'
           and entry.label = 'Manage custom code'
           and entry.description = custom_code_description
           and entry.record_type_id is null
           and entry.record_scope is null
           and entry.field_policy is null
           and entry.action_kind = 'manage'
           and entry.named_action is null
           and entry.administrative
           and entry.source_kind = 'platform_catalogue'
           and entry.source_definition_key is null
           and entry.source_root_id is null
           and entry.source_version = '1.4.0'
           and entry.source_revision is null
           and entry.source_validation_contract_version is null
           and entry.source_content_fingerprint is null
           and entry.source_resolution_fingerprint is null
           and entry.source_catalogue_fingerprint = catalogue_fingerprint
           and entry.meaning_fingerprint = custom_code_meaning_fingerprint)
    and (select pg_catalog.count(*) = 1
         from vortex_access.permission_catalogue_entries as entry
         where entry.organization_id = p_organization_id
           and entry.registration_kind = 'platform'
           and entry.registration_owner_id = platform_owner_id
           and entry.registration_revision = 6
           and entry.application_root_id is null
           and entry.owner_kind = 'platform'
           and entry.owner_id = platform_owner_id
           and entry.permission_id = system_applications_permission_id
           and entry.permission_key = 'platform.organization.system_applications.manage'
           and entry.label = 'Manage system applications'
           and entry.description = system_applications_description
           and entry.record_type_id is null
           and entry.record_scope is null
           and entry.field_policy is null
           and entry.action_kind = 'manage'
           and entry.named_action is null
           and entry.administrative
           and entry.source_kind = 'platform_catalogue'
           and entry.source_definition_key is null
           and entry.source_root_id is null
           and entry.source_version = '1.4.0'
           and entry.source_revision is null
           and entry.source_validation_contract_version is null
           and entry.source_content_fingerprint is null
           and entry.source_resolution_fingerprint is null
           and entry.source_catalogue_fingerprint = catalogue_fingerprint
           and entry.meaning_fingerprint = system_applications_meaning_fingerprint)
    and (select pg_catalog.count(*) = 22
         from vortex_access.permission_continuities as continuity
         where continuity.organization_id = p_organization_id
           and continuity.application_root_id is null
           and continuity.registration_kind = 'platform'
           and continuity.registration_owner_id = platform_owner_id
           and continuity.state = 'available'
           and continuity.last_processed_registration_revision = 6)
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
        and continuity.last_processed_registration_revision = 6
      where entry.organization_id = p_organization_id
        and entry.registration_kind = 'platform'
        and entry.registration_owner_id = platform_owner_id
        and entry.registration_revision = 6
        and continuity.permission_id is null
    );
end
$function$;

revoke all on function
  vortex_access.platform_permission_catalogue_revision_is_exact_v1_4_0(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.platform_permission_catalogue_revision_is_exact_v1_4_0(uuid, bigint) is
  'Owner-only fixed evidence assertion for exact platform catalogue revision 6 (1.4.0), which adds the four builder permissions to revision 5.';

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

create or replace function vortex_access.adopt_builder_permission_catalogue(
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
  drafts_permission_id constant uuid := '0548c061-b1a9-48e5-a04a-eb1d0dae0644';
  releases_permission_id constant uuid := 'dfdd5aba-2b85-4169-b570-92be284e7b5c';
  custom_code_permission_id constant uuid := 'd1be247f-094d-47c1-a38d-762290868c91';
  system_applications_permission_id constant uuid := 'eaade6fd-7390-44d2-a7ef-343324c7384a';
  catalogue_fingerprint constant text :=
    'sha256:1e5cceb04465d940f163ec926af7423efc9b37788551b00766d768fe9089195b';
  drafts_meaning_fingerprint constant text :=
    'sha256:29c4f706d6b65b54f4c3378de3f64816c01a22dc308ee7f6f0898d71eda216a0';
  releases_meaning_fingerprint constant text :=
    'sha256:b291e3a7d8a7f5cc0f346762914d1b1122be875d21fa70e5fdad819d28b1a80a';
  custom_code_meaning_fingerprint constant text :=
    'sha256:d8faa202f04c0c453cb87ed37f3b8f226b4171d133fc1277616a2b418db43c21';
  system_applications_meaning_fingerprint constant text :=
    'sha256:0c68ccc8a752c8009a5b84e5a22a584f3f22f666213121db1be7fb010cdbc50b';
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
      message = 'Builder permission catalogue adoption input is invalid';
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
      message = 'Builder permission catalogue scope is unavailable';
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

  if current_registration.revision = 6 then
    if not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 6
    ) then
      raise exception using errcode = '55000',
        message = 'Builder permission catalogue evidence is invalid';
    end if;
    select version.current_version into strict resulting_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
    return resulting_version;
  end if;

  if current_registration.revision <> 5
    or not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 5
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
    p_organization_id, 'platform', platform_owner_id, 6,
    'active', 'platform_metadata_revision', null, '1.4.0',
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
    entry.registration_owner_id, 6, entry.application_root_id,
    entry.owner_kind, entry.owner_id, entry.permission_id,
    entry.permission_key, entry.label, entry.description,
    entry.record_type_id, entry.action_kind, entry.named_action,
    entry.administrative, entry.source_kind, entry.source_definition_key,
    entry.source_root_id, '1.4.0', entry.source_revision,
    entry.source_validation_contract_version,
    entry.source_content_fingerprint, entry.source_resolution_fingerprint,
    catalogue_fingerprint, entry.meaning_fingerprint,
    entry.record_scope, entry.field_policy
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'platform'
    and entry.registration_owner_id = platform_owner_id
    and entry.registration_revision = 5;
  get diagnostics transition_count = row_count;
  if transition_count <> 18 then
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
      p_organization_id, 'platform', platform_owner_id, 6, null,
      'platform', platform_owner_id, drafts_permission_id,
      'platform.organization.definition_drafts.manage', 'Manage definition drafts',
      'Create and change module and application drafts, including flows, placements and role templates, without publication or installation authority.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.4.0', null, null, null, null, catalogue_fingerprint,
      drafts_meaning_fingerprint
    ),
    (
      p_organization_id, 'platform', platform_owner_id, 6, null,
      'platform', platform_owner_id, releases_permission_id,
      'platform.organization.definition_releases.manage', 'Manage definition releases',
      'Publish module and application drafts as immutable releases without receiving installation or business-record authority.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.4.0', null, null, null, null, catalogue_fingerprint,
      releases_meaning_fingerprint
    ),
    (
      p_organization_id, 'platform', platform_owner_id, 6, null,
      'platform', platform_owner_id, custom_code_permission_id,
      'platform.organization.custom_code.manage', 'Manage custom code',
      'Required in addition to the application-management permission to install, upgrade or uninstall packages that bundle custom components or scripts.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.4.0', null, null, null, null, catalogue_fingerprint,
      custom_code_meaning_fingerprint
    ),
    (
      p_organization_id, 'platform', platform_owner_id, 6, null,
      'platform', platform_owner_id, system_applications_permission_id,
      'platform.organization.system_applications.manage', 'Manage system applications',
      'Change system application definitions, including extension fields, theme, navigation and dependent applications, without uninstallation authority.',
      null, 'manage', null, true, 'platform_catalogue', null, null,
      '1.4.0', null, null, null, null, catalogue_fingerprint,
      system_applications_meaning_fingerprint
    );

  update vortex_access.permission_continuities as continuity
  set last_processed_registration_revision = 6,
      changed_at = operation_at
  where continuity.organization_id = p_organization_id
    and continuity.application_root_id is null
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id
    and continuity.state = 'available'
    and continuity.last_processed_registration_revision = 5;
  get diagnostics transition_count = row_count;
  if transition_count <> 18 then
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
      drafts_permission_id, 'platform', platform_owner_id,
      'available', 1, drafts_meaning_fingerprint, 6, operation_at
    ),
    (
      p_organization_id, null, 'platform', platform_owner_id,
      releases_permission_id, 'platform', platform_owner_id,
      'available', 1, releases_meaning_fingerprint, 6, operation_at
    ),
    (
      p_organization_id, null, 'platform', platform_owner_id,
      custom_code_permission_id, 'platform', platform_owner_id,
      'available', 1, custom_code_meaning_fingerprint, 6, operation_at
    ),
    (
      p_organization_id, null, 'platform', platform_owner_id,
      system_applications_permission_id, 'platform', platform_owner_id,
      'available', 1, system_applications_meaning_fingerprint, 6, operation_at
    );

  update vortex_access.permission_registrations as registration
  set revision = 6,
      source_version = '1.4.0',
      permission_catalogue_fingerprint = catalogue_fingerprint,
      candidate_fingerprint = catalogue_fingerprint,
      changed_at = operation_at,
      changed_by = p_changed_by,
      change_correlation_id = p_correlation_id
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = platform_owner_id
    and registration.revision = 5;
  if not found then
    raise exception using errcode = '40001',
      message = 'Platform permission catalogue changed concurrently';
  end if;

  if not vortex_access.platform_permission_catalogue_revision_is_exact(
    p_organization_id, 6
  ) then
    raise exception using errcode = '55000',
      message = 'Builder permission catalogue evidence is incomplete';
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

revoke all on function
  vortex_access.adopt_builder_permission_catalogue(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.adopt_builder_permission_catalogue(uuid, uuid, uuid) is
  'Owner-only additive adoption of platform catalogue revision 6 (1.4.0): registers the four builder permissions without changing any earlier permission or granting any role authority.';

create or replace function vortex_access.initialize_platform_permission_catalogue_v1_4_0(
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

  if current_revision = 5 then
    perform vortex_access.adopt_builder_permission_catalogue(
      p_organization_id, p_changed_by, p_correlation_id
    );
    current_revision := 6;
  end if;

  if current_revision is distinct from 6
    or not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 6
    ) then
    raise exception using errcode = '55000',
      message = 'Platform permission registration evidence is invalid';
  end if;

  return query
  select p_organization_id, 6::bigint, version.current_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id;
end
$function$;

revoke all on function
  vortex_access.initialize_platform_permission_catalogue_v1_4_0(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.initialize_platform_permission_catalogue_v1_4_0(uuid, uuid, uuid) is
  'Owner-only platform catalogue initializer step: advances an existing platform registration through every immutable revision to revision 6 (1.4.0).';

create or replace function vortex_access.initialize_platform_permission_catalogue(
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
  current_registration vortex_access.permission_registrations%rowtype;
begin
  if exists (
    select 1
    from vortex_access.permission_registrations as registration
    where registration.organization_id = p_organization_id
      and registration.registration_kind = 'platform'
      and registration.registration_owner_id =
        'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
  ) then
    return query
    select initialized.organization_id,
      initialized.registration_revision, initialized.access_version
    from vortex_access.initialize_platform_permission_catalogue_v1_4_0(
      p_organization_id, p_changed_by, p_correlation_id
    ) as initialized;
    return;
  end if;
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Platform permission registration input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501', message = 'Platform permission registration scope is unavailable';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
  for update;

  if found and current_registration.revision = 2 then
    return query
    select revised.organization_id, revised.registration_revision, revised.access_version
    from vortex_access.revise_platform_permission_catalogue_metadata(
      p_organization_id, 1, '1.0.0', '1.0.1', p_changed_by, p_correlation_id
    ) as revised;
    return;
  end if;

  if found then
    if current_registration.revision <> 1
      or not vortex_access.platform_permission_catalogue_revision_is_exact(
        p_organization_id, 1
      ) then
      raise exception using errcode = '55000', message = 'Platform permission registration evidence is invalid';
    end if;
    return query
    select current_registration.organization_id, current_registration.revision,
      version.current_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
    return;
  end if;

  return query
  select initialized.organization_id, initialized.registration_revision,
    initialized.access_version
  from vortex_access.initialize_platform_permission_catalogue_v1(
    p_organization_id, p_changed_by, p_correlation_id
  ) as initialized;
end
$function$;

revoke all on function
  vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid) is
  'Owner-only platform catalogue initializer; creates 1.0.0 for a new organisation and advances an existing registration through every immutable revision to revision 6 (1.4.0).';

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
    or vortex_context.is_non_nil_uuid(p_activity_id::text) is not true then
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
    or not vortex_context.is_non_nil_uuid(candidate ->> 'organizationId')
    or pg_catalog.jsonb_typeof(candidate -> 'roleId') is distinct from 'string'
    or not vortex_context.is_non_nil_uuid(candidate ->> 'roleId') then
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
      and vortex_context.is_non_nil_uuid(
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
          '{activationPolicy,reference,revision}')::numeric)
      and pg_catalog.jsonb_typeof(
        policy_choice #> '{activationPolicy,reference,fingerprint}'
      ) = 'string'
      and policy_choice #>> '{activationPolicy,reference,fingerprint}'
        ~ '^sha256:[a-f0-9]{64}$' then
      policy_changed := current_revision.assignment_policy <> 'activation_required'
        or current_revision.activation_policy_id is distinct from
          (policy_choice #>>
            '{activationPolicy,reference,activationPolicyId}')::uuid
        or current_revision.activation_policy_revision is distinct from
          (policy_choice #>> '{activationPolicy,reference,revision}')::numeric::bigint
        or current_revision.activation_policy_fingerprint is distinct from
          policy_choice #>> '{activationPolicy,reference,fingerprint}';
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
    authority_after := vortex_access.private_management_scope_from_permission_evidence(
      candidate -> 'permissions'
    );
  end if;

  if authority_before ->> 'kind' = 'none'
    and authority_after ->> 'kind' = 'none' then
    raise exception using errcode = '40001',
      message = 'Private Organization role-authority scope is unavailable';
  end if;

  operation_key := 'platform.organization.roles.' || operation_name;
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', operation_key,
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '87c96495-c806-4692-9bc2-250ddb10613c'
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
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from operation_key
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Private Organization role-authority change is unavailable';
  end if;

  select result.* into strict changed
  from vortex_access.coordinate_organization_role_change(
    p_prepared_evidence, context_account_id, context_correlation_id
  ) as result;

  activity_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    (changed.role ->> 'changedAt')::timestamptz,
    'organization_account', context_account_id, operation_name,
    array[target_role_id]::uuid[], array[]::uuid[], vortex_context.channel(),
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

-- A migration is the publisher of this additive platform catalogue revision. Keep one
-- correlation across its per-organisation upgrades. Inactive organisations advance through
-- the same initializer when reactivated.
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
      '11340000-0000-4000-8000-000000001134'::uuid
    );
  end loop;
end
$backfill$;

reset role;

commit;
