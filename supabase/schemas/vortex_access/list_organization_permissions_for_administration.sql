create or replace function vortex_access.list_organization_permissions_for_administration(
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

revoke execute on function
  vortex_access.list_organization_permissions_for_administration(uuid, text, uuid, uuid, integer)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.list_organization_permissions_for_administration(uuid, text, uuid, uuid, integer)
to vortex_request;

comment on function
  vortex_access.list_organization_permissions_for_administration(uuid, text, uuid, uuid, integer) is
  'Returns one bounded current permission-catalogue page without internal registration evidence.';

alter function vortex_access.list_organization_permissions_for_administration(
  uuid, text, uuid, uuid, integer
) owner to vortex_access_owner;
