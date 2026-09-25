create or replace function vortex_invalidation.publish_change_notice(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_record_version bigint,
  p_change_kind text,
  p_data_version bigint,
  p_sequence bigint,
  p_correlation_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  selected_topic text;
  selected_payload jsonb;
  stored_context text;
begin
  if p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null
    or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_record_type_id is null
    or not vortex_context.is_non_nil_uuid(p_record_type_id::text)
    or (p_record_id is not null and not vortex_context.is_non_nil_uuid(p_record_id::text))
    or (p_record_version is not null
      and p_record_version not between 1 and 9007199254740991)
    or p_change_kind is null
    or not (
      p_change_kind = any (
        vortex_access.validation_reference_list('private_invalidation_change_kind')
      )
    )
    or p_data_version is null
    or p_data_version not between 1 and 9007199254740991
    or p_sequence is null
    or p_sequence not between 1 and 9007199254740991
    or p_correlation_id is null
    or not vortex_context.is_non_nil_uuid(p_correlation_id::text) then
    raise exception using errcode = '22023',
      message = 'Invalidation notice command is invalid';
  end if;

  stored_context := pg_catalog.current_setting('vortex.request_context', true);
  if stored_context is not null and stored_context <> ''
    and (vortex_context.current_context() ->> 'organizationId')::uuid
      is distinct from p_organization_id then
    raise exception using errcode = '42501',
      message = 'Invalidation notice scope is unavailable';
  end if;

  if not exists (
    select 1
    from vortex_identity.organizations as organization
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where organization.organization_id = p_organization_id
      and organization.state = 'active'
      and tenant.state = 'active'
  ) or not vortex_invalidation.application_is_installed(
    p_organization_id, p_application_root_id
  ) then
    raise exception using errcode = 'P0002',
      message = 'Invalidation notice scope is unavailable';
  end if;

  selected_topic := vortex_invalidation.change_topic(p_organization_id, p_application_root_id);

  selected_payload := pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'organizationId', p_organization_id,
    'applicationRootId', p_application_root_id,
    'recordTypeId', p_record_type_id,
    'changeKind', p_change_kind,
    'dataVersion', p_data_version,
    'sequence', p_sequence,
    'occurredAt', pg_catalog.to_char(operation_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'correlationId', p_correlation_id
  )
  || case when p_record_id is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('recordId', p_record_id) end
  || case when p_record_version is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('recordVersion', p_record_version) end;

  perform realtime.send(selected_payload, 'invalidation', selected_topic, true);

  return selected_topic;
end
$function$;

revoke all on function vortex_invalidation.publish_change_notice(
  uuid, uuid, uuid, uuid, bigint, text, bigint, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_invalidation.publish_change_notice(
  uuid, uuid, uuid, uuid, bigint, text, bigint, bigint, uuid
) to vortex_request, vortex_runtime, vortex_record_adapter;

comment on function vortex_invalidation.publish_change_notice(
  uuid, uuid, uuid, uuid, bigint, text, bigint, bigint, uuid
) is
  'Protected post-commit broadcast of the bounded content-free invalidation envelope on the private topic for one organisation and application.';
