create or replace function vortex_record.query_search_plan_internal(
  p_user_inputs jsonb, fields_by_id jsonb, declared_searchable_ids text[]
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  user_search text;
  search_candidate_ids text[];
  search_field_ids text[] := array[]::text[];
  field_key text;
begin
  -- The user's search: one bounded, non-blank text term; a blank term is absent.
  if p_user_inputs ? 'search'
    and pg_catalog.jsonb_typeof(p_user_inputs -> 'search') not in ('string', 'null') then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_search := pg_catalog.btrim(p_user_inputs ->> 'search');
  if user_search = '' then
    user_search := null;
  end if;
  if user_search is not null and pg_catalog.length(user_search) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  -- Search authority: the record type's own declared search priority. A component
  -- with only a search box declares no per-field list, so an empty declared set
  -- searches every field the record type marks searchable; a declared set narrows
  -- it. A row matches only through a field the reader can see on that row, so a
  -- hidden searchable value never decides a match.
  if pg_catalog.cardinality(declared_searchable_ids) > 0 then
    search_candidate_ids := declared_searchable_ids;
  else
    select coalesce(pg_catalog.array_agg(item.key), array[]::text[])
    into search_candidate_ids
    from pg_catalog.jsonb_object_keys(fields_by_id) as item(key);
  end if;
  foreach field_key in array search_candidate_ids loop
    if (fields_by_id ? field_key)
      and (fields_by_id -> field_key ->> 'searchPriority') in ('first', 'normal', 'last') then
      search_field_ids := pg_catalog.array_append(search_field_ids, field_key);
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('outcome', 'completed', 'search', user_search,
    'fieldIds', pg_catalog.to_jsonb(search_field_ids));
end
$function$;
alter function vortex_record.query_search_plan_internal(jsonb,jsonb,text[]) owner to vortex_record_adapter;
revoke all on function vortex_record.query_search_plan_internal(jsonb,jsonb,text[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
