CREATE FUNCTION vortex_record.named_action_command_closure_internal(p_catalogue jsonb, p_record_type_id uuid, p_record_id uuid, p_submitted_values jsonb, p_creations jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  subject_closure jsonb;
  creation_closure jsonb;
  creation jsonb;
  records jsonb;
  signatures jsonb;
  subject_key text;
  creation_key text;
  record_value jsonb;
  signature_value jsonb;
  old_key text;
  new_key text;
begin
  subject_closure := vortex_record.discover_relationship_total_closure_internal(
    p_catalogue, 'update', p_record_type_id, p_record_id, p_submitted_values
  );
  if subject_closure is null then return null; end if;
  records := subject_closure -> 'records';
  signatures := subject_closure -> 'signatures';
  subject_key := pg_catalog.lower(p_record_type_id::text) || ':' ||
    pg_catalog.lower(p_record_id::text);

  for creation in
    select item.value
    from pg_catalog.jsonb_array_elements(coalesce(p_creations, '[]'::jsonb))
      with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    creation_key := 'create:' || (creation ->> 'ordinal');
    creation_closure := vortex_record.discover_relationship_total_closure_internal(
      p_catalogue, 'create', (creation ->> 'recordTypeId')::uuid, null,
      creation -> 'values'
    );
    if creation_closure is null then return null; end if;
    for record_value in
      select item.value
      from pg_catalog.jsonb_array_elements(creation_closure -> 'records') item(value)
    loop
      old_key := record_value ->> 'recordKey';
      new_key := case when old_key = 'root' then creation_key
        when old_key = subject_key then 'root' else old_key end;
      if not exists (
        select 1 from pg_catalog.jsonb_array_elements(records) existing(value)
        where existing.value ->> 'recordKey' = new_key
      ) then
        records := records || pg_catalog.jsonb_build_array(
          record_value || pg_catalog.jsonb_build_object('recordKey', new_key)
        );
      end if;
    end loop;
    for signature_value in
      select item.value
      from pg_catalog.jsonb_array_elements(creation_closure -> 'signatures') item(value)
    loop
      signatures := signatures || pg_catalog.jsonb_build_array(
        signature_value || pg_catalog.jsonb_build_object(
          'from', case when signature_value ->> 'from' = 'root' then creation_key
            when signature_value ->> 'from' = subject_key then 'root'
            else signature_value ->> 'from' end,
          'to', case when signature_value ->> 'to' = 'root' then creation_key
            when signature_value ->> 'to' = subject_key then 'root'
            else signature_value ->> 'to' end
        )
      );
    end loop;
  end loop;

  return pg_catalog.jsonb_build_object(
    'records', records,
    'signatures', coalesce((
      select pg_catalog.jsonb_agg(distinct item.value order by item.value)
      from pg_catalog.jsonb_array_elements(signatures) item(value)
    ), '[]'::jsonb)
  );
end
$$;

REVOKE ALL ON FUNCTION vortex_record.named_action_command_closure_internal(p_catalogue jsonb, p_record_type_id uuid, p_record_id uuid, p_submitted_values jsonb, p_creations jsonb) FROM PUBLIC;
