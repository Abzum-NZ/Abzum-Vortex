create or replace function vortex_platform.grid_view_format_rule_valid_internal(p_rule jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.jsonb_typeof(p_rule) = 'object'
    and p_rule - array['id', 'enabled', 'condition', 'target', 'style', 'stopIfTrue'] = '{}'::jsonb
    and pg_catalog.jsonb_typeof(p_rule -> 'id') = 'string'
    and vortex_platform.is_non_nil_uuid(p_rule ->> 'id')
    and pg_catalog.jsonb_typeof(p_rule -> 'enabled') = 'boolean'
    and pg_catalog.jsonb_typeof(p_rule -> 'stopIfTrue') = 'boolean'
    and vortex_platform.grid_view_condition_field_ids_internal(p_rule -> 'condition', 1) is not null
    and pg_catalog.jsonb_typeof(p_rule -> 'target') = 'object'
    and (p_rule -> 'target' = '{"kind": "row"}'::jsonb or (
      p_rule -> 'target' - array['kind', 'fields'] = '{}'::jsonb
      and p_rule -> 'target' ->> 'kind' = 'cells'
      and pg_catalog.jsonb_typeof(p_rule -> 'target' -> 'fields') = 'array'
      and pg_catalog.jsonb_array_length(p_rule -> 'target' -> 'fields') between 1 and 20
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_rule -> 'target' -> 'fields') as field(value)
        where pg_catalog.jsonb_typeof(field.value) is distinct from 'string'
          or not vortex_platform.is_non_nil_uuid(field.value #>> '{}')
      )))
    and pg_catalog.jsonb_typeof(p_rule -> 'style') = 'object'
    and p_rule -> 'style' - array['token', 'tint', 'text', 'bold', 'strike', 'icon', 'badgeLabel'] = '{}'::jsonb
    and pg_catalog.jsonb_typeof(p_rule -> 'style' -> 'token') = 'string'
    and p_rule -> 'style' ->> 'token' = any (array['success', 'warning', 'info', 'destructive', 'muted'])
    and pg_catalog.jsonb_typeof(p_rule -> 'style' -> 'tint') = 'boolean'
    and pg_catalog.jsonb_typeof(p_rule -> 'style' -> 'text') = 'boolean'
    and pg_catalog.jsonb_typeof(p_rule -> 'style' -> 'bold') = 'boolean'
    and pg_catalog.jsonb_typeof(p_rule -> 'style' -> 'strike') = 'boolean'
    and (not (p_rule -> 'style') ? 'icon' or (
      pg_catalog.jsonb_typeof(p_rule -> 'style' -> 'icon') = 'string'
      and p_rule -> 'style' ->> 'icon' = any (array[
        'alert', 'check', 'info', 'clock', 'flag', 'star', 'x', 'arrow_up', 'arrow_down'
      ])))
    and (not (p_rule -> 'style') ? 'badgeLabel' or (
      pg_catalog.jsonb_typeof(p_rule -> 'style' -> 'badgeLabel') = 'string'
      and pg_catalog.char_length(p_rule -> 'style' ->> 'badgeLabel') between 1 and 40)),
    false)
$function$;

revoke all on function vortex_platform.grid_view_format_rule_valid_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_platform.grid_view_format_rule_valid_internal(jsonb) is
  'Whether one personal formatting rule of a grid view document has the authored conditional-format rule shape; owner-only.';

alter function vortex_platform.grid_view_format_rule_valid_internal(jsonb) owner to vortex_owner;
