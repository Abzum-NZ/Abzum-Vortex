create or replace function vortex_platform.flow_pin_acquisition(
  p_action text, p_command_id uuid, p_run_id uuid, p_task_path text, p_iteration text,
  p_selector jsonb, p_identity jsonb
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  ctx jsonb := vortex_access.validated_human_request_context();
  org uuid := (ctx ->> 'organizationId')::uuid;
  person uuid := (ctx ->> 'identityId')::uuid;
  app uuid := (ctx ->> 'applicationRootId')::uuid;
  held vortex_platform.flow_effect_ledger%rowtype;
  target uuid;
  roots uuid[];
  payload jsonb;
  receipt_status text;
begin
  if p_action is null or p_action not in ('read_source', 'prepare', 'read_target', 'complete')
    or p_command_id is null or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or p_run_id is null or not vortex_platform.is_non_nil_uuid(p_run_id::text)
    or app is null or not vortex_platform.is_non_nil_uuid(app::text) then
    return pg_catalog.jsonb_build_object('status', 'unavailable');
  end if;
  -- Serialize the receipt check and ledger update with the gate's command lock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(org::text || ':flow_segment:' || p_command_id::text, 818)
  );
  receipt_status := vortex_record.flow_segment_receipt(p_command_id, true) ->> 'status';
  if (p_action = 'prepare' and receipt_status is distinct from 'pending')
    or (p_action <> 'prepare' and receipt_status not in ('pending', 'completed')) then
    return pg_catalog.jsonb_build_object('status', 'unavailable');
  end if;
  begin
  select ledger.* into strict held
  from vortex_platform.flow_effect_ledger as ledger
  where ledger.run_id = p_run_id and ledger.organization_id = org
    and ledger.identity_id = person and ledger.principal_kind = 'person'
    and ledger.principal_id = person and ledger.origin_kind = 'person'
    and ledger.origin_id = person and ledger.outputs ->> 'commandId' = p_command_id::text
  for update;
  exception when no_data_found then held := null;
  end;
  if held.run_id is not null then
    if (p_action in ('read_source', 'prepare') and held.outputs ->> 'sourceApplicationRootId' is distinct from app::text)
      or (p_action in ('read_target', 'complete') and held.outputs ->> 'targetApplicationRootId' is distinct from app::text) then
      return pg_catalog.jsonb_build_object('status', 'unavailable');
    end if;
    if p_action = 'complete' and held.state = 'started' then
      if p_identity is null or pg_catalog.jsonb_typeof(p_identity) <> 'object'
        or pg_catalog.pg_column_size(p_identity) > 4096
        or pg_catalog.lower(p_identity ->> 'organizationId') is distinct from org::text
        or pg_catalog.lower(p_identity ->> 'applicationRootId') is distinct from app::text
        or pg_catalog.lower(p_identity ->> 'recordId') is distinct from pg_catalog.lower(held.outputs #>> '{selector,recordId}')
        or not vortex_platform.is_non_nil_uuid(p_identity ->> 'moduleRootId')
        or not vortex_platform.is_non_nil_uuid(p_identity ->> 'recordTypeId')
        or not vortex_platform.is_non_nil_uuid(p_identity ->> 'storageContractId')
        or pg_catalog.jsonb_typeof(p_identity -> 'moduleReleaseRevision') is distinct from 'number' then
        raise exception using errcode = '22023', message = 'Flow pin identity is invalid';
      end if;
      update vortex_platform.flow_effect_ledger as ledger
      set state = 'completed', outcome = 'completed',
          outputs = held.outputs || pg_catalog.jsonb_build_object('identity', p_identity),
          completed_at = pg_catalog.statement_timestamp()
      where ledger.run_id = held.run_id and ledger.task_path = held.task_path
        and ledger.iteration = held.iteration;
      held.state := 'completed';
      held.outputs := held.outputs || pg_catalog.jsonb_build_object('identity', p_identity);
    end if;
    return pg_catalog.jsonb_build_object('status', held.state, 'target', held.outputs);
  end if;
  if p_action <> 'prepare' then return pg_catalog.jsonb_build_object('status', 'none'); end if;
  if p_task_path is null or pg_catalog.length(p_task_path) not between 1 and 1000
    or p_iteration is null or pg_catalog.length(p_iteration) not between 1 and 200
    or p_selector is null or pg_catalog.jsonb_typeof(p_selector) <> 'object'
    or pg_catalog.pg_column_size(p_selector) > 4096
    or p_selector ->> 'recordId' is null
    or not vortex_platform.is_non_nil_uuid(p_selector ->> 'recordId')
    or pg_catalog.jsonb_typeof(p_selector -> 'applicationKey') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_selector -> 'recordTypeKey') is distinct from 'string' then
    raise exception using errcode = '22023', message = 'Flow pin selector is invalid';
  end if;
  select pg_catalog.array_agg(distinct root.root_id) into roots
  from vortex_definition.roots as root
  join vortex_definition.installation_bindings as binding
    on binding.organization_id = org and binding.application_root_id = root.root_id
    and binding.state = 'active'
  join vortex_access.permission_registrations as registration
    on registration.organization_id = org and registration.registration_owner_id = root.root_id
    and registration.registration_kind = 'application' and registration.state = 'active'
    and registration.source_revision = binding.application_release_revision
    and registration.source_definition_key = root.key
  join vortex_definition.releases as release
    on release.root_id = root.root_id and release.release_revision = registration.source_revision
    and release.release_version = registration.source_version
    and release.validation_contract_version = registration.validation_contract_version
    and release.application_address ->> 'kind' = 'application'
  where root.organization_id = org and root.kind = 'application'
    and root.key = p_selector ->> 'applicationKey';
  if coalesce(pg_catalog.cardinality(roots), 0) <> 1 then
    return pg_catalog.jsonb_build_object('status', 'unavailable');
  end if;
  target := roots[1];
  payload := pg_catalog.jsonb_build_object('commandId', p_command_id,
    'sourceApplicationRootId', app, 'targetApplicationRootId', target, 'selector', p_selector);
  insert into vortex_platform.flow_effect_ledger (
    run_id, task_path, iteration, organization_id, identity_id, principal_kind,
    principal_id, origin_kind, origin_id, state, outputs, started_at
  ) values (
    p_run_id, p_task_path, p_iteration, org, person, 'person', person, 'person', person,
    'started', payload, pg_catalog.statement_timestamp()
  );
  return pg_catalog.jsonb_build_object('status', 'started', 'target', payload);
end
$function$;

alter function vortex_platform.flow_pin_acquisition(text, uuid, uuid, text, text, jsonb, jsonb) owner to vortex_owner;
revoke all on function vortex_platform.flow_pin_acquisition(text, uuid, uuid, text, text, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.flow_pin_acquisition(text, uuid, uuid, text, text, jsonb, jsonb)
  to vortex_request, postgres;
comment on function vortex_platform.flow_pin_acquisition(text, uuid, uuid, text, text, jsonb, jsonb) is
  'Binds a flow pin to one target and records its acquisition for the current human request.';
