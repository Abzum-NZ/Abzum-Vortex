create or replace function vortex_workflow.accept_flow_start_intent(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_application_release_version text,
  p_flow_owner_kind text,
  p_flow_owner_root_id uuid,
  p_flow_release_revision bigint,
  p_flow_release_version text,
  p_flow_id uuid,
  p_source_kind text,
  p_source_id uuid,
  p_trigger_type text,
  p_trigger_id text,
  p_inputs jsonb,
  p_trigger_values jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  published_flow jsonb;
  published_trigger jsonb;
  flow_release_fingerprint text;
  declarations jsonb;
  supplied jsonb;
  effective_inputs jsonb := '{}'::jsonb;
  effective_trigger_values jsonb := '{}'::jsonb;
  part record;
  declaration record;
  literal jsonb;
  event_envelope jsonb;
  caller jsonb;
  resolved_installation jsonb;
  stored vortex_workflow.flow_start_intents%rowtype;
  inserted boolean := false;
  installation_active boolean := false;
begin
  if p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null
    or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or p_application_release_version is null
    or p_application_release_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or p_flow_owner_kind is null or p_flow_owner_kind not in ('application', 'module')
    or p_flow_owner_root_id is null
    or not vortex_context.is_non_nil_uuid(p_flow_owner_root_id::text)
    or p_flow_release_revision is null
    or p_flow_release_revision not between 1 and 9007199254740991
    or p_flow_release_version is null
    or p_flow_release_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or (p_flow_owner_kind = 'application' and (
      p_flow_owner_root_id <> p_application_root_id
      or p_flow_release_revision <> p_application_release_revision
      or p_flow_release_version <> p_application_release_version
    ))
    or p_flow_id is null or not vortex_context.is_non_nil_uuid(p_flow_id::text)
    or p_source_kind is null or p_source_kind not in ('event', 'action')
    or p_source_id is null or not vortex_context.is_non_nil_uuid(p_source_id::text)
    or p_trigger_type is null or p_trigger_type not in ('run_background', 'Event')
    or p_trigger_id is null or pg_catalog.length(p_trigger_id) not between 1 and 1300
    or p_inputs is null or pg_catalog.jsonb_typeof(p_inputs) <> 'object'
    or p_trigger_values is null or pg_catalog.jsonb_typeof(p_trigger_values) <> 'object'
    or pg_catalog.pg_column_size(p_inputs) > 65536
    or pg_catalog.pg_column_size(p_trigger_values) > 65536
    or (p_trigger_type = 'run_background' and p_source_kind <> 'action')
    or (p_trigger_type = 'Event' and p_source_kind <> 'event') then
    raise exception using errcode = '22023', message = 'Flow start intent is invalid';
  end if;

  context_value := vortex_context.current_context();
  -- A record-free start needs a retained proof of the authorized task invocation.
  -- No such proof exists yet; a request context and caller-chosen UUID cannot stand in for it.
  if p_source_kind = 'action'
    or context_value ->> 'callerKind' is distinct from 'human' then
    raise exception using errcode = '42501', message = 'Flow start authority is unavailable';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if (context_value ->> 'organizationId')::uuid is distinct from p_organization_id
    or (context_value ->> 'applicationRootId')::uuid is distinct from p_application_root_id
    or not exists (
      select 1 from vortex_identity.organizations as organization
      join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
      where organization.organization_id = p_organization_id
        and organization.tenant_id = (context_value ->> 'tenantId')::uuid
        and organization.state = 'active' and tenant.state = 'active'
    ) then
    raise exception using errcode = '42501', message = 'Flow start scope is unavailable';
  end if;

  -- Share locks serialize acceptance with an upgrade, drain or withdrawal.
  perform 1 from vortex_module.installation_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.application_root_id = p_application_root_id
    and binding.application_release_revision = p_application_release_revision
    and binding.state = 'active'
  for share of binding;
  installation_active := found;
  if installation_active then
    resolved_installation := vortex_module.read_current_active_installation();
    installation_active :=
      (resolved_installation ->> 'applicationReleaseRevision')::bigint
        = p_application_release_revision;
  end if;
  if installation_active and p_flow_owner_kind = 'module' and not exists (
    select 1 from vortex_module.installation_bindings as binding
    where binding.organization_id = p_organization_id
      and binding.application_root_id = p_application_root_id
      and binding.application_release_revision = p_application_release_revision
      and binding.module_root_id = p_flow_owner_root_id
      and binding.module_release_revision = p_flow_release_revision
      and binding.state = 'active'
  ) then
    installation_active := false;
  end if;

  perform 1 from vortex_definition.releases as application_release
  join vortex_definition.roots as application_root
    on application_root.root_id = application_release.root_id
  where application_release.root_id = p_application_root_id
    and application_release.release_revision = p_application_release_revision
    and application_release.release_version = p_application_release_version
    and application_root.organization_id = p_organization_id
    and application_root.kind = 'application'
  for key share of application_release, application_root;
  if not found then
    raise exception using errcode = '55000', message = 'Application release is unavailable';
  end if;

  select release.content_fingerprint, published.value
  into flow_release_fingerprint, published_flow
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  cross join lateral pg_catalog.jsonb_array_elements(
    case when pg_catalog.jsonb_typeof(release.compilation_output #> '{canonical,content,flows}') = 'array'
      then release.compilation_output #> '{canonical,content,flows}'
      else '[]'::jsonb end
  ) as published(value)
  where release.root_id = p_flow_owner_root_id
    and release.release_revision = p_flow_release_revision
    and release.release_version = p_flow_release_version
    and root.organization_id = p_organization_id
    and root.kind = p_flow_owner_kind
    and published.value ->> 'id' = p_flow_id::text
  for key share of release, root;
  if not found then
    raise exception using errcode = '55000', message = 'Published flow is unavailable';
  end if;

  if p_trigger_type = 'run_background' then
    if published_flow ->> 'execution' is distinct from 'durable'
      or published_flow #>> '{runAs,kind}' is distinct from 'initiator'
      or p_trigger_values <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Background flow start is invalid';
    end if;
  else
    if published_flow ->> 'execution' is distinct from 'background'
      or coalesce(published_flow #>> '{runAs,kind}', '')
        not in ('specified_account', 'system')
      or published_flow ? 'invocationPermissionId'
      or p_inputs <> '{}'::jsonb
      or p_trigger_values <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Event flow start is invalid';
    end if;
    select start_trigger.value into published_trigger
    from pg_catalog.jsonb_array_elements(published_flow -> 'triggers') as start_trigger(value)
    where start_trigger.value ->> 'id' = p_trigger_id
      and start_trigger.value ->> 'type' = p_trigger_type;
    if not found then
      raise exception using errcode = '55000', message = 'Published flow trigger is unavailable';
    end if;
    if published_trigger ? 'condition' then
      raise exception using errcode = '55000', message = 'Event trigger condition is unavailable';
    end if;
  end if;

  -- Pin defaults and every supplied value against the exact published declarations.
  for part in select 'inputs'::text as name, published_flow -> 'inputs' as declared,
      p_inputs as supplied_values
    union all
    select 'trigger', published_trigger -> 'inputs', p_trigger_values
  loop
    declarations := coalesce(part.declared, '{}'::jsonb);
    supplied := part.supplied_values;
    if pg_catalog.jsonb_typeof(declarations) <> 'object'
      or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied)) > 100
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied) as key(name)
        where not declarations ? key.name
      ) then
      raise exception using errcode = '22023', message = 'Flow start values are undeclared';
    end if;
    for declaration in select * from pg_catalog.jsonb_each(declarations) loop
      literal := supplied -> declaration.key;
      if literal is null and declaration.value ? 'default' then
        literal := pg_catalog.jsonb_build_object(
          'type', declaration.value ->> 'type', 'value', declaration.value -> 'default'
        );
      end if;
      if literal is null then
        if declaration.value -> 'required' = 'true'::jsonb then
          raise exception using errcode = '22023', message = 'Required flow start value is missing';
        end if;
        continue;
      end if;
      if pg_catalog.jsonb_typeof(literal) <> 'object'
        or literal - array['type', 'value'] <> '{}'::jsonb
        or not literal ?& array['type', 'value']
        or literal ->> 'type' is distinct from declaration.value ->> 'type'
        or not vortex_workflow.start_value_matches_type_internal(
          declaration.value ->> 'type', literal -> 'value'
        ) then
        raise exception using errcode = '22023', message = 'Flow start value type is invalid';
      end if;
      if part.name = 'inputs' then
        effective_inputs := effective_inputs || pg_catalog.jsonb_build_object(declaration.key, literal);
      else
        effective_trigger_values := effective_trigger_values || pg_catalog.jsonb_build_object(declaration.key, literal);
      end if;
    end loop;
  end loop;

  if p_source_kind = 'event' then
    select occurrence.envelope into event_envelope
    from vortex_event.event_outbox as occurrence
    where occurrence.occurrence_id = p_source_id
      and occurrence.organization_id = p_organization_id
      and occurrence.envelope #>> '{installation,applicationRootId}' = p_application_root_id::text
      and occurrence.envelope #>> '{installation,applicationReleaseRevision}'
        = p_application_release_revision::text
    for key share of occurrence;
    if not found then
      raise exception using errcode = '55000', message = 'Committed flow source is unavailable';
    end if;
    if event_envelope ->> 'actorId' is distinct from
        context_value ->> 'organizationAccountId'
      or (published_trigger ->> 'recordTypeId') is distinct from
        (event_envelope #>> '{descriptor,recordTypeId}')
      or (published_trigger #>> '{event,kind}') is distinct from
        (event_envelope #>> '{descriptor,kind}')
      or (published_trigger #>> '{event,eventKind}') is distinct from
        (event_envelope #>> '{descriptor,eventKind}')
      or (published_trigger #>> '{event,eventKey}') is distinct from
        (event_envelope #>> '{descriptor,key}') then
      raise exception using errcode = '55000', message = 'Committed event does not match the trigger';
    end if;
    caller := pg_catalog.jsonb_build_object(
      'kind', 'event', 'actorId', event_envelope -> 'actorId',
      'correlationId', event_envelope -> 'correlationId'
    );
  else
    caller := pg_catalog.jsonb_build_object(
      'kind', context_value -> 'callerKind',
      'actorId', case when context_value ->> 'callerKind' = 'human'
        then context_value -> 'organizationAccountId' else context_value -> 'systemActorId' end,
      'identityId', case when context_value ->> 'callerKind' = 'human'
        then context_value -> 'identityId' else null end,
      'correlationId', context_value -> 'correlationId'
    );
  end if;

  if installation_active then
    insert into vortex_workflow.flow_start_intents (
      intent_id, organization_id, application_root_id, application_release_revision,
      application_release_version, flow_owner_kind, flow_owner_root_id,
      flow_release_revision, flow_release_version, flow_release_fingerprint,
      flow_id, source_kind, source_id,
      trigger_type, trigger_id, inputs, trigger_values, caller, status, accepted_at
    ) values (
      pg_catalog.gen_random_uuid(), p_organization_id, p_application_root_id,
      p_application_release_revision, p_application_release_version,
      p_flow_owner_kind, p_flow_owner_root_id, p_flow_release_revision,
      p_flow_release_version, flow_release_fingerprint,
      p_flow_id, p_source_kind, p_source_id, p_trigger_type, p_trigger_id,
      effective_inputs, effective_trigger_values, caller, 'pending', pg_catalog.statement_timestamp()
    ) on conflict (
      organization_id, source_kind, source_id, application_root_id,
      application_release_revision, flow_owner_root_id, flow_release_revision,
      flow_id, trigger_type, trigger_id
    ) do nothing
    returning * into stored;
    inserted := found;
  end if;
  if not inserted then
    select * into stored from vortex_workflow.flow_start_intents as intent
    where intent.organization_id = p_organization_id
      and intent.source_kind = p_source_kind and intent.source_id = p_source_id
      and intent.application_root_id = p_application_root_id
      and intent.application_release_revision = p_application_release_revision
      and intent.flow_owner_root_id = p_flow_owner_root_id
      and intent.flow_release_revision = p_flow_release_revision
      and intent.flow_id = p_flow_id and intent.trigger_type = p_trigger_type
      and intent.trigger_id = p_trigger_id;
    if not found then
      raise exception using errcode = '55000', message = 'Active flow installation is unavailable';
    end if;
    if stored.application_release_version <> p_application_release_version
      or stored.flow_owner_kind <> p_flow_owner_kind
      or stored.flow_release_version <> p_flow_release_version
      or stored.flow_release_fingerprint <> flow_release_fingerprint
      or stored.inputs <> effective_inputs
      or stored.trigger_values <> effective_trigger_values
      or stored.caller ->> 'kind' <> caller ->> 'kind'
      or stored.caller ->> 'actorId' <> caller ->> 'actorId'
      or stored.caller ->> 'identityId' is distinct from caller ->> 'identityId' then
      raise exception using errcode = '23505', message = 'Flow start identity was reused';
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', case when inserted then 'accepted' else 'existing' end,
    'intentId', stored.intent_id,
    'acceptedAt', stored.accepted_at
  );
end
$function$;

revoke all on function vortex_workflow.accept_flow_start_intent(
  uuid, uuid, bigint, text, text, uuid, bigint, text, uuid, text, uuid, text, text, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_workflow.accept_flow_start_intent(
  uuid, uuid, bigint, text, text, uuid, bigint, text, uuid, text, uuid, text, text, jsonb, jsonb
) to vortex_request;

comment on function vortex_workflow.accept_flow_start_intent(
  uuid, uuid, bigint, text, text, uuid, bigint, text, uuid, text, uuid, text, text, jsonb, jsonb
) is
  'Accepts one exact published Event flow start under the verified human request context and committed occurrence, and returns an identical retry without dispatching it. Action starts refuse until verified invocation evidence exists.';
