create or replace function vortex_connection.append_application_grant_activity_internal(
  p_context jsonb,
  p_activity_id uuid,
  p_connection_instance_id uuid,
  p_application_root_id uuid,
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
  subject_ids uuid[];
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
      message = 'Connection grant Activity requires validated human or system context';
  end if;

  select pg_catalog.array_agg(subject_id order by subject_id)
  into subject_ids
  from (
    select distinct candidate.subject_id
    from pg_catalog.unnest(array[p_connection_instance_id, p_application_root_id])
      as candidate(subject_id)
  ) as canonical_subjects;

  perform vortex_activity.append_organization_activity_entry(
    (p_context ->> 'organizationId')::uuid,
    p_activity_id,
    p_occurred_at,
    actor_kind,
    actor_id,
    p_action,
    subject_ids,
    array[]::uuid[],
    'connection',
    (p_context ->> 'correlationId')::uuid,
    'completed'
  );
end;
$function$;

revoke all on function vortex_connection.append_application_grant_activity_internal(jsonb, uuid, uuid, uuid, text, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_connection.append_application_grant_activity_internal(jsonb, uuid, uuid, uuid, text, timestamp with time zone) to vortex_connection_owner;

comment on function vortex_connection.append_application_grant_activity_internal(jsonb, uuid, uuid, uuid, text, timestamp with time zone) is null;
