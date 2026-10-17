CREATE FUNCTION vortex_record.record_lifecycle_current_revision_internal(p_record_type_id uuid, p_record_id uuid) RETURNS bigint
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  loaded jsonb;
  decision jsonb;
begin
  begin
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'delete', p_record_id, null, null::jsonb
    );
    if loaded ->> 'outcome' is distinct from 'loaded'
      or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object' then
      return null;
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' is distinct from 'allowed' then
      return null;
    end if;
    return (loaded ->> 'concurrencyNumber')::bigint;
  exception
    when others then
      return null;
  end;
end
$$;
alter function vortex_record.record_lifecycle_current_revision_internal(uuid,uuid) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.record_lifecycle_current_revision_internal(p_record_type_id uuid, p_record_id uuid) FROM PUBLIC;
