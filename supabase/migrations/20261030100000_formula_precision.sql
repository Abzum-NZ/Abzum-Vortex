-- Convert contract 4 draft formulas to exact arithmetic and declared result precision.
set local role vortex_owner;

create function pg_temp.contract_4_canonical_json(p_value jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  result text;
  member text;
  first boolean := true;
begin
  case pg_catalog.jsonb_typeof(p_value)
    when 'object' then
      result := '{';
      for member in
        select item.key from pg_catalog.jsonb_object_keys(p_value) as item(key)
        order by item.key collate "C"
      loop
        result := result || case when first then '' else ',' end
          || pg_catalog.to_json(member)::text || ':'
          || pg_temp.contract_4_canonical_json(p_value -> member);
        first := false;
      end loop;
      return result || '}';
    when 'array' then
      return '[' || coalesce((
        select pg_catalog.string_agg(pg_temp.contract_4_canonical_json(item.value), ',' order by item.ordinality)
        from pg_catalog.jsonb_array_elements(p_value) with ordinality as item(value, ordinality)
      ), '') || ']';
    when 'string' then
      return pg_catalog.to_json(p_value #>> '{}')::text;
    else
      return p_value::text;
  end case;
end
$function$;

create function pg_temp.contract_4_fingerprint(p_value jsonb)
returns text
language sql
immutable
set search_path = ''
as $function$
  select 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_temp.contract_4_canonical_json(p_value), 'UTF8')),
    'hex'
  )
$function$;


-- Only visit formula children: literal payloads and references are data, not syntax.
create function pg_temp.sf16_formula(p_node jsonb, p_escape boolean, p_rounded boolean)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  result jsonb := p_node;
  member record;
  item record;
  converted jsonb;
  node_op text := p_node ->> 'op';
  escape_child boolean;
  rounded_child boolean;
begin
  if node_op in ('literal', 'reference', 'now') then return p_node; end if;
  escape_child := p_escape or node_op = 'join';
  rounded_child := p_rounded or node_op = 'round';
  for member in select key, value from pg_catalog.jsonb_each(p_node) loop
    if pg_catalog.jsonb_typeof(member.value) = 'object' and member.value ? 'op' then
      result := pg_catalog.jsonb_set(result, array[member.key],
        pg_temp.sf16_formula(member.value, escape_child, rounded_child));
    elsif pg_catalog.jsonb_typeof(member.value) = 'array' and member.key in ('args', 'parts', 'options') then
      converted := '[]'::jsonb;
      for item in select value from pg_catalog.jsonb_array_elements(member.value) loop
        converted := converted || pg_catalog.jsonb_build_array(
          pg_temp.sf16_formula(item.value, escape_child, rounded_child));
      end loop;
      result := pg_catalog.jsonb_set(result, array[member.key], converted);
    end if;
  end loop;
  if node_op in ('add', 'subtract', 'multiply', 'divide') then
    result := result - 'scale' - 'rounding';
    if node_op = 'divide' and p_escape and not p_rounded then
      if not (p_node ? 'scale' and p_node ? 'rounding') then
        raise exception 'SF-16 cannot preserve a divide without its previous precision';
      end if;
      perform pg_catalog.set_config('sf16.wrapped_divides',
        (coalesce(nullif(pg_catalog.current_setting('sf16.wrapped_divides', true), ''), '0')::integer + 1)::text,
        true);
      result := pg_catalog.jsonb_build_object('op', 'round', 'arg', result,
        'scale', p_node -> 'scale', 'rounding', p_node -> 'rounding');
    end if;
  end if;
  return result;
end
$function$;

-- Traverse source objects without interpreting literal payloads as authoring syntax.
create function pg_temp.sf16_source(p_node jsonb, p_draft text, p_in_calculate boolean default false)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  result jsonb := p_node;
  member record;
  item record;
  converted jsonb;
  formula jsonb;
  result_type text;
  settings jsonb;
  is_calculate boolean := coalesce(p_node ->> 'type' = 'data.calculate', false);
