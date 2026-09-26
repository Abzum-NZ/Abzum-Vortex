create or replace function vortex_access.list_organization_role_assignments_projection(
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
  checked_at timestamptz;
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- platform.organization.assignments.read decision the bespoke assignment
  -- ledger administration reader applies is the only visibility, and the
  -- caller's current organisation is never an input. A viewer the decision
  -- refuses sees no rows, exactly as a missing or foreign record, so the record
  -- adapters return their identical refusal and a list page is empty rather than
  -- failing. The record identity is the assignment, the revision is the
  -- assignment's own revision and the attribute names are the lowercase field
  -- keys a projection record type declares. The temporal state is descriptive
  -- and grants no permission; grant and revocation evidence is never projected.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_assignment_ledger_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  checked_at := pg_catalog.statement_timestamp();
  return query
  select
    scope_row.organization_id,
    assignment.role_assignment_id,
    assignment.revision,
    pg_catalog.jsonb_build_object(
      'role_id', assignment.role_id,
      'role_key', role_revision.role_key,
      'role_label', role_revision.label,
      'assignee_kind', assignment.assignee_kind,
      'organization_account_id', assignment.organization_account_id,
      'group_id', assignment.group_id,
      'assignment_kind', assignment.assignment_kind,
      'starts_at', assignment.starts_at,
      'expires_at', assignment.expires_at,
      'state', assignment.state,
      'temporal_state', case
        when assignment.state = 'revoked' then 'revoked'
        when assignment.starts_at > checked_at then 'scheduled'
        when assignment.expires_at is not null
          and assignment.expires_at <= checked_at then 'expired'
        else 'active'
      end
    )
  from vortex_access.organization_role_assignments as assignment
  join vortex_access.organization_roles as role
    on role.organization_id = assignment.organization_id
    and role.role_id = assignment.role_id
  join vortex_access.organization_role_revisions as role_revision
    on role_revision.organization_id = role.organization_id
    and role_revision.role_id = role.role_id
    and role_revision.revision = role.live_revision
  where assignment.organization_id = scope_row.organization_id
    and (p_record_id is null or p_record_id = assignment.role_assignment_id)
  order by assignment.role_assignment_id;
end
$function$;

revoke all on function vortex_access.list_organization_role_assignments_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_role_assignments_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_role_assignments_projection(uuid, integer) is
  'Registered role-assignment projection: returns every current standing or eligible assignment of the viewer''s organisation under the fixed platform.organization.assignments.read decision, with the organisation, the assignment identity, the assignment revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer. Grant and revocation evidence is never projected.';
