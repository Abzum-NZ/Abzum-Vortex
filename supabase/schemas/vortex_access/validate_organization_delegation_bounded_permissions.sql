CREATE FUNCTION vortex_access.validate_organization_delegation_bounded_permissions(p_organization_id uuid, p_permissions jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $_$
declare
  canonical_permissions jsonb;
begin
  if p_permissions is null
    or pg_catalog.jsonb_typeof(p_permissions) <> 'array'
    or pg_catalog.jsonb_array_length(p_permissions) = 0 then
    raise exception using errcode = '23514',
      message = 'Bounded delegation permissions must be a nonempty array';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_permissions) as candidate(value)
    where pg_catalog.jsonb_typeof(candidate.value) <> 'object'
  ) then
    raise exception using errcode = '23514',
      message = 'Every bounded delegation permission must be an object';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_permissions) as candidate(value)
    where (
      (
        candidate.value ->> 'ownerKind' = 'platform'
        and candidate.value ?& array[
          'acceptedRegistrationRevision', 'catalogueFingerprint',
          'continuityRevision', 'kind', 'meaningFingerprint', 'ownerId',
          'ownerKind', 'permissionId'
        ]
        and candidate.value - array[
          'acceptedRegistrationRevision', 'catalogueFingerprint',
          'continuityRevision', 'kind', 'meaningFingerprint', 'ownerId',
          'ownerKind', 'permissionId'
        ] = '{}'::jsonb
      ) or (
        candidate.value ->> 'ownerKind' in ('application', 'module')
        and candidate.value ?& array[
          'acceptedRegistrationRevision', 'applicationRootId',
          'catalogueFingerprint', 'continuityRevision', 'kind',
          'meaningFingerprint', 'ownerId', 'ownerKind', 'permissionId'
        ]
        and candidate.value - array[
          'acceptedRegistrationRevision', 'applicationRootId',
          'catalogueFingerprint', 'continuityRevision', 'kind',
          'meaningFingerprint', 'ownerId', 'ownerKind', 'permissionId'
        ] = '{}'::jsonb
      )
    ) is not true
  ) then
    raise exception using errcode = '23514',
      message = 'A bounded delegation permission has missing or unknown keys';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_permissions) as candidate(value)
    where (
      pg_catalog.jsonb_typeof(candidate.value -> 'kind') = 'string'
      and candidate.value ->> 'kind' = 'exact'
      and pg_catalog.jsonb_typeof(candidate.value -> 'ownerKind') = 'string'
      and candidate.value ->> 'ownerKind' in ('platform', 'application', 'module')
      and case
        when pg_catalog.jsonb_typeof(candidate.value -> 'ownerId') = 'string'
          and candidate.value ->> 'ownerId' ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then pg_catalog.lower(candidate.value ->> 'ownerId') <>
            '00000000-0000-0000-0000-000000000000'
        else false
      end
      and case
        when pg_catalog.jsonb_typeof(candidate.value -> 'permissionId') =
          'string'
          and candidate.value ->> 'permissionId' ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then pg_catalog.lower(candidate.value ->> 'permissionId') <>
            '00000000-0000-0000-0000-000000000000'
        else false
      end
      and case
        when pg_catalog.jsonb_typeof(
          candidate.value -> 'acceptedRegistrationRevision'
        ) = 'number' then
          (candidate.value ->> 'acceptedRegistrationRevision')::numeric
            between 1 and 9007199254740991
          and (candidate.value ->> 'acceptedRegistrationRevision')::numeric =
            pg_catalog.trunc(
              (candidate.value ->> 'acceptedRegistrationRevision')::numeric
            )
        else false
      end
      and case
        when pg_catalog.jsonb_typeof(candidate.value -> 'continuityRevision') =
          'number' then
          (candidate.value ->> 'continuityRevision')::numeric
            between 1 and 9007199254740991
          and (candidate.value ->> 'continuityRevision')::numeric =
            pg_catalog.trunc(
              (candidate.value ->> 'continuityRevision')::numeric
            )
        else false
      end
      and pg_catalog.jsonb_typeof(candidate.value -> 'catalogueFingerprint') =
        'string'
      and candidate.value ->> 'catalogueFingerprint' ~
        '^sha256:[a-f0-9]{64}$'
      and pg_catalog.jsonb_typeof(candidate.value -> 'meaningFingerprint') =
        'string'
      and candidate.value ->> 'meaningFingerprint' ~ '^sha256:[a-f0-9]{64}$'
      and (
        (
          candidate.value ->> 'ownerKind' = 'platform'
          and not candidate.value ? 'applicationRootId'
        ) or (
          candidate.value ->> 'ownerKind' in ('application', 'module')
          and case
            when pg_catalog.jsonb_typeof(
              candidate.value -> 'applicationRootId'
            ) = 'string'
              and candidate.value ->> 'applicationRootId' ~*
                '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then pg_catalog.lower(candidate.value ->> 'applicationRootId') <>
                '00000000-0000-0000-0000-000000000000'
            else false
          end
          and (
            candidate.value ->> 'ownerKind' <> 'application'
            or pg_catalog.lower(candidate.value ->> 'ownerId') =
              pg_catalog.lower(candidate.value ->> 'applicationRootId')
          )
        )
      )
    ) is not true
  ) then
    raise exception using errcode = '23514',
      message = 'A bounded delegation permission has invalid values';
  end if;

  if exists (
    with parsed as (
      select
        case
          when candidate.value ->> 'ownerKind' = 'platform' then null::uuid
          else (candidate.value ->> 'applicationRootId')::uuid
        end as application_root_id,
        candidate.value ->> 'ownerKind' as owner_kind,
        (candidate.value ->> 'ownerId')::uuid as owner_id,
        (candidate.value ->> 'permissionId')::uuid as permission_id
      from pg_catalog.jsonb_array_elements(p_permissions) as candidate(value)
    )
    select 1
    from parsed
    group by application_root_id, owner_kind, owner_id, permission_id
    having pg_catalog.count(*) > 1
  ) then
    raise exception using errcode = '23514',
      message = 'A bounded delegation permission identity may appear only once';
  end if;

  with parsed as (
    select candidate.value,
      case
        when candidate.value ->> 'ownerKind' = 'platform' then null::uuid
        else (candidate.value ->> 'applicationRootId')::uuid
      end as application_root_id,
      candidate.value ->> 'ownerKind' as owner_kind,
      (candidate.value ->> 'ownerId')::uuid as owner_id,
      (candidate.value ->> 'permissionId')::uuid as permission_id
    from pg_catalog.jsonb_array_elements(p_permissions) as candidate(value)
  )
  select pg_catalog.jsonb_agg(
    parsed.value order by parsed.application_root_id asc nulls last,
      parsed.owner_kind collate "C", parsed.owner_id, parsed.permission_id
  )
  into canonical_permissions
  from parsed;

  if canonical_permissions is distinct from p_permissions then
    raise exception using errcode = '23514',
      message = 'Bounded delegation permissions must use canonical order';
  end if;

  if exists (
    with parsed as (
      select
        case
          when candidate.value ->> 'ownerKind' = 'platform' then null::uuid
          else (candidate.value ->> 'applicationRootId')::uuid
        end as application_root_id,
        candidate.value ->> 'ownerKind' as owner_kind,
        (candidate.value ->> 'ownerId')::uuid as owner_id,
        (candidate.value ->> 'permissionId')::uuid as permission_id,
        (candidate.value ->> 'acceptedRegistrationRevision')::numeric::bigint as
          accepted_registration_revision,
        candidate.value ->> 'catalogueFingerprint' as catalogue_fingerprint,
        (candidate.value ->> 'continuityRevision')::numeric::bigint as
          continuity_revision,
        candidate.value ->> 'meaningFingerprint' as meaning_fingerprint
      from pg_catalog.jsonb_array_elements(p_permissions) as candidate(value)
    )
    select 1
    from parsed
    where not exists (
      select 1
      from vortex_access.permission_catalogue_entries as entry
      join vortex_access.permission_registration_revisions as registration
        on registration.organization_id = entry.organization_id
        and registration.registration_kind = entry.registration_kind
        and registration.registration_owner_id = entry.registration_owner_id
        and registration.revision = entry.registration_revision
        and registration.state = 'active'
        and registration.permission_catalogue_fingerprint =
          parsed.catalogue_fingerprint
      join vortex_access.permission_continuities as continuity
        on continuity.organization_id = entry.organization_id
        and continuity.application_root_id is not distinct from
          entry.application_root_id
        and continuity.owner_kind = entry.owner_kind
        and continuity.owner_id = entry.owner_id
        and continuity.permission_id = entry.permission_id
        and continuity.state = 'available'
        and continuity.continuity_revision = parsed.continuity_revision
        and continuity.meaning_fingerprint = parsed.meaning_fingerprint
      where entry.organization_id = p_organization_id
        and entry.application_root_id is not distinct from
          parsed.application_root_id
        and entry.owner_kind = parsed.owner_kind
        and entry.owner_id = parsed.owner_id
        and entry.permission_id = parsed.permission_id
        and entry.registration_revision =
          parsed.accepted_registration_revision
        and entry.meaning_fingerprint = parsed.meaning_fingerprint
    )
  ) then
    raise exception using errcode = '23514',
      message = 'Bounded delegation permissions require exact current catalogue evidence';
  end if;
end
$_$;

alter function vortex_access.validate_organization_delegation_bounded_permissions(p_organization_id uuid, p_permissions jsonb) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.validate_organization_delegation_bounded_permissions(p_organization_id uuid, p_permissions jsonb) FROM PUBLIC;

grant execute on function vortex_access.validate_organization_delegation_bounded_permissions(p_organization_id uuid, p_permissions jsonb) to postgres;
