create or replace function vortex_access.read_organization_permission_for_administration(
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

revoke execute on function
  vortex_access.read_organization_permission_for_administration(uuid, text, uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.read_organization_permission_for_administration(uuid, text, uuid, uuid)
to vortex_request;

comment on function
  vortex_access.read_organization_permission_for_administration(uuid, text, uuid, uuid) is
  'Returns one safe current permission-catalogue detail under the fixed permissions-read decision.';

alter function vortex_access.read_organization_permission_for_administration(
  uuid, text, uuid, uuid
) owner to vortex_access_owner;
