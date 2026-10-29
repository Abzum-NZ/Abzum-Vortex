create or replace function vortex_access.flow_run_evidence(
  p_action text, p_run_id uuid, p_flow_id uuid, p_binding_id uuid, p_command_id uuid
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  v_organization_id uuid := (context_value ->> 'organizationId')::uuid;
  v_identity_id uuid := (context_value ->> 'identityId')::uuid;
  v_application_root_id uuid := (context_value ->> 'applicationRootId')::uuid;
  v_run_id uuid;
  held record;
begin
  if p_action is null or p_action not in ('start', 'lock', 'pending', 'succeeded', 'refused', 'failed', 'close')
    or not vortex_platform.is_non_nil_uuid(p_flow_id::text)
    or not vortex_platform.is_non_nil_uuid(p_binding_id::text)
    or not vortex_platform.is_non_nil_uuid(v_application_root_id::text)
    or (p_action <> 'start' and not vortex_platform.is_non_nil_uuid(p_run_id::text))
    or (p_action in ('pending', 'close') and not vortex_platform.is_non_nil_uuid(p_command_id::text)) then
    raise exception using errcode = '22023', message = 'Flow run evidence is invalid';
  end if;
  if p_action = 'start' then
    delete from vortex_access.flow_run_evidence as stale
    where stale.ctid in (
      select candidate.ctid from vortex_access.flow_run_evidence as candidate
      where candidate.expires_at < pg_catalog.statement_timestamp() - interval '1 day'
      limit 100
    );
    v_run_id := pg_catalog.gen_random_uuid();
    insert into vortex_access.flow_run_evidence (
      run_id, organization_id, identity_id, application_root_id, flow_id, binding_id,
      state, expires_at
    ) values (
      v_run_id, v_organization_id, v_identity_id, v_application_root_id, p_flow_id, p_binding_id,
      'started', pg_catalog.statement_timestamp() + interval '15 minutes'
    );
    return pg_catalog.jsonb_build_object('runId', v_run_id, 'state', 'started');
  end if;
  select evidence.state, evidence.pending_command_id, evidence.completion_command_id into held
  from vortex_access.flow_run_evidence as evidence
  where evidence.run_id = p_run_id
    and evidence.organization_id = v_organization_id
    and evidence.identity_id = v_identity_id
    and evidence.application_root_id = v_application_root_id
    and evidence.flow_id = p_flow_id
    and evidence.binding_id = p_binding_id
    and evidence.expires_at > pg_catalog.statement_timestamp()
  for update;
  if not found then return pg_catalog.jsonb_build_object('state', 'unavailable'); end if;
  if p_action = 'lock' then
    return pg_catalog.jsonb_build_object(
      'state', held.state, 'pendingCommandId', held.pending_command_id,
      'completionCommandId', held.completion_command_id
    );
  end if;
  if held.state = 'closed' then
    return pg_catalog.jsonb_build_object('state', case
      when p_action = 'close' and held.completion_command_id = p_command_id then 'closed'
      else 'unavailable' end);
  end if;
  if held.state = 'pending' and held.pending_command_id is distinct from p_command_id then
    return pg_catalog.jsonb_build_object('state', 'unavailable');
  end if;
  if p_action = 'close' and held.state not in ('started', 'succeeded') then
    return pg_catalog.jsonb_build_object('state', 'unavailable');
  end if;
  update vortex_access.flow_run_evidence as evidence
  set state = case when p_action = 'close' then 'closed' else p_action end,
      pending_command_id = case when p_action = 'pending' then p_command_id else null end,
      completion_command_id = case when p_action = 'close' then p_command_id else null end,
      expires_at = pg_catalog.statement_timestamp() + interval '15 minutes'
  where evidence.run_id = p_run_id;
  return pg_catalog.jsonb_build_object('state', case when p_action = 'close' then 'closed' else p_action end);
end
$function$;

alter function vortex_access.flow_run_evidence(text, uuid, uuid, uuid, uuid) owner to vortex_owner;
revoke all on function vortex_access.flow_run_evidence(text, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.flow_run_evidence(text, uuid, uuid, uuid, uuid)
  to vortex_request, postgres;
comment on function vortex_access.flow_run_evidence(text, uuid, uuid, uuid, uuid) is
  'Maintains expiring flow completion evidence under the verified caller and application scope.';
