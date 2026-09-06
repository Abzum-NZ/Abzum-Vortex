-- Protected permission-catalogue reads expose current declarations only. They
-- deliberately omit registration provenance, fingerprints, record-scope
-- evidence and audit columns.

create function vortex_access.organization_permissions_administration_scope()
returns table (
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.permissions.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '687d5649-62ee-43dd-b684-b8af3a5394c1'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Organization permission catalogue is unavailable';
  end if;

  return query select decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$function$;

create function vortex_access.list_organization_permissions_for_administration(
  p_after_application_root_id uuid,
  p_after_owner_kind text,
  p_after_owner_id uuid,
  p_after_permission_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  permissions jsonb,
  next_after_application_root_id uuid,
  next_after_owner_kind text,
  next_after_owner_id uuid,
  next_after_permission_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  permission_items jsonb;
  page_application_root_ids uuid[];
  page_owner_kinds text[];
  page_owner_ids uuid[];
  page_permission_ids uuid[];
  candidate_count integer;
  cursor_absent boolean;
  cursor_valid boolean;
begin
  cursor_absent := p_after_application_root_id is null
    and p_after_owner_kind is null
    and p_after_owner_id is null
    and p_after_permission_id is null;
  cursor_valid := cursor_absent
    or (
      p_after_application_root_id is null
      and p_after_owner_kind = 'platform'
      and p_after_owner_id is not null
      and p_after_permission_id is not null
    )
    or (
      p_after_application_root_id is not null
      and p_after_owner_kind in ('application', 'module')
      and p_after_owner_id is not null
      and p_after_permission_id is not null
      and (
        p_after_owner_kind <> 'application'
        or p_after_owner_id = p_after_application_root_id
      )
    );

  if p_page_size is null or p_page_size not between 1 and 100
    or cursor_valid is not true
    or p_after_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_after_owner_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_after_permission_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization permission catalogue page input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_permissions_administration_scope() as authorized;

  with candidates as (
    select entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id, entry.permission_key, entry.label, entry.description,
      entry.record_type_id, entry.action_kind, entry.named_action,
      entry.administrative,
      pg_catalog.row_number() over (
        order by entry.application_root_id asc nulls last,
          entry.owner_kind, entry.owner_id, entry.permission_id
      ) as ordinal
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
    where entry.organization_id = scope.organization_id
      and registration.state = 'active'
      and (
        cursor_absent
        or (
          p_after_application_root_id is not null
          and (
            entry.application_root_id is null
            or (
              entry.application_root_id is not null
              and (
                entry.application_root_id, entry.owner_kind,
                entry.owner_id, entry.permission_id
              ) > (
                p_after_application_root_id, p_after_owner_kind,
                p_after_owner_id, p_after_permission_id
              )
            )
          )
        )
        or (
          p_after_application_root_id is null
          and entry.application_root_id is null
          and (entry.owner_kind, entry.owner_id, entry.permission_id)
            > (p_after_owner_kind, p_after_owner_id, p_after_permission_id)
        )
      )
    order by entry.application_root_id asc nulls last,
      entry.owner_kind, entry.owner_id, entry.permission_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(
          pg_catalog.jsonb_build_object(
            'reference', pg_catalog.jsonb_strip_nulls(
              pg_catalog.jsonb_build_object(
                'applicationRootId', candidate.application_root_id,
                'ownerKind', candidate.owner_kind,
                'ownerId', candidate.owner_id,
                'permissionId', candidate.permission_id
              )
            ),
            'key', candidate.permission_key,
            'label', candidate.label,
            'description', candidate.description,
            'recordTypeId', candidate.record_type_id,
            'action', pg_catalog.jsonb_strip_nulls(
              pg_catalog.jsonb_build_object(
                'actionKind', candidate.action_kind,
                'namedAction', candidate.named_action
              )
            ),
            'administrative', candidate.administrative
          )
        ) order by candidate.application_root_id asc nulls last,
          candidate.owner_kind, candidate.owner_id, candidate.permission_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.application_root_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.array_agg(candidate.owner_kind order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.array_agg(candidate.owner_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.array_agg(candidate.permission_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into permission_items, page_application_root_ids, page_owner_kinds,
    page_owner_ids, page_permission_ids, candidate_count
  from candidates as candidate;

  return query select scope.organization_id, permission_items,
    case when candidate_count > p_page_size
      then page_application_root_ids[p_page_size] else null end,
    case when candidate_count > p_page_size
      then page_owner_kinds[p_page_size] else null end,
    case when candidate_count > p_page_size
      then page_owner_ids[p_page_size] else null end,
    case when candidate_count > p_page_size
      then page_permission_ids[p_page_size] else null end,
    scope.access_version;
end
$function$;

create function vortex_access.read_organization_permission_for_administration(
  p_application_root_id uuid,
  p_owner_kind text,
  p_owner_id uuid,
  p_permission_id uuid
)
returns table (
  organization_id uuid,
  outcome text,
  permission_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  permission_value jsonb;
begin
  if p_owner_id is null or p_permission_id is null
    or p_owner_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_permission_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (
      (
        p_application_root_id is null
        and p_owner_kind = 'platform'
      )
      or (
        p_application_root_id is not null
        and p_owner_kind in ('application', 'module')
        and (
          p_owner_kind <> 'application'
          or p_owner_id = p_application_root_id
        )
      )
    ) is not true then
    raise exception using errcode = '22023',
      message = 'Organization permission catalogue detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_permissions_administration_scope() as authorized;

  select pg_catalog.jsonb_strip_nulls(
    pg_catalog.jsonb_build_object(
      'reference', pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object(
          'applicationRootId', entry.application_root_id,
          'ownerKind', entry.owner_kind,
          'ownerId', entry.owner_id,
          'permissionId', entry.permission_id
        )
      ),
      'key', entry.permission_key,
      'label', entry.label,
      'description', entry.description,
      'recordTypeId', entry.record_type_id,
      'action', pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object(
          'actionKind', entry.action_kind,
          'namedAction', entry.named_action
        )
      ),
      'administrative', entry.administrative
    )
  )
  into permission_value
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_registrations as registration
    on registration.organization_id = entry.organization_id
    and registration.registration_kind = entry.registration_kind
    and registration.registration_owner_id = entry.registration_owner_id
    and registration.revision = entry.registration_revision
  where entry.organization_id = scope.organization_id
    and registration.state = 'active'
    and entry.application_root_id is not distinct from p_application_root_id
    and entry.owner_kind = p_owner_kind
    and entry.owner_id = p_owner_id
    and entry.permission_id = p_permission_id;

  return query select scope.organization_id,
    case when permission_value is null then 'unavailable' else 'available' end,
    permission_value, scope.access_version;
end
$function$;

revoke execute on function vortex_access.organization_permissions_administration_scope()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.list_organization_permissions_for_administration(uuid, text, uuid, uuid, integer)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.read_organization_permission_for_administration(uuid, text, uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.list_organization_permissions_for_administration(uuid, text, uuid, uuid, integer)
to vortex_request;
grant execute on function
  vortex_access.read_organization_permission_for_administration(uuid, text, uuid, uuid)
to vortex_request;

comment on function vortex_access.organization_permissions_administration_scope() is
  'Private fixed permissions-read authorization for the current registered permission catalogue.';
comment on function
  vortex_access.list_organization_permissions_for_administration(uuid, text, uuid, uuid, integer) is
  'Returns one bounded current permission-catalogue page without internal registration evidence.';
comment on function
  vortex_access.read_organization_permission_for_administration(uuid, text, uuid, uuid) is
  'Returns one safe current permission-catalogue detail under the fixed permissions-read decision.';
