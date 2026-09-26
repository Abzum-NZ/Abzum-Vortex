create or replace function vortex_record.apply_lifecycle_record_changes(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  -- The request role reaches the one record-change operation's terminal delete,
  -- restore and ownership-transfer writes only through this closed entry. It
  -- accepts exactly those three operations and delegates once, so an ordinary
  -- save or named action can never reach apply_record_changes without its own
  -- preparation and authority.
  if p_operation is null
    or p_operation not in ('delete', 'restore', 'transfer_ownership')
    or pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  return vortex_record.apply_record_changes(
    p_command_id, p_operation, p_record_type_id, p_record_id,
    p_expected_concurrency_number, '{}'::jsonb, null,
    p_mutations, p_activity_id, p_occurrence_id
  );
end
$function$;

revoke all on function vortex_record.apply_lifecycle_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.apply_lifecycle_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_runtime;
comment on function vortex_record.apply_lifecycle_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'The request role''s closed entry to the terminal delete, restore and ownership-transfer record-change writes: it refuses any other operation and delegates once to the one protected apply_record_changes operation.';
