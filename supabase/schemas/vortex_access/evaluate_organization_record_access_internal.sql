create or replace function vortex_access.evaluate_organization_record_access_internal(
  p_targets jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  ctx jsonb;
  checked_at timestamptz;
  target_item record;
  eligibility_by_declaration jsonb := '[]'::jsonb;
  eligibility jsonb;
  validated_record_types jsonb[] := array[]::jsonb[];
  validated jsonb;
  decisions jsonb[] := array[]::jsonb[];
begin
  -- Each target is one exact record under one action declaration and its
  -- facts; the result holds one complete decision per target in the same
  -- order. Eligibility is decided once per distinct declaration and a record
  -- type set is validated once per call; every target still receives its own
  -- facts checks, target row check and row-scope composition.
  if pg_catalog.jsonb_typeof(p_targets) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_targets) not between 1 and 200
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_targets) as target(value)
      where pg_catalog.jsonb_typeof(target.value) is distinct from 'object'
        or not (target.value ?& array['declaration', 'recordId', 'facts'])
        or exists (
          select 1 from pg_catalog.jsonb_object_keys(case
            when pg_catalog.jsonb_typeof(target.value) = 'object' then target.value
            else '{}'::jsonb end) as supplied(key)
          where supplied.key <> all (array['declaration', 'recordId', 'facts'])
        )
        or pg_catalog.jsonb_typeof(target.value -> 'declaration') is distinct from 'object'
        or pg_catalog.jsonb_typeof(target.value -> 'facts') is distinct from 'object'
        or not vortex_platform.is_non_nil_uuid(target.value ->> 'recordId')
    ) then
    raise exception using errcode = '22023', message = 'Record access targets are invalid';
  end if;

  -- One Access-version observation and one time sample for every eligibility
  -- decision of the call.
  ctx := vortex_access.validated_human_request_context();
  checked_at := pg_catalog.clock_timestamp();

  for target_item in
    select target.value
    from pg_catalog.jsonb_array_elements(p_targets) with ordinality as target(value, ordinality)
    order by target.ordinality
  loop
    select decided.value -> 'eligibility' into eligibility
    from pg_catalog.jsonb_array_elements(eligibility_by_declaration) as decided(value)
    where decided.value -> 'declaration' = target_item.value -> 'declaration';
    if eligibility is null then
      eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
        target_item.value -> 'declaration', ctx, checked_at
      );
      eligibility_by_declaration := eligibility_by_declaration || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'declaration', target_item.value -> 'declaration', 'eligibility', eligibility
        )
      );
    end if;

    validated := case
      when target_item.value -> 'facts' -> 'recordTypes' = any (validated_record_types)
        then target_item.value -> 'facts' -> 'recordTypes'
      else null end;
    decisions := decisions || vortex_access.evaluate_record_access_with_validated_types_internal(
      target_item.value -> 'declaration', (target_item.value ->> 'recordId')::uuid,
      target_item.value -> 'facts', eligibility, validated
    );
    if validated is null then
      validated_record_types := validated_record_types || (target_item.value -> 'facts' -> 'recordTypes');
    end if;
  end loop;

  return pg_catalog.to_jsonb(decisions);
end
$function$;

revoke execute on function vortex_access.evaluate_organization_record_access_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.evaluate_organization_record_access_internal(jsonb)
  to vortex_record_adapter;
comment on function vortex_access.evaluate_organization_record_access_internal(jsonb) is
  'The complete exact-record access decision for a set of targets, one per target in order: unions every eligible alternative''s own complete row scope and always carries the exact recordId. Eligibility once per distinct declaration and each record type set validated once per call. Owner-only except for the fixed record adapter.';

alter function vortex_access.evaluate_organization_record_access_internal(p_targets jsonb) owner to vortex_owner;

grant execute on function vortex_access.evaluate_organization_record_access_internal(p_targets jsonb) to postgres;
