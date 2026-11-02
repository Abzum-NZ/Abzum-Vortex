CREATE OR REPLACE FUNCTION vortex_platform.refuse_event_outbox_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  -- Only the history purge role may delete these rows; it owns one function and nothing else.
  if tg_op = 'DELETE' and current_user = 'vortex_history_purger' then
    return old;
  end if;
  -- An occurrence is immutable evidence. Only retention removes one, and only once it is
  -- older than the 30-day delivery window event_dispatch_backlog_status trims after.
  if tg_op = 'DELETE'
    and old.occurred_at < pg_catalog.statement_timestamp() - interval '30 days' then
    return old;
  end if;
  raise exception using errcode = '23514', message = 'Event outbox evidence is immutable';
end
$$;

alter function vortex_platform.refuse_event_outbox_change() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_platform.refuse_event_outbox_change() FROM PUBLIC;

grant execute on function vortex_platform.refuse_event_outbox_change() to postgres;
