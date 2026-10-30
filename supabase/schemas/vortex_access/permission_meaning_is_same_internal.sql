create or replace function vortex_access.permission_meaning_is_same_internal(
  p_left vortex_access.permission_catalogue_entries,
  p_right vortex_access.permission_catalogue_entries
) returns boolean
language sql immutable security invoker set search_path = ''
as $function$
  select row(
    (p_left).owner_kind, (p_left).owner_id, (p_left).permission_id, (p_left).permission_key,
    (p_left).record_type_id, (p_left).action_kind, (p_left).named_action, (p_left).administrative,
    (p_left).record_scope, (p_left).field_policy
  ) is not distinct from row(
    (p_right).owner_kind, (p_right).owner_id, (p_right).permission_id, (p_right).permission_key,
    (p_right).record_type_id, (p_right).action_kind, (p_right).named_action, (p_right).administrative,
    (p_right).record_scope, (p_right).field_policy
  );
$function$;

alter function vortex_access.permission_meaning_is_same_internal(
  vortex_access.permission_catalogue_entries, vortex_access.permission_catalogue_entries
) owner to vortex_owner;
revoke all on function vortex_access.permission_meaning_is_same_internal(
  vortex_access.permission_catalogue_entries, vortex_access.permission_catalogue_entries
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.permission_meaning_is_same_internal(
  vortex_access.permission_catalogue_entries, vortex_access.permission_catalogue_entries
) to postgres;
