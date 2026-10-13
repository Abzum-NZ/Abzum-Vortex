CREATE OR REPLACE FUNCTION vortex_platform.initialize(candidate jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  checked jsonb;
  established integer;
begin
  checked := vortex_platform.validated(candidate);

  insert into vortex_platform.request_contexts as stored (backend_pid, transaction_id, context)
  values (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), checked)
  on conflict on constraint request_contexts_pk do update
    set transaction_id = excluded.transaction_id, context = excluded.context
    where stored.transaction_id <> excluded.transaction_id;
  get diagnostics established = row_count;

  if established = 0 then
    raise exception using errcode = '55000', message = 'Vortex request context is already established';
  end if;
end
$$;

alter function vortex_platform.initialize(candidate jsonb) owner to vortex_owner;

COMMENT ON FUNCTION vortex_platform.initialize(candidate jsonb) IS 'Validates and stores one trusted request context for the current transaction; refuses a second establishment in the same transaction.';

REVOKE ALL ON FUNCTION vortex_platform.initialize(candidate jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_platform.initialize(candidate jsonb) TO vortex_runtime;

grant execute on function vortex_platform.initialize(candidate jsonb) to postgres;
