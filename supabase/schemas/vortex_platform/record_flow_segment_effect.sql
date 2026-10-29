create or replace function vortex_platform.record_flow_segment_effect(
  p_run_id uuid, p_task_path text, p_iteration text, p_outcome text, p_outputs jsonb
)
returns void
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  identity_id_value uuid := (context_value ->> 'identityId')::uuid;
begin
  if p_run_id is null or not vortex_platform.is_non_nil_uuid(p_run_id::text)
    or p_task_path is null or pg_catalog.length(p_task_path) not between 1 and 1000
    or p_iteration is null or pg_catalog.length(p_iteration) not between 1 and 200
    or p_outcome is null or p_outcome not in (
      'completed', 'committed', 'background_pending', 'refused', 'conflict', 'validation',
      'uncertain', 'failed'
    )
    or p_outputs is null or pg_catalog.jsonb_typeof(p_outputs) <> 'object'
    or pg_catalog.pg_column_size(p_outputs) > 65536 then
    raise exception using errcode = '22023', message = 'Flow segment effect is invalid';
  end if;
  insert into vortex_platform.flow_effect_ledger (
    run_id, task_path, iteration, organization_id, identity_id, principal_kind, principal_id,
    origin_kind, origin_id, state, outcome, outputs, started_at, completed_at
  ) values (
    p_run_id, p_task_path, p_iteration, (context_value ->> 'organizationId')::uuid,
    identity_id_value, 'person', identity_id_value, 'person', identity_id_value,
    'completed', p_outcome, p_outputs, pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp()
  );
end
$function$;

alter function vortex_platform.record_flow_segment_effect(uuid, text, text, text, jsonb) owner to vortex_owner;
revoke all on function vortex_platform.record_flow_segment_effect(uuid, text, text, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.record_flow_segment_effect(uuid, text, text, text, jsonb)
  to vortex_request, postgres;
comment on function vortex_platform.record_flow_segment_effect(uuid, text, text, text, jsonb) is
  'Records a completed human flow effect within the current admitted segment transaction.';
