-- Astra correction for #50 slice 1: validate every normalized account/Record
-- action input in the current human Application context, including event-only
-- actions. This is an existence/scope check, not another permission engine.

begin;

create function vortex_identity.is_active_organization_account_reference_internal(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_organization_account_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as projection
      on projection.identity_id = account.identity_id
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where tenant.tenant_id = p_tenant_id
      and organization.organization_id = p_organization_id
      and account.organization_account_id = p_organization_account_id
      and projection.state = 'active'
      and account.state = 'active'
      and organization.state = 'active'
      and tenant.state = 'active'
  )
$function$;

revoke all on function vortex_identity.is_active_organization_account_reference_internal(
  uuid,uuid,uuid
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_request, vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_identity.is_active_organization_account_reference_internal(
  uuid,uuid,uuid
) to vortex_record_adapter;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;

grant usage on schema vortex_identity to vortex_record_adapter;

set local role vortex_record_adapter;

create function vortex_record.validate_named_action_reference_inputs(
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_inputs jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  action_context jsonb;
  input_definition jsonb;
  input_candidate jsonb;
  catalogue jsonb;
  reference_record_type_id uuid;
  reference_record_id uuid;
  resolved_target_count integer;
begin
  if pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object' then
    return false;
  end if;
  context_value := vortex_access.validated_human_request_context();
  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );
  for input_definition in
    select item.value
    from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'inputs') item(value)
    where item.value ->> 'type' in (
      'organization_account_reference', 'record_reference'
    )
  loop
    if not p_inputs ? (input_definition ->> 'key') then
      continue;
    end if;
    input_candidate := p_inputs -> (input_definition ->> 'key');
    if input_definition ->> 'type' = 'organization_account_reference' then
      if pg_catalog.jsonb_typeof(input_candidate) is distinct from 'string'
        or not pg_catalog.pg_input_is_valid(input_candidate #>> '{}', 'uuid')
        or not vortex_identity.is_active_organization_account_reference_internal(
          (context_value ->> 'tenantId')::uuid,
          (context_value ->> 'organizationId')::uuid,
          (input_candidate #>> '{}')::uuid
        ) then
        return false;
      end if;
      continue;
    end if;

    reference_record_type_id := null;
    reference_record_id := null;
    if pg_catalog.jsonb_typeof(input_candidate) = 'object'
      and input_candidate ?& array['recordTypeId', 'recordId']
      and input_candidate - array['recordTypeId', 'recordId'] = '{}'::jsonb
      and pg_catalog.pg_input_is_valid(input_candidate ->> 'recordTypeId', 'uuid')
      and pg_catalog.pg_input_is_valid(input_candidate ->> 'recordId', 'uuid') then
      reference_record_type_id := (input_candidate ->> 'recordTypeId')::uuid;
      reference_record_id := (input_candidate ->> 'recordId')::uuid;
    elsif pg_catalog.jsonb_typeof(input_candidate) = 'string'
      and pg_catalog.pg_input_is_valid(input_candidate #>> '{}', 'uuid') then
      select pg_catalog.count(*),
        (pg_catalog.array_agg(
          (target.value ->> 'recordTypeId')::uuid
          order by (target.value ->> 'recordTypeId')::uuid
        ))[1]
      into resolved_target_count, reference_record_type_id
      from pg_catalog.jsonb_array_elements(input_definition -> 'recordTypes') target(value)
      where target.value ->> 'state' = 'resolved';
      if resolved_target_count = 1 then
        reference_record_id := (input_candidate #>> '{}')::uuid;
      end if;
    end if;
    if reference_record_type_id is null or reference_record_id is null
      or not exists (
        select 1
        from pg_catalog.jsonb_array_elements(input_definition -> 'recordTypes') target(value)
        where target.value ->> 'state' = 'resolved'
          and (target.value ->> 'recordTypeId')::uuid = reference_record_type_id
      ) then
      return false;
    end if;
    catalogue := coalesce(catalogue,
      vortex_record.relationship_total_catalogue_internal());
    if vortex_record.relationship_total_record_snapshot_internal(
      catalogue, reference_record_type_id, reference_record_id, false
    ) is null then
      return false;
    end if;
  end loop;
  return true;
exception
  when no_data_found or too_many_rows or invalid_text_representation
    or insufficient_privilege or object_not_in_prerequisite_state
    or check_violation then
    return false;
end
$function$;

alter function vortex_record.validate_named_action_reference_inputs(
  text,uuid,bigint,uuid,uuid,jsonb
) owner to vortex_record_adapter;
revoke all on function vortex_record.validate_named_action_reference_inputs(
  text,uuid,bigint,uuid,uuid,jsonb
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_request, vortex_record_owner, vortex_module_owner,
  vortex_record_adapter;
grant execute on function vortex_record.validate_named_action_reference_inputs(
  text,uuid,bigint,uuid,uuid,jsonb
) to vortex_runtime;

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
commit;
