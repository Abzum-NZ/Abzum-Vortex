CREATE FUNCTION vortex_access.read_application_role_template_for_administration(p_application_root_id uuid, p_source_role_id uuid) RETURNS TABLE(organization_id uuid, outcome text, template_summary jsonb, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  template_value jsonb;
begin
  if p_application_root_id is null or p_source_role_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_source_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application role template detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_roles_administration_scope() as authorized;

  select pg_catalog.jsonb_build_object(
    'reference', pg_catalog.jsonb_build_object(
      'applicationRootId', registration.registration_owner_id,
      'sourceRoleId', (template.value ->> 'roleId')::uuid
    ),
    'key', template.value ->> 'key',
    'label', template.value ->> 'name',
    'permissionSelectionKind', template.value #>> '{permissionSelection,kind}',
    'publishedPermissionKeys', template.value -> 'permissionKeys'
  )
  into template_value
  from vortex_access.permission_registrations as registration
  join vortex_definition.roots as root
    on root.root_id = registration.registration_owner_id
    and root.organization_id = registration.organization_id
    and root.kind = 'application'
    and root.key = registration.source_definition_key
  join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = registration.source_revision
    and release.release_version = registration.source_version
    and release.validation_contract_version = registration.validation_contract_version
    and release.content_fingerprint = registration.source_content_fingerprint
    and release.resolution_fingerprint = registration.source_resolution_fingerprint
  cross join lateral pg_catalog.jsonb_array_elements(
    release.compilation_output #> '{canonical,content,roles}'
  ) as template(value)
  join vortex_access.application_role_template_continuities as continuity
    on continuity.organization_id = registration.organization_id
    and continuity.application_root_id = registration.registration_owner_id
    and continuity.source_role_id = (template.value ->> 'roleId')::uuid
    and continuity.state = 'available'
    and continuity.last_processed_registration_revision = registration.revision
  where registration.organization_id = scope.organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id
    and registration.state = 'active'
    and (template.value ->> 'roleId')::uuid = p_source_role_id;

  return query select scope.organization_id,
    case when template_value is null then 'unavailable' else 'available' end,
    template_value, scope.access_version;
end
$$;

ALTER FUNCTION vortex_access.read_application_role_template_for_administration(p_application_root_id uuid, p_source_role_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.read_application_role_template_for_administration(p_application_root_id uuid, p_source_role_id uuid) IS 'Returns one exact template from an active current application registration.';

REVOKE ALL ON FUNCTION vortex_access.read_application_role_template_for_administration(p_application_root_id uuid, p_source_role_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.read_application_role_template_for_administration(p_application_root_id uuid, p_source_role_id uuid) TO vortex_request;
