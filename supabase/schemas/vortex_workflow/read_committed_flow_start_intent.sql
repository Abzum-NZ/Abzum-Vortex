create or replace function vortex_workflow.read_committed_flow_start_intent(
  p_intent_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  stored record;
begin
  if not vortex_context.is_non_nil_uuid(p_intent_id::text) then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  select
    intent.intent_id,
    intent.organization_id,
    intent.application_root_id,
    intent.application_release_revision,
    intent.application_release_version,
    intent.flow_owner_kind,
    intent.flow_owner_root_id,
    intent.flow_release_revision,
    intent.flow_release_version,
    intent.flow_release_fingerprint,
    intent.flow_id,
    intent.source_kind,
    intent.source_id,
    intent.trigger_type,
    intent.trigger_id,
    intent.inputs,
    intent.trigger_values,
    intent.caller,
    intent.status,
    intent.accepted_at
  into stored
  from vortex_workflow.flow_start_intents as intent
  where intent.intent_id = p_intent_id
    and intent.status = 'pending';

  if not found then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  if stored.source_kind <> 'event'
    or stored.trigger_type <> 'Event'
    or stored.caller ->> 'kind' is distinct from 'event'
    or stored.caller ->> 'correlationId' is null
    or not vortex_context.is_non_nil_uuid(stored.caller ->> 'correlationId') then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  return pg_catalog.jsonb_build_object(
    'kind', 'available',
    'intent', pg_catalog.jsonb_build_object(
      'intentId', stored.intent_id,
      'organizationId', stored.organization_id,
      'applicationRootId', stored.application_root_id,
      'applicationReleaseRevision', stored.application_release_revision,
      'applicationReleaseVersion', stored.application_release_version,
      'flowRelease', pg_catalog.jsonb_build_object(
        'ownerKind', stored.flow_owner_kind,
        'rootId', stored.flow_owner_root_id,
        'revision', stored.flow_release_revision,
        'version', stored.flow_release_version,
        'fingerprint', stored.flow_release_fingerprint
      ),
      'flowId', stored.flow_id,
      'origin', 'event',
      'originId', stored.source_id,
      'trigger', pg_catalog.jsonb_build_object(
        'type', 'Event',
        'id', stored.trigger_id
      ),
      'inputs', stored.inputs,
      'triggerValues', stored.trigger_values,
      'correlationId', stored.caller ->> 'correlationId',
      'acceptedAt', stored.accepted_at
    )
  );
end
$function$;

alter function vortex_workflow.read_committed_flow_start_intent(uuid)
  owner to vortex_workflow_owner;

revoke all on function vortex_workflow.read_committed_flow_start_intent(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_workflow.read_committed_flow_start_intent(uuid)
  to vortex_runtime;

comment on function vortex_workflow.read_committed_flow_start_intent(uuid) is
  'Runtime-only read of one committed pending Event start intent, including its exact accepted release and persisted origin; absent, action-based and malformed starts return one neutral unavailable result.';
