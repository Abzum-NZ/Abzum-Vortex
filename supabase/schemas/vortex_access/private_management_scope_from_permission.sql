CREATE OR REPLACE FUNCTION vortex_access.private_management_scope_from_permission(p_permissions jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  projected jsonb;
begin
  if p_permissions is null
    or pg_catalog.jsonb_typeof(p_permissions) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Private management permission evidence is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_permissions) = 0 then
    return pg_catalog.jsonb_build_object('kind', 'none');
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_permissions) as item(value)
    where (
      pg_catalog.jsonb_typeof(item.value) = 'object'
      and item.value ?& array[
        'ownerKind', 'ownerId', 'permissionId',
        'acceptedRegistrationRevision'
      ]
      and pg_catalog.jsonb_typeof(item.value -> 'ownerKind') = 'string'
      and item.value ->> 'ownerKind' in ('platform', 'application', 'module')
      and pg_catalog.jsonb_typeof(item.value -> 'ownerId') = 'string'
      and vortex_platform.is_non_nil_uuid(item.value ->> 'ownerId')
      and pg_catalog.jsonb_typeof(item.value -> 'permissionId') = 'string'
      and vortex_platform.is_non_nil_uuid(item.value ->> 'permissionId')
      and pg_catalog.jsonb_typeof(item.value -> 'acceptedRegistrationRevision') = 'number'
      and (item.value ->> 'acceptedRegistrationRevision')::numeric
        between 1 and 9007199254740991
      and (item.value ->> 'acceptedRegistrationRevision')::numeric =
        pg_catalog.trunc((item.value ->> 'acceptedRegistrationRevision')::numeric)
      and (
        (
          item.value ->> 'ownerKind' = 'platform'
          and not item.value ? 'applicationRootId'
        ) or (
          item.value ->> 'ownerKind' in ('application', 'module')
          and pg_catalog.jsonb_typeof(item.value -> 'applicationRootId') = 'string'
          and vortex_platform.is_non_nil_uuid(item.value ->> 'applicationRootId')
          and (
            item.value ->> 'ownerKind' <> 'application'
            or (item.value ->> 'ownerId')::uuid =
              (item.value ->> 'applicationRootId')::uuid
          )
        )
      )
    ) is not true
  ) then
    raise exception using errcode = '22023',
      message = 'Private management permission evidence is invalid';
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(
    pg_catalog.jsonb_build_object(
      'applicationRootId', parsed.application_root_id,
      'ownerKind', parsed.owner_kind,
      'ownerId', parsed.owner_id,
      'permissionId', parsed.permission_id,
      'acceptedRegistrationRevision', parsed.accepted_registration_revision
    )
  ) order by parsed.application_root_id nulls first,
    parsed.owner_kind collate "C", parsed.owner_id, parsed.permission_id)
  into projected
  from (
    select distinct
      case when item.value ->> 'ownerKind' = 'platform' then null::uuid
        else (item.value ->> 'applicationRootId')::uuid end as application_root_id,
      item.value ->> 'ownerKind' as owner_kind,
      (item.value ->> 'ownerId')::uuid as owner_id,
      (item.value ->> 'permissionId')::uuid as permission_id,
      (item.value ->> 'acceptedRegistrationRevision')::bigint as accepted_registration_revision
    from pg_catalog.jsonb_array_elements(p_permissions) as item(value)
  ) as parsed;

  return pg_catalog.jsonb_build_object(
    'kind', 'bounded', 'permissions', projected
  );
end
$$;

alter function vortex_access.private_management_scope_from_permission(p_permissions jsonb) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.private_management_scope_from_permission(p_permissions jsonb) FROM PUBLIC;

grant execute on function vortex_access.private_management_scope_from_permission(p_permissions jsonb) to postgres;
