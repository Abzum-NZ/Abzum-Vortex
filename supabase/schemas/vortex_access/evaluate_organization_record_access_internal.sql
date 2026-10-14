create or replace function vortex_access.evaluate_organization_record_access_internal(
  p_declaration jsonb,
  p_target_record_id uuid,
  p_facts jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  return vortex_access.evaluate_organization_record_access_with_eligibility_internal(
    p_declaration, p_target_record_id, p_facts, null
  );
end
$function$;

revoke execute on function vortex_access.evaluate_organization_record_access_internal(jsonb, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.evaluate_organization_record_access_internal(jsonb, uuid, jsonb)
  to vortex_record_adapter;
comment on function vortex_access.evaluate_organization_record_access_internal(jsonb, uuid, jsonb) is
  'The complete exact-record access decision: unions every eligible alternative''s own complete row scope and always carries the exact recordId. Owner-only except for the fixed record adapter.';

alter function vortex_access.evaluate_organization_record_access_internal(p_declaration jsonb, p_target_record_id uuid, p_facts jsonb) owner to vortex_owner;

grant execute on function vortex_access.evaluate_organization_record_access_internal(p_declaration jsonb, p_target_record_id uuid, p_facts jsonb) to postgres;
