CREATE FUNCTION vortex_access.record_share_grant_source_authority_internal(p_context jsonb, p_module_root_id uuid, p_record_type_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  context_organization_id uuid := (p_context ->> 'organizationId')::uuid;
  context_application_root_id uuid := (p_context ->> 'applicationRootId')::uuid;
  checked_at timestamptz := pg_catalog.clock_timestamp();
  authority jsonb;
begin
  if p_context ? 'delegatedContext' or p_context ? 'supportContext'
    or context_organization_id is null or context_application_root_id is null
    or p_module_root_id is null then
    return pg_catalog.jsonb_build_object(
      'recordTypeIds', '[]'::jsonb,
      'readableFieldIds', '[]'::jsonb,
      'changeableFieldIds', '[]'::jsonb
    );
  end if;

  with current_entries as materialized (
    select entry.*
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
      and registration.state = 'active'
    where entry.organization_id = context_organization_id
      and entry.application_root_id = context_application_root_id
      and entry.record_type_id is not null
      and (p_record_type_id is null or entry.record_type_id = p_record_type_id)
  ), module_record_types as materialized (
    select distinct entry.record_type_id
    from current_entries as entry
    where entry.owner_kind = 'module'
      and entry.owner_id = p_module_root_id
  ), candidates as materialized (
    select entry.record_type_id, entry.action_kind, entry.field_policy,
      entry.owner_kind, entry.owner_id, entry.permission_id
    from current_entries as entry
    join module_record_types as scoped
      on scoped.record_type_id = entry.record_type_id
    where (
        (entry.owner_kind = 'application' and entry.owner_id = context_application_root_id)
        or (entry.owner_kind = 'module' and entry.owner_id = p_module_root_id)
      )
      and entry.action_kind in ('share', 'read', 'update')
      and entry.named_action is null
      and entry.record_scope is not null
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements(entry.record_scope -> 'routes') as route(value)
        where route.value ->> 'kind' = 'all_records'
      )
      and not (entry.record_scope ? 'savedCondition')
  ), effective as materialized (
    select candidate.*
    from candidates as candidate
    where exists (
      select 1
      from vortex_access.evaluate_permission_role_path_internal(
        p_context,
        checked_at,
        pg_catalog.jsonb_build_object(
          'applicationRootId', context_application_root_id,
          'ownerKind', candidate.owner_kind,
          'ownerId', candidate.owner_id,
          'permissionId', candidate.permission_id
        ),
        pg_catalog.jsonb_build_object('actionKind', candidate.action_kind),
        candidate.record_type_id
      ) as path
      where path.path_valid_until > checked_at
    )
  ), shareable_types as materialized (
    select distinct effective.record_type_id
    from effective
    where effective.action_kind = 'share'
  )
  select pg_catalog.jsonb_build_object(
    'recordTypeIds', coalesce((
      select pg_catalog.jsonb_agg(shareable.record_type_id order by shareable.record_type_id)
      from shareable_types as shareable
    ), '[]'::jsonb),
    'readableFieldIds', coalesce((
      select pg_catalog.jsonb_agg(distinct pg_catalog.lower(field.value))
      from effective
      join shareable_types as shareable
        on shareable.record_type_id = effective.record_type_id
      cross join lateral pg_catalog.jsonb_array_elements_text(
        case when pg_catalog.jsonb_typeof(effective.field_policy -> 'readableFieldIds') = 'array'
          then effective.field_policy -> 'readableFieldIds' else '[]'::jsonb end
      ) as field(value)
      where effective.action_kind = 'read'
    ), '[]'::jsonb),
    'changeableFieldIds', coalesce((
      select pg_catalog.jsonb_agg(distinct pg_catalog.lower(field.value))
      from effective
      join shareable_types as shareable
        on shareable.record_type_id = effective.record_type_id
      cross join lateral pg_catalog.jsonb_array_elements_text(
        case when pg_catalog.jsonb_typeof(effective.field_policy -> 'changeableFieldIds') = 'array'
          then effective.field_policy -> 'changeableFieldIds' else '[]'::jsonb end
      ) as field(value)
      where effective.action_kind = 'update'
    ), '[]'::jsonb)
  )
  into authority;

  return authority;
end
$$;

alter function vortex_access.record_share_grant_source_authority_internal(p_context jsonb, p_module_root_id uuid, p_record_type_id uuid) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.record_share_grant_source_authority_internal(p_context jsonb, p_module_root_id uuid, p_record_type_id uuid) FROM PUBLIC;

grant execute on function vortex_access.record_share_grant_source_authority_internal(p_context jsonb, p_module_root_id uuid, p_record_type_id uuid) to postgres;
