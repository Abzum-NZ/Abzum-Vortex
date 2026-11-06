-- STEPUP-SETTING part 3: the Security page reads the organisation's two-step setting through the
-- platform's one route for a definition page, a registered bounded system-projection reader. The
-- reader (a whole definition identical to supabase/schemas) returns one row per organisation, only
-- to a person who may change the setting, built from the same read the checks and the Verify panel
-- use. The protected read model key joins the two closed key lists and the reader is registered
-- with its one sort key.
set role vortex_owner;

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
  predicate_plan jsonb;
begin
  -- One row per organisation, so ordering is irrelevant: record_id is the only sort key.
  if p_sort_key is null or p_sort_key <> 'record_id'
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
  -- No key is filterable or searchable; a predicate naming one is refused by cause.
  predicate_plan := vortex_record.compile_projection_predicate_internal(p_predicate, '{}'::jsonb, 1);
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

alter table vortex_record.protected_read_model_views
  drop constraint protected_read_model_views_protected_read_model_key_check;
alter table vortex_record.protected_read_model_views
  add constraint protected_read_model_views_protected_read_model_key_check
  check (protected_read_model_key = any (array[
    'people', 'organization_accounts', 'roles', 'groups', 'effective_assignments',
    'tenant_structure', 'organization_invitations', 'organization_runtime_settings',
    'permissions', 'role_activations', 'delegations', 'tenants',
    'tenant_administrators', 'application_role_templates', 'activity_entry',
    'application_store_entries', 'connection_instances', 'organization_security_settings'
  ]));

alter table vortex_record.storage_catalogue
  drop constraint storage_catalogue_protected_read_model_key_check;
alter table vortex_record.storage_catalogue
  add constraint storage_catalogue_protected_read_model_key_check
  check (
    (physical_schema_token = 'system_projection') = (protected_read_model_key is not null)
    and (protected_read_model_key is null or protected_read_model_key = any (array[
      'people', 'organization_accounts', 'roles', 'groups', 'effective_assignments',
      'tenant_structure', 'organization_invitations', 'organization_runtime_settings',
      'permissions', 'delegations', 'tenants',
      'tenant_administrators', 'application_role_templates', 'activity_entry',
      'application_store_entries', 'connection_instances', 'organization_security_settings'
    ]))
  );

insert into vortex_record.protected_read_model_views (
  protected_read_model_key, reader_schema, reader_function, changed_at, cursor_sort_keys
) values (
  'organization_security_settings', 'vortex_access',
  'list_organization_security_settings_projection',
  pg_catalog.statement_timestamp(), array['record_id']::text[]
);

reset role;
