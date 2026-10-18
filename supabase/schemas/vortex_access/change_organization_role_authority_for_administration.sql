create or replace function vortex_access.change_organization_role_authority_for_administration(
  p_changes jsonb
)
returns table (
  outcome text,
  organization_id uuid,
  role_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  item jsonb;
  evidence jsonb;
  activity_id uuid;
  target_role_id uuid;
  operation_name text;
  changed record;
  changed_summary jsonb;
  seen_role_ids uuid[] := array[]::uuid[];
begin
  if p_changes is null or pg_catalog.jsonb_typeof(p_changes) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_changes) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Organization role-authority change input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  -- The caller holds the exclusive organisation Access lock for this entire request.
  -- Each iteration uses the existing protected coordinator, including its current authority,
  -- revision, template, recent-authentication, affected-assignment and stewardship checks.
  for item in select value from pg_catalog.jsonb_array_elements(p_changes) loop
    evidence := item -> 'evidence';
    operation_name := evidence #>> '{candidate,operation}';
    if pg_catalog.jsonb_typeof(item) is distinct from 'object'
      or pg_catalog.jsonb_typeof(evidence) is distinct from 'object'
      or pg_catalog.jsonb_typeof(evidence -> 'candidate') is distinct from 'object'
      or operation_name is null
      or operation_name not in ('create_custom', 'create_custom_from_template',
        'accept_new_application_role', 'accept_application_role_revision')
      or (pg_catalog.jsonb_array_length(p_changes) > 1
        and operation_name not in ('accept_new_application_role', 'accept_application_role_revision'))
      or vortex_platform.is_non_nil_uuid(item ->> 'activityId') is not true
      or vortex_platform.is_non_nil_uuid(evidence #>> '{candidate,organizationId}') is not true
      or vortex_platform.is_non_nil_uuid(evidence #>> '{candidate,roleId}') is not true then
      raise exception using errcode = '22023', message = 'Organization role-authority change input is invalid';
    end if;
    if (evidence #>> '{candidate,organizationId}')::uuid is distinct from context_organization_id then
      raise exception using errcode = '42501', message = 'Organization role-authority change is unavailable';
    end if;
    activity_id := (item ->> 'activityId')::uuid;
    target_role_id := (evidence #>> '{candidate,roleId}')::uuid;
    if target_role_id = any(seen_role_ids) then
      raise exception using errcode = '22023', message = 'Organization role-authority role is repeated';
    end if;
    seen_role_ids := pg_catalog.array_append(seen_role_ids, target_role_id);

    select result.* into strict changed
    from vortex_access.coordinate_private_organization_role_authority_change(evidence, activity_id) as result;
    changed_summary := vortex_access.project_organization_role_change_summary(context_organization_id, target_role_id);
    if changed_summary is null then
      raise exception using errcode = '40001', message = 'Changed organization role projection is unavailable';
    end if;
    -- Only this protected writer advances its established context, to the version its own
    -- successful change just produced. Identity, organisation, session and authentication stay pinned.
    context_value := pg_catalog.jsonb_set(context_value, '{accessVersion}', pg_catalog.to_jsonb(changed.access_version));
    update vortex_platform.request_contexts as established
    set context = context_value
    where established.backend_pid = pg_catalog.pg_backend_pid()
      and established.transaction_id = pg_catalog.pg_current_xact_id();
    if not found then
      raise exception using errcode = '55000', message = 'Organization role-authority context is unavailable';
    end if;
    return query select 'completed'::text, context_organization_id, changed_summary, changed.access_version;
  end loop;
exception
  when invalid_text_representation or invalid_parameter_value or numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'Organization role-authority change input is invalid';
end
$function$;

revoke execute on function vortex_access.change_organization_role_authority_for_administration(jsonb)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.change_organization_role_authority_for_administration(jsonb) to vortex_request;
alter function vortex_access.change_organization_role_authority_for_administration(jsonb) owner to vortex_owner;
grant execute on function vortex_access.change_organization_role_authority_for_administration(jsonb) to postgres;
comment on function vortex_access.change_organization_role_authority_for_administration(jsonb) is
  'One atomic role-authority writer: applies a complete reviewed set through the protected coordinator and rolls back all roles and activity on any refusal.';
