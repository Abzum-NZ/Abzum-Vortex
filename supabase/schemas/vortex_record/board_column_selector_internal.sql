create or replace function vortex_record.board_column_selector_internal(
  p_selector jsonb,
  p_many boolean
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  column_key text := case when p_many then 'columns' else 'column' end;
  board_columns jsonb;
  board_column_item jsonb;
  board_column_keys text[] := array[]::text[];
begin
  -- A member page names one column; a board's first pages name every column.
  -- The choice field and the distinct, closed column selectors, or null when malformed.
  if pg_catalog.jsonb_typeof(p_selector) is distinct from 'object'
    or p_selector - array['choiceFieldId', column_key]::text[] <> '{}'::jsonb
    or not (p_selector ? 'choiceFieldId')
    or not (p_selector ? column_key)
    or pg_catalog.jsonb_typeof(p_selector -> 'choiceFieldId') is distinct from 'string'
    or pg_catalog.lower(p_selector ->> 'choiceFieldId')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  board_columns := case when p_many then p_selector -> 'columns'
    else pg_catalog.jsonb_build_array(p_selector -> 'column') end;
  if pg_catalog.jsonb_typeof(board_columns) is distinct from 'array'
    or pg_catalog.jsonb_array_length(board_columns) not between 1 and 13 then
    return null;
  end if;
  for board_column_item in
    select item.value from pg_catalog.jsonb_array_elements(board_columns) as item(value)
  loop
    if pg_catalog.jsonb_typeof(board_column_item) is distinct from 'object'
      or pg_catalog.jsonb_typeof(board_column_item -> 'kind') is distinct from 'string'
      or board_column_item::text = any (board_column_keys) then
      return null;
    end if;
    board_column_keys := pg_catalog.array_append(board_column_keys, board_column_item::text);
    if board_column_item ->> 'kind' = 'option' then
      if board_column_item - array['kind', 'value']::text[] <> '{}'::jsonb
        or not (board_column_item ? 'value')
        or pg_catalog.jsonb_typeof(board_column_item -> 'value') is distinct from 'string'
        or coalesce(pg_catalog.length(board_column_item ->> 'value'), 0) not between 1 and 120 then
        return null;
      end if;
    elsif board_column_item ->> 'kind' = 'unassigned' then
      if board_column_item - array['kind']::text[] <> '{}'::jsonb then
        return null;
      end if;
    else
      return null;
    end if;
  end loop;
  return pg_catalog.jsonb_build_object(
    'choiceFieldId', pg_catalog.lower(p_selector ->> 'choiceFieldId'),
    'columns', board_columns
  );
end
$function$;

alter function vortex_record.board_column_selector_internal(jsonb, boolean)
  owner to vortex_owner;
revoke all on function vortex_record.board_column_selector_internal(jsonb, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.board_column_selector_internal(jsonb, boolean)
  to vortex_record_adapter;

comment on function vortex_record.board_column_selector_internal(jsonb, boolean) is
  'Owner-only parser of a board selector: one member-page column or every first-page column, each a distinct option or unassigned selector, with the lower-case choice field identity, or null when the selector is malformed.';
