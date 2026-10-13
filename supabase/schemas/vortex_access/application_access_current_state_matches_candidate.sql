CREATE FUNCTION vortex_access.application_access_current_state_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_prepared_templates jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  role_record record;
  target_template jsonb;
  current_permission_count bigint;
  retained_permission_count bigint;
  target_permission_count bigint;
  target_lifecycle text;
  target_template_continuity_revision bigint;
begin
  if not vortex_access.application_permission_registration_matches_candidate(
    p_organization_id, p_application_root_id, p_registration_revision,
    p_prepared_templates -> 'permissionRegistration'
  ) then
    return false;
  end if;

  if exists (
    select 1
    from vortex_access.application_role_template_continuities as continuity
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.last_processed_registration_revision <> p_registration_revision
  ) or exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
    where not exists (
      select 1
      from vortex_access.application_role_template_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
        and continuity.source_role_id = (item.value #>> '{template,roleId}')::uuid
        and continuity.state = 'available'
        and continuity.source_template_fingerprint =
          item.value ->> 'sourceTemplateFingerprint'
        and continuity.last_processed_registration_revision = p_registration_revision
    )
  ) or exists (
    select 1
    from vortex_access.application_role_template_continuities as continuity
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.state = 'available'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
        where (item.value #>> '{template,roleId}')::uuid = continuity.source_role_id
          and item.value ->> 'sourceTemplateFingerprint' =
            continuity.source_template_fingerprint
      )
  ) then
    return false;
  end if;

  for role_record in
    select role.role_id, role.source_role_id, revision.lifecycle,
      revision.revision as role_revision, revision.source_template_fingerprint,
      revision.template_continuity_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = p_organization_id
      and role.role_kind = 'application'
      and role.application_root_id = p_application_root_id
    order by role.role_id
  loop
    if role_record.lifecycle = 'retired' then
      continue;
    end if;

    target_template := null;
    target_template_continuity_revision := null;
    select item.value, continuity.continuity_revision
    into target_template, target_template_continuity_revision
    from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
    join vortex_access.application_role_template_continuities as continuity
      on continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.source_role_id = (item.value #>> '{template,roleId}')::uuid
      and continuity.state = 'available'
    where (item.value #>> '{template,roleId}')::uuid = role_record.source_role_id;

    select pg_catalog.count(*) into current_permission_count
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = p_organization_id
      and permission.role_id = role_record.role_id
      and permission.role_revision = role_record.role_revision;

    if target_template is null then
      retained_permission_count := 0;
      target_permission_count := 0;
      target_lifecycle := 'unavailable';
    else
      select pg_catalog.count(*) into retained_permission_count
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_continuities as continuity
        on continuity.organization_id = permission.organization_id
        and continuity.application_root_id = permission.application_root_id
        and continuity.owner_kind = permission.owner_kind
        and continuity.owner_id = permission.owner_id
        and continuity.permission_id = permission.permission_id
        and continuity.state = 'available'
        and continuity.continuity_revision = permission.continuity_revision
        and continuity.meaning_fingerprint = permission.meaning_fingerprint
      where permission.organization_id = p_organization_id
        and permission.role_id = role_record.role_id
        and permission.role_revision = role_record.role_revision
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            target_template -> 'livePermissions'
          ) as candidate(value)
          where (candidate.value ->> 'applicationRootId')::uuid =
              permission.application_root_id
            and candidate.value ->> 'ownerKind' = permission.owner_kind
            and (candidate.value ->> 'ownerId')::uuid = permission.owner_id
            and (candidate.value #>> '{permission,permissionId}')::uuid =
              permission.permission_id
            and candidate.value ->> 'meaningFingerprint' =
              permission.meaning_fingerprint
        );
      target_permission_count := pg_catalog.jsonb_array_length(
        target_template -> 'livePermissions'
      );
      if role_record.lifecycle = 'active'
        and retained_permission_count > 0
        and retained_permission_count = target_permission_count
        and role_record.template_continuity_revision =
          target_template_continuity_revision then
        target_lifecycle := 'active';
      else
        target_lifecycle := 'acceptance_required';
      end if;
    end if;

    if role_record.lifecycle <> target_lifecycle
      or current_permission_count <> retained_permission_count then
      return false;
    end if;
  end loop;

  return true;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end
$$;

ALTER FUNCTION vortex_access.application_access_current_state_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_prepared_templates jsonb) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.application_access_current_state_matches_candidate(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_prepared_templates jsonb) FROM PUBLIC;
