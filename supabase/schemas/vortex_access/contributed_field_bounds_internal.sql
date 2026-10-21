create or replace function vortex_access.contributed_field_bounds_internal(
  p_decision jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  decision_organization_id uuid;
begin
  if p_decision is null or p_decision ->> 'outcome' is distinct from 'allowed' then
    raise exception using errcode = '22023',
      message = 'Contributed field bounds require an allowed record decision';
  end if;
  -- A decision that names no record binding concerns no owner record type, so nothing is
  -- contributed to it.
  if not pg_catalog.pg_input_is_valid(p_decision ->> 'organizationId', 'uuid')
    or not pg_catalog.pg_input_is_valid(p_decision #>> '{recordBinding,moduleRootId}', 'uuid')
    or not pg_catalog.pg_input_is_valid(p_decision #>> '{recordBinding,storageContractId}', 'uuid') then
    return '{"readableFieldIds":[],"changeableFieldIds":[]}'::jsonb;
  end if;
  decision_organization_id := (p_decision ->> 'organizationId')::uuid;

  -- The owner record's own decision already admitted this record under the owner's permissions;
  -- the contributor rule itself lives in one place.
  return vortex_access.contributor_field_grants_internal(
    decision_organization_id,
    (p_decision #>> '{recordBinding,moduleRootId}')::uuid,
    (p_decision #>> '{recordBinding,storageContractId}')::uuid,
    case when p_decision #>> '{action,actionKind}' = 'update' then 'update' else 'read' end
  );
end
$function$;

alter function vortex_access.contributed_field_bounds_internal(jsonb) owner to vortex_owner;

revoke all on function vortex_access.contributed_field_bounds_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.contributed_field_bounds_internal(jsonb)
  to vortex_owner;

comment on function vortex_access.contributed_field_bounds_internal(jsonb) is
  'Private contributed-field bounds over one allowed exact-record decision: the fields other installed Modules contributed to the record''s type that the person may read and change through a current permission the contributor declared for them. It adds only to a decision the owner''s permissions already allowed and never decides record access.';
