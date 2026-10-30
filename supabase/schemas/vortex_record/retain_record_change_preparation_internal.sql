create or replace function vortex_record.retain_record_change_preparation_internal(
  p_command_id uuid,
  p_subjects jsonb,
  p_named jsonb,
  p_preparation jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  retained jsonb;
begin
  -- The preparation lives only for this transaction, in a session table only the record adapter
  -- owns; a table of the same name created by any other role is refused.
  create temporary table if not exists record_change_preparations (
    command_id uuid primary key,
    intents jsonb not null,
    named jsonb,
    preparation jsonb not null
  ) on commit delete rows;
  if (select relation.relowner from pg_catalog.pg_class as relation
      where relation.oid = 'pg_temp.record_change_preparations'::pg_catalog.regclass)
    is distinct from 'vortex_record_adapter'::pg_catalog.regrole then
    raise exception using errcode = '42501', message = 'Record change preparation store is unavailable';
  end if;
  if p_preparation is null then
    -- Taking the preparation for the writer: the same command, intents (without the final values
    -- the caller calculated) and named scope, prepared earlier in this transaction.
    delete from pg_temp.record_change_preparations as stored
    where stored.command_id = p_command_id
      and stored.intents = (select coalesce(pg_catalog.jsonb_agg(item.value - 'finalValues' order by item.ordinality), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality))
      and stored.named is not distinct from p_named
    returning stored.preparation into retained;
    return retained;
  end if;
  insert into pg_temp.record_change_preparations (command_id, intents, named, preparation)
  values (p_command_id,
    (select coalesce(pg_catalog.jsonb_agg(item.value - 'finalValues' order by item.ordinality), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)),
    p_named, p_preparation)
  on conflict (command_id) do update
    set intents = excluded.intents, named = excluded.named, preparation = excluded.preparation;
  return p_preparation;
end
$function$;
alter function vortex_record.retain_record_change_preparation_internal(uuid,jsonb,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.retain_record_change_preparation_internal(uuid,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.retain_record_change_preparation_internal(uuid,jsonb,jsonb,jsonb) is
  'Private: keeps a record command''s locked calculation preparation for the rest of its transaction (with a preparation), or takes it for the writer (without one), so the writer re-checks only revisions instead of preparing again.';
