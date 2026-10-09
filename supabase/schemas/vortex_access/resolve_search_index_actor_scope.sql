create or replace function vortex_access.resolve_search_index_actor_scope(p_occurrence_id uuid, p_claim_cursor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  return vortex_access.read_search_index_actor_scope_internal(p_occurrence_id,p_claim_cursor);
end
$function$;
alter function vortex_access.resolve_search_index_actor_scope(uuid,uuid) owner to vortex_access_owner;
revoke all on function vortex_access.resolve_search_index_actor_scope(uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner, vortex_event_owner, vortex_search_owner, vortex_access_owner, vortex_identity_owner;
grant execute on function vortex_access.resolve_search_index_actor_scope(uuid,uuid) to vortex_runtime;
comment on function vortex_access.resolve_search_index_actor_scope(uuid,uuid) is 'Runtime-only fixed Search indexing resolver over the actual retained occurrence and cursor; registry tables and private owner interfaces are not exposed.';
