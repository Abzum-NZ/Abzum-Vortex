create or replace function vortex_record.module_query_board_column_predicate_internal(
  p_member jsonb,
  p_column jsonb
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  -- The narrowed candidate scan of one column, only over a guaranteed-readable stored choice.
  select case
    when p_member ->> 'choiceColumn' is null then null
    when p_column ->> 'kind' = 'option' then pg_catalog.format(
      'stored.%I collate "C" = $13 collate "C"', p_member ->> 'choiceColumn')
    else pg_catalog.format(
      '(stored.%1$I is null or not (stored.%1$I collate "C" = any ($14::text[])))',
      p_member ->> 'choiceColumn')
  end
$function$;

alter function vortex_record.module_query_board_column_predicate_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_query_board_column_predicate_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.module_query_board_column_predicate_internal(jsonb,jsonb) is
  'Adapter-only stored-value predicate of one board column: the stored choice equals the bound column value, or names no option for the unassigned column; null when the choice field is not guaranteed readable and membership is decided from each readable projection only.';
