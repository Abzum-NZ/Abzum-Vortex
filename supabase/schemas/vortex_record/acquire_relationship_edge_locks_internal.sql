CREATE FUNCTION vortex_record.acquire_relationship_edge_locks_internal(p_identities text[]) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  transaction_key text := pg_catalog.pg_current_xact_id()::text;
  stored_value text;
  high_water text;
  identity_value text;
begin
  if p_identities is null
    or pg_catalog.array_position(p_identities, null::text) is not null then
    raise exception using errcode = '22023',
      message = 'Relationship edge lock set is invalid';
  end if;
  stored_value := pg_catalog.current_setting(
    'vortex_record.relationship_edge_lock_high_water', true
  );
  if stored_value is not null
    and pg_catalog.split_part(stored_value, '|', 1) = transaction_key then
    high_water := pg_catalog.substr(
      stored_value, pg_catalog.length(transaction_key) + 2
    );
  end if;
  for identity_value in
    select distinct item.value collate "C"
    from pg_catalog.unnest(p_identities) as item(value)
    order by 1
  loop
    if high_water is null or identity_value collate "C" > high_water collate "C" then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(identity_value, 0)
      );
      high_water := identity_value;
      perform pg_catalog.set_config(
        'vortex_record.relationship_edge_lock_high_water',
        transaction_key || '|' || high_water, true
      );
    elsif not pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(identity_value, 0)
    ) then
      raise exception using errcode = '40001',
        message = 'Relationship edge lock order conflict';
    end if;
  end loop;
end
$$;
alter function vortex_record.acquire_relationship_edge_locks_internal(text[]) owner to vortex_record_adapter;


COMMENT ON FUNCTION vortex_record.acquire_relationship_edge_locks_internal(p_identities text[]) IS 'Acquires relationship edge participant identities as transaction advisory locks in one ascending collate "C" order per transaction; an out-of-order identity that is held elsewhere is a bounded 40001 conflict, never a wait.';

REVOKE ALL ON FUNCTION vortex_record.acquire_relationship_edge_locks_internal(p_identities text[]) FROM PUBLIC;
