-- #1239: no live function body calls pg_catalog.coalesce or pg_catalog.nullif.
--
-- COALESCE and NULLIF are SQL constructs, not functions in the pg_catalog
-- schema, so a plpgsql body that calls them catalog-qualified applies without
-- error but raises on every run. #1108 removed the calls known then; this
-- migration re-creates the three functions whose live definition still called
-- the catalog-qualified form, changing only those calls to the unqualified
-- coalesce(...) and nullif(...) constructs.
--
-- Each function keeps its current owner, language, volatility, security,
-- search_path, comment and privileges. request_event_dispatch_wakeup gains its
-- canonical source here because it is changed for the first time under the
-- canonical-function convention; the other two canonical files are updated in
-- the same commit with the identical bodies below. No other statement, and no
-- signature, is changed.

begin;

-- postgres owns the vortex_connection and vortex_event schemas and the
-- functions replaced below.
set local role postgres;

-- vortex_connection.assert_human_administration_request (owner postgres; 1 catalog-qualified COALESCE call) --
create or replace function vortex_connection.assert_human_administration_request()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if coalesce(vortex_context.current_context() ->> 'callerKind', '') <> 'human' then
    raise exception using
      errcode = '42501',
      message = 'Connection administration requires a human request context';
  end if;
end
$function$;

revoke all on function vortex_connection.assert_human_administration_request()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_connection.assert_human_administration_request() is
  'Refuses any caller whose request context is not a human request; used by the connection administration entry points.';

-- vortex_event.request_event_dispatch_wakeup (owner postgres; 2 catalog-qualified NULLIF calls) --
create or replace function vortex_event.request_event_dispatch_wakeup()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  endpoint_url text := nullif(
    pg_catalog.current_setting('vortex.event_dispatch_wakeup_url', true), ''
  );
  bearer_credential text := nullif(
    pg_catalog.current_setting('vortex.event_dispatch_wakeup_bearer', true), ''
  );
begin
  -- Fail closed: an unconfigured endpoint or credential sends nothing.
  if endpoint_url is null or bearer_credential is null then
    return null;
  end if;
  -- Only a whitespace-free HTTPS endpoint is accepted, so a database setting
  -- cannot point the hint at a plaintext or non-HTTP target.
  if endpoint_url !~ '^https://[^[:space:]]+$' then
    return null;
  end if;
  -- The bearer must have the exact printable-ASCII shape and length the #641
  -- route accepts; anything else would only queue a doomed request.
  if bearer_credential !~ '^[!-~]+$'
    or pg_catalog.octet_length(bearer_credential) not between 32 and 512 then
    return null;
  end if;

  -- One hint per transaction is enough: a multi-occurrence append is one
  -- durable unit of work, and the scheduled recovery tick covers a missed
  -- hint. A later inserted row in the same transaction queues no second
  -- request.
  if pg_catalog.current_setting('vortex.event_dispatch_wakeup_sent', true) = 'true' then
    return null;
  end if;
  perform pg_catalog.set_config('vortex.event_dispatch_wakeup_sent', 'true', true);

  -- pg_net queues the request transactionally and sends it only after this
  -- transaction commits; a rolled-back append sends nothing. Best effort only:
  -- the hint must never make the durable append fail.
  begin
    perform net.http_post(
      url := endpoint_url,
      headers := pg_catalog.jsonb_build_object(
        'Authorization', 'Bearer ' || bearer_credential,
        'Content-Type', 'application/json'
      ),
      body := pg_catalog.jsonb_build_object('source', 'database_webhook'),
      timeout_milliseconds := 5000
    );
  exception when others then
    return null;
  end;
  return null;
end
$function$;

alter function vortex_event.request_event_dispatch_wakeup() owner to postgres;
revoke all on function vortex_event.request_event_dispatch_wakeup()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
comment on function vortex_event.request_event_dispatch_wakeup() is
  'Best-effort database-webhook wake-up hint for the protected Vercel event dispatcher, queued once per appending transaction and sent after commit. Reads its HTTPS endpoint and bearer credential from the vortex.event_dispatch_wakeup_url and vortex.event_dispatch_wakeup_bearer database settings at runtime and sends nothing when either is absent or unusable.';

reset role;

-- vortex_record is owned by vortex_record_owner, so it grants the adapter
-- schema CREATE transiently to replace its own function in place.
set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

-- vortex_record.append_record_lifecycle_effect_internal (owner vortex_record_adapter; 1 catalog-qualified NULLIF call) --
create or replace function vortex_record.append_record_lifecycle_effect_internal(
  p_effect_kind text,
  p_storage_contract_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_pre_concurrency_number bigint,
  p_relationship_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  bound_command_id uuid;
  receipt vortex_record.command_receipts%rowtype;
  next_sequence integer;
begin
  bound_command_id := nullif(
    pg_catalog.current_setting('vortex_record.lifecycle_command_id', true), ''
  )::uuid;
  if bound_command_id is null then
    return;
  end if;
  receipt := vortex_record.lock_command_receipt_internal('record_lifecycle', bound_command_id);
  if receipt.command_id is null
    or receipt.state is distinct from 'pending'
    or (receipt.operation = 'delete'
      and p_effect_kind not in ('soft_deleted', 'optional_cleared'))
    or (receipt.operation = 'restore' and p_effect_kind is distinct from 'restored') then
    raise exception using errcode = '42501',
      message = 'Record lifecycle effect journal is unavailable';
  end if;
  select coalesce(pg_catalog.max(effect.effect_sequence), 0) + 1 into next_sequence
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = receipt.organization_id
    and effect.application_root_id = receipt.application_root_id
    and effect.actor_organization_account_id = receipt.actor_organization_account_id
    and effect.command_id = receipt.command_id;
  insert into vortex_record.record_lifecycle_command_effects (
    organization_id, application_root_id, actor_organization_account_id,
    command_id, effect_sequence, effect_kind, storage_contract_id,
    record_type_id, record_id, relationship_id,
    pre_concurrency_number, post_concurrency_number
  ) values (
    receipt.organization_id, receipt.application_root_id,
    receipt.actor_organization_account_id, receipt.command_id, next_sequence,
    p_effect_kind, p_storage_contract_id, p_record_type_id, p_record_id,
    p_relationship_id, p_pre_concurrency_number, p_pre_concurrency_number + 1
  );
end
$function$;

revoke all on function vortex_record.append_record_lifecycle_effect_internal(
  text, uuid, uuid, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
comment on function vortex_record.append_record_lifecycle_effect_internal(
  text, uuid, uuid, uuid, bigint, uuid
) is
  'Journals one lifecycle effect for the command bound to this transaction; it does nothing when no command is bound.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
