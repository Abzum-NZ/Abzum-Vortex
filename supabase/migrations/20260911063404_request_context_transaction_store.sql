-- Issue #386: the request context lives in an owner-only row bound to the
-- establishing transaction, not in a session setting the request role can write.
-- The row is keyed by the server backend and stamped with the top-level
-- transaction id, so a pooled backend's leftover row from a finished transaction
-- is never honoured and needs no sweep.
create unlogged table vortex_context.request_contexts (
  backend_pid integer not null,
  transaction_id xid8 not null,
  context jsonb not null,
  constraint request_contexts_pk primary key (backend_pid),
  constraint request_contexts_context_object check (pg_catalog.jsonb_typeof(context) = 'object')
);
alter table vortex_context.request_contexts enable row level security;
alter table vortex_context.request_contexts force row level security;
revoke all on table vortex_context.request_contexts
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

create or replace function vortex_context.initialize(candidate jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
  established integer;
begin
  checked := vortex_context.validated(candidate);

  insert into vortex_context.request_contexts as stored (backend_pid, transaction_id, context)
  values (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), checked)
  on conflict on constraint request_contexts_pk do update
    set transaction_id = excluded.transaction_id, context = excluded.context
    where stored.transaction_id <> excluded.transaction_id;
  get diagnostics established = row_count;

  if established = 0 then
    raise exception using errcode = '55000', message = 'Vortex request context is already established';
  end if;
end
$function$;

create or replace function vortex_context.current_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  stored jsonb;
begin
  select established.context into stored
  from vortex_context.request_contexts as established
  where established.backend_pid = pg_catalog.pg_backend_pid()
    and established.transaction_id = pg_catalog.pg_current_xact_id_if_assigned();

  if stored is null then
    raise exception using errcode = '55000', message = 'Vortex request context is not established';
  end if;

  return vortex_context.validated(stored);
end
$function$;

-- CREATE OR REPLACE preserves existing ACLs (vortex_record_adapter keeps its
-- accessor grants). Restate only the original intent; do not revoke from PUBLIC blanket.
revoke execute on function vortex_context.initialize(jsonb) from public, anon, authenticated, service_role, vortex_request;
revoke execute on function vortex_context.current_context() from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_context.initialize(jsonb) to vortex_runtime;
grant execute on function vortex_context.current_context() to vortex_request;

comment on table vortex_context.request_contexts is
  'Owner-only request context for the establishing transaction on this backend. No runtime, request or record role may read or write it.';
comment on function vortex_context.initialize(jsonb) is
  'Validates and stores one trusted request context for the current transaction; refuses a second establishment in the same transaction.';
comment on function vortex_context.current_context() is
  'Returns the validated request context established in this transaction or fails closed when it is absent, expired or stale.';
