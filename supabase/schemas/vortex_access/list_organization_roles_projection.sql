create or replace function vortex_access.list_organization_roles_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- platform.organization.roles.read decision the bespoke role catalogue
  -- administration reader applies is the only visibility, and the caller's
  -- current organisation is never an input. A viewer the decision refuses sees
  -- no rows, exactly as a missing or foreign record, so the record adapters
  -- return their identical refusal and a list page is empty rather than failing.
  -- The record identity is the role, the revision is the role's own live revision
  -- and the attribute names are the lowercase field keys a projection record type
  -- declares. Role identity, key, label, lifecycle, kind, privilege
  -- classification, assignment policy and accepted permission count are the only
  -- facts projected; acceptance evidence and audit columns stay in the protected
  -- storage.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_roles_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  return query
  select
    scope_row.organization_id,
    role.role_id,
    role.live_revision,
    pg_catalog.jsonb_build_object(
      'key', role_revision.role_key,
      'label', role_revision.label,
      'lifecycle', role_revision.lifecycle,
      'role_kind', role.role_kind,
      'privilege_classification', role_revision.privilege_classification,
      'assignment_policy', role_revision.assignment_policy,
      'accepted_permission_count', (
        select pg_catalog.count(*)
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = role_revision.organization_id
          and permission.role_id = role_revision.role_id
          and permission.role_revision = role_revision.revision
      )
    )
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as role_revision
    on role_revision.organization_id = role.organization_id
    and role_revision.role_id = role.role_id
    and role_revision.revision = role.live_revision
  where role.organization_id = scope_row.organization_id
    and (p_record_id is null or p_record_id = role.role_id)
  order by role.role_id;
end
$function$;

revoke all on function vortex_access.list_organization_roles_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_roles_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_roles_projection(uuid, integer) is
  'Registered role projection: returns every current local role the fixed platform.organization.roles.read decision admits, with the organisation, the role identity, the role live revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer. Acceptance evidence and audit columns are never projected.';
