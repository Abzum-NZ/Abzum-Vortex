create or replace function vortex_access.list_organization_role_activations_projection(
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
  -- platform.organization.assignments.read decision the bespoke activation
  -- administration reader applies is the only visibility, and the caller's
  -- current organisation is never an input. A viewer the decision refuses sees
  -- no rows, exactly as a missing or foreign record, so the record adapters
  -- return their identical refusal and a list page is empty rather than failing.
  -- The record identity is the activation, the revision is the activation's own
  -- revision and the attribute names are the lowercase field keys a projection
  -- record type declares. The temporal state is descriptive and grants no
  -- permission; policy provenance, caller bindings and audit evidence are never
  -- projected.
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
    activation.role_activation_id,
    activation.revision,
    pg_catalog.jsonb_build_object(
      'organization_account_id', activation.organization_account_id,
      'account_display_name', account.display_name,
      'role_id', activation.role_id,
      'role_key', role_revision.role_key,
      'role_label', role_revision.label,
      'eligibility_source_kind', activation.eligibility_source_kind,
      'activated_at', activation.activated_at,
      'expires_at', activation.expires_at,
      'state', activation.state,
      'temporal_state', case
        when activation.state = 'revoked' then 'revoked'
        when activation.expires_at <= checked_at then 'expired'
        else 'active'
      end
    )
  from vortex_access.organization_role_activations as activation
  join vortex_identity.organization_accounts as account
    on account.organization_id = activation.organization_id
    and account.organization_account_id = activation.organization_account_id
  join vortex_access.organization_roles as role
    on role.organization_id = activation.organization_id
    and role.role_id = activation.role_id
  join vortex_access.organization_role_revisions as role_revision
    on role_revision.organization_id = role.organization_id
    and role_revision.role_id = role.role_id
    and role_revision.revision = role.live_revision
  where activation.organization_id = scope_row.organization_id
    and (p_record_id is null or p_record_id = activation.role_activation_id)
  order by activation.role_activation_id;
end
$function$;

revoke all on function vortex_access.list_organization_role_activations_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_role_activations_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_role_activations_projection(uuid, integer) is
  'Registered role-activation projection: returns every retained activation of the viewer''s organisation under the fixed platform.organization.assignments.read decision, with the organisation, the activation identity, the activation revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer. Policy provenance, caller bindings and audit evidence are never projected.';
