CREATE OR REPLACE FUNCTION vortex_access.list_application_role_templates_for_administration(p_after_application_root_id uuid, p_after_source_role_id uuid, p_page_size integer) RETURNS TABLE(organization_id uuid, templates jsonb, next_after_application_root_id uuid, next_after_source_role_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  template_items jsonb;
  page_application_root_ids uuid[];
  page_source_role_ids uuid[];
  candidate_count integer;
  cursor_absent boolean;
begin
  cursor_absent := p_after_application_root_id is null
    and p_after_source_role_id is null;
  if p_page_size is null or p_page_size not between 1 and 100
    or (
      cursor_absent
      or (
        p_after_application_root_id is not null
        and p_after_source_role_id is not null
      )
    ) is not true
    or p_after_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_after_source_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application role template page input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_roles_administration_scope() as authorized;

  with candidates as (
    select registration.registration_owner_id as application_root_id,
      (template.value ->> 'roleId')::uuid as source_role_id,
      template.value ->> 'key' as role_key,
      template.value ->> 'name' as role_label,
      template.value #>> '{permissionSelection,kind}' as permission_selection_kind,
      template.value -> 'permissionKeys' as permission_keys,
      pg_catalog.row_number() over (
        order by registration.registration_owner_id,
          (template.value ->> 'roleId')::uuid
      ) as ordinal
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
      and registration.state = 'active'
      and (
        cursor_absent
        or (
          registration.registration_owner_id,
          (template.value ->> 'roleId')::uuid
        ) > (p_after_application_root_id, p_after_source_role_id)
      )
    order by registration.registration_owner_id,
      (template.value ->> 'roleId')::uuid
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'reference', pg_catalog.jsonb_build_object(
            'applicationRootId', candidate.application_root_id,
            'sourceRoleId', candidate.source_role_id
          ),
          'key', candidate.role_key,
          'label', candidate.role_label,
          'permissionSelectionKind', candidate.permission_selection_kind,
          'publishedPermissionKeys', candidate.permission_keys
        ) order by candidate.application_root_id, candidate.source_role_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.application_root_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.array_agg(candidate.source_role_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into template_items, page_application_root_ids, page_source_role_ids,
    candidate_count
  from candidates as candidate;

  return query select scope.organization_id, template_items,
    case when candidate_count > p_page_size
      then page_application_root_ids[p_page_size] else null end,
    case when candidate_count > p_page_size
      then page_source_role_ids[p_page_size] else null end,
    scope.access_version;
end
$$;

ALTER FUNCTION vortex_access.list_application_role_templates_for_administration(p_after_application_root_id uuid, p_after_source_role_id uuid, p_page_size integer) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.list_application_role_templates_for_administration(p_after_application_root_id uuid, p_after_source_role_id uuid, p_page_size integer) IS 'Returns one bounded page of exact current registered application role templates.';

REVOKE ALL ON FUNCTION vortex_access.list_application_role_templates_for_administration(p_after_application_root_id uuid, p_after_source_role_id uuid, p_page_size integer) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.list_application_role_templates_for_administration(p_after_application_root_id uuid, p_after_source_role_id uuid, p_page_size integer) TO vortex_request;
