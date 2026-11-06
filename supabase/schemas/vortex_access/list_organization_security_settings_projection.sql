create or replace function vortex_access.list_organization_security_settings_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text, p_after jsonb,
  p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_value uuid;
  setting_row record;
  instance_kind text;
  organization_name text;
  predicate_plan jsonb;
  predicate_matches boolean;
begin
  -- One row per organisation, so ordering is irrelevant: record_id and the projection's declared
  -- sortable field (require_step_up) are both accepted.
  if p_sort_key is null or p_sort_key not in ('record_id', 'require_step_up')
    or p_direction is null or p_direction not in ('ascending', 'descending')
    or (p_limit is not null and p_limit < 1) then
    raise exception using errcode = '22023', message = 'Security settings projection bounds are invalid';
  end if;
  if p_after is not null and (
    pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
  ) then
    raise exception using errcode = '22023', message = 'Security settings projection cursor is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  organization_value := (context_value ->> 'organizationId')::uuid;

  -- The one read decides who sees the row: a person who may not change the setting sees no row,
  -- exactly as a missing or foreign record. The effective requirement comes from the same mapper
  -- every two-step check uses, so the page can never disagree with the check.
  select setting.* into setting_row
  from vortex_access.read_current_organization_step_up_setting() as setting;
  if not found or setting_row.can_change is not true then
    return;
  end if;
  -- The card is headed by the organisation's name, never its id.
  select organization.display_name into organization_name
  from vortex_identity.organizations as organization
  where organization.organization_id = organization_value;
  organization_name := coalesce(organization_name, organization_value::text);
  -- The organisation's id and its name (the record title) are the filterable keys; both are the
  -- single row's own values, so the predicate is evaluated against them as literals. There is no
  -- searchable key.
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    pg_catalog.jsonb_build_object(
      'organization_id',
      pg_catalog.jsonb_build_object(
        'sql', pg_catalog.format('%L::text', organization_value::text),
        'database', 'text',
        'filter', true
      ),
      'organization_name',
      pg_catalog.jsonb_build_object(
        'sql', pg_catalog.format('%L::text', organization_name),
        'database', 'text',
        'filter', true
      )
    ),
    1
  );
  if predicate_plan ->> 'predicate' is not null then
    execute 'select (' || (predicate_plan ->> 'predicate') || ') is true'
      into predicate_matches using predicate_plan -> 'parameters';
    if not predicate_matches then
      return;
    end if;
  end if;
  if p_record_ids is not null and not (organization_value = any(p_record_ids)) then
    return;
  end if;
  if p_after is not null then
    begin
      if (p_direction = 'ascending' and organization_value <= (p_after ->> 'recordId')::uuid)
        or (p_direction = 'descending' and organization_value >= (p_after ->> 'recordId')::uuid) then
        return;
      end if;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Security settings projection cursor is invalid';
    end;
  end if;
  select profile.kind into instance_kind from vortex_platform.instance_profile as profile;
  return query select
    organization_value,
    organization_value,
    setting_row.revision,
    pg_catalog.jsonb_build_object(
      'organization_name', organization_name,
      'require_step_up', setting_row.require_step_up,
      'instance_profile', coalesce(instance_kind, 'production'),
      'can_turn_off', setting_row.can_turn_off,
      'changed_at', setting_row.changed_at,
      'changed_by_display_name', setting_row.changed_by_display_name
    );
end
$function$;

revoke all on function vortex_access.list_organization_security_settings_projection(uuid[], text, text, jsonb, integer, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_security_settings_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_security_settings_projection(uuid[], text, text, jsonb, integer, jsonb)
  owner to vortex_owner;
