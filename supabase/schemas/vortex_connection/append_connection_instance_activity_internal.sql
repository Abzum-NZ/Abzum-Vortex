create or replace function vortex_connection.append_connection_instance_activity_internal(
  p_context jsonb,
  p_activity_id uuid,
  p_connection_instance_id uuid,
  p_action text,
  p_occurred_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  actor_kind text;
  actor_id uuid;
begin
  if p_context ->> 'callerKind' = 'human' then
    actor_kind := 'organization_account';
    actor_id := (p_context ->> 'organizationAccountId')::uuid;
  elsif p_context ->> 'callerKind' = 'system' then
    actor_kind := 'system';
    actor_id := (p_context ->> 'systemActorId')::uuid;
  else
    raise exception using
      errcode = '42501',
      message = 'Connection Activity requires validated human or system context';
  end if;

  perform vortex_activity.append_organization_activity_entry(
    (p_context ->> 'organizationId')::uuid,
    p_activity_id,
    p_occurred_at,
    actor_kind,
    actor_id,
    p_action,
    array[p_connection_instance_id],
    array[]::uuid[],
    'connection',
    (p_context ->> 'correlationId')::uuid,
    'completed'
  );
end
$function$;

revoke all on function vortex_connection.append_connection_instance_activity_internal(jsonb, uuid, uuid, text, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_connection.append_connection_instance_activity_internal(jsonb, uuid, uuid, text, timestamp with time zone) to vortex_connection_owner;

comment on function vortex_connection.append_connection_instance_activity_internal(jsonb, uuid, uuid, text, timestamp with time zone) is null;