begin
  case pg_catalog.jsonb_typeof(p_node)
    when 'array' then
      result := '[]'::jsonb;
      for item in select value from pg_catalog.jsonb_array_elements(p_node) loop
        result := result || pg_catalog.jsonb_build_array(pg_temp.sf16_source(item.value, p_draft, p_in_calculate));
      end loop;
      return result;
    when 'object' then null;
    else return p_node;
  end case;
  if p_node ->> 'kind' = 'literal' then return p_node; end if;
  if p_node ->> 'kind' = 'formula' then
    return pg_catalog.jsonb_set(p_node, '{formula}', pg_temp.sf16_formula(p_node -> 'formula', not p_in_calculate, false));
  end if;
  if p_node ->> 'type' = 'calculation' and pg_catalog.jsonb_typeof(p_node -> 'settings') = 'object' then
    settings := p_node -> 'settings';
    formula := settings -> 'expression';
    if settings ->> 'result_type' in ('decimal_number', 'money') and settings ? 'decimal_places' then
      settings := settings || pg_catalog.jsonb_build_object('rounding', coalesce(formula ->> 'rounding', 'half_even'));
    end if;
    if formula is not null then
      settings := pg_catalog.jsonb_set(settings, '{expression}',
        pg_temp.sf16_formula(formula, not settings ? 'decimal_places', false));
    end if;
    return pg_catalog.jsonb_set(p_node, '{settings}', settings);
  end if;
  if is_calculate then
    settings := p_node -> 'properties';
    formula := settings #> '{formula,formula}';
    result_type := settings #>> '{result_type,literal,value}';
    if result_type in ('decimal_number', 'money') then
      if formula is null or not (formula ? 'scale' and formula ? 'rounding') then
        raise exception 'SF-16 draft % step % lacks root calculation precision', p_draft, p_node ->> 'id';
      end if;
      settings := settings || pg_catalog.jsonb_build_object(
        'places', pg_catalog.jsonb_build_object('kind', 'literal', 'literal',
          pg_catalog.jsonb_build_object('type', 'whole_number', 'value', formula -> 'scale')),
        'rounding', pg_catalog.jsonb_build_object('kind', 'literal', 'literal',
          pg_catalog.jsonb_build_object('type', 'text', 'value', formula -> 'rounding')));
      result := pg_catalog.jsonb_set(result, '{properties}', settings);
    end if;
  end if;
  for member in select key, value from pg_catalog.jsonb_each(result) loop
    if member.key = 'condition' and pg_catalog.jsonb_typeof(member.value) = 'object' and member.value ? 'op' then
      converted := pg_temp.sf16_formula(member.value, true, false);
    else
      converted := pg_temp.sf16_source(member.value, p_draft, p_in_calculate or is_calculate);
    end if;
    result := pg_catalog.jsonb_set(result, array[member.key], converted);
  end loop;
  return result;
end
$function$;

do $convert$
declare
  draft record;
  converted jsonb;
begin
  for draft in select d.root_id, r.key, d.draft_source, d.source_fingerprint
    from vortex_definition.drafts d join vortex_definition.roots r on r.root_id = d.root_id
  loop
    if pg_temp.contract_4_fingerprint(draft.draft_source) is distinct from draft.source_fingerprint then
      raise exception 'SF-16 cannot verify stored fingerprint of draft % (%)', draft.key, draft.root_id;
    end if;
  end loop;
  perform pg_catalog.set_config('sf16.wrapped_divides', '0', true);
  for draft in select d.root_id, r.key, d.draft_source
    from vortex_definition.drafts d join vortex_definition.roots r on r.root_id = d.root_id
    order by d.root_id
  loop
    converted := pg_temp.sf16_source(draft.draft_source, draft.key);
    if converted is distinct from draft.draft_source then
      update vortex_definition.drafts d set
        draft_source = converted,
        source_fingerprint = pg_temp.contract_4_fingerprint(converted),
        draft_revision = d.draft_revision + 1,
        updated_at = greatest(pg_catalog.statement_timestamp(), d.updated_at),
        restored_from_release_revision = null,
        restored_from_source_fingerprint = null,
        restored_by = null, restored_at = null, restore_correlation_id = null
      where d.root_id = draft.root_id;
    end if;
  end loop;
  raise notice 'SF-16 wrapped % divide nodes', pg_catalog.current_setting('sf16.wrapped_divides');
end
$convert$;

drop function pg_temp.sf16_source(jsonb, text, boolean);
drop function pg_temp.sf16_formula(jsonb, boolean, boolean);
drop function pg_temp.contract_4_fingerprint(jsonb);
drop function pg_temp.contract_4_canonical_json(jsonb);
reset role;
