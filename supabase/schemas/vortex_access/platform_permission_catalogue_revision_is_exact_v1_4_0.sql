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
