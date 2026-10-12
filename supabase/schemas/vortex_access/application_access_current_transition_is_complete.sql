CREATE FUNCTION vortex_access.application_access_current_transition_is_complete(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_registration_state text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select
    p_registration_state in ('active', 'withdrawn')
    and not exists (
      select 1
      from vortex_access.permission_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
        and continuity.last_processed_registration_revision <>
          p_registration_revision
    )
    and not exists (
      select 1
      from vortex_access.application_role_template_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
        and continuity.last_processed_registration_revision <>
          p_registration_revision
    )
    and not exists (
      select 1
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = p_organization_id
        and permission.registration_kind = 'application'
        and permission.registration_owner_id = p_application_root_id
        and not exists (
          select 1
          from vortex_access.permission_continuities as continuity
          where continuity.organization_id = permission.organization_id
            and continuity.application_root_id = permission.application_root_id
            and continuity.owner_kind = permission.owner_kind
            and continuity.owner_id = permission.owner_id
            and continuity.permission_id = permission.permission_id
        )
    )
    and not exists (
      select 1
      from vortex_access.organization_roles as role
      where role.organization_id = p_organization_id
        and role.role_kind = 'application'
        and role.application_root_id = p_application_root_id
        and not exists (
          select 1
          from vortex_access.application_role_template_continuities as continuity
          where continuity.organization_id = role.organization_id
            and continuity.application_root_id = role.application_root_id
            and continuity.source_role_id = role.source_role_id
        )
    )
    and (
      (
        p_registration_state = 'active'
        and not exists (
          select 1
          from vortex_access.permission_catalogue_entries as entry
          where entry.organization_id = p_organization_id
            and entry.registration_kind = 'application'
            and entry.registration_owner_id = p_application_root_id
            and entry.registration_revision = p_registration_revision
            and not exists (
              select 1
              from vortex_access.permission_continuities as continuity
              where continuity.organization_id = entry.organization_id
                and continuity.application_root_id = entry.application_root_id
                and continuity.owner_kind = entry.owner_kind
                and continuity.owner_id = entry.owner_id
                and continuity.permission_id = entry.permission_id
                and continuity.state = 'available'
                and continuity.meaning_fingerprint = entry.meaning_fingerprint
            )
        )
        and not exists (
          select 1
          from vortex_access.permission_continuities as continuity
          where continuity.organization_id = p_organization_id
            and continuity.application_root_id = p_application_root_id
            and continuity.state = 'available'
            and not exists (
              select 1
              from vortex_access.permission_catalogue_entries as entry
              where entry.organization_id = continuity.organization_id
                and entry.registration_kind = 'application'
                and entry.registration_owner_id = p_application_root_id
                and entry.registration_revision = p_registration_revision
                and entry.application_root_id = continuity.application_root_id
                and entry.owner_kind = continuity.owner_kind
                and entry.owner_id = continuity.owner_id
                and entry.permission_id = continuity.permission_id
                and entry.meaning_fingerprint = continuity.meaning_fingerprint
            )
        )
      )
      or (
        p_registration_state = 'withdrawn'
        and not exists (
          select 1
          from vortex_access.permission_continuities as continuity
          where continuity.organization_id = p_organization_id
            and continuity.application_root_id = p_application_root_id
            and continuity.state = 'available'
        )
        and not exists (
          select 1
          from vortex_access.application_role_template_continuities as continuity
          where continuity.organization_id = p_organization_id
            and continuity.application_root_id = p_application_root_id
            and continuity.state = 'available'
        )
      )
    );
$$;


ALTER FUNCTION vortex_access.application_access_current_transition_is_complete(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_registration_state text) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.application_access_current_transition_is_complete(p_organization_id uuid, p_application_root_id uuid, p_registration_revision bigint, p_registration_state text) FROM PUBLIC;
