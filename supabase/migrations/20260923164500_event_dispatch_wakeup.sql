-- #642: Database-webhook wake-up hints and safe dispatcher backlog status.
--
-- The durable event outbox and logged queue remain authoritative. This
-- migration adds only a best-effort wake-up hint, queued once per transaction
-- that appends an outbox occurrence and sent only after that transaction
-- commits, and one bounded, content-free backlog reader. Neither claims work,
-- settles a claim, mutates an outbox row nor replaces dispatch.
--
-- The wake-up endpoint and its bearer credential are environment-managed
-- database server settings, read from custom GUCs at call time:
--
--   vortex.event_dispatch_wakeup_url
--   vortex.event_dispatch_wakeup_bearer
--
-- Both are optional. When either is absent, empty, non-HTTPS or not a usable
-- bearer credential the hint is skipped and no request leaves the database, so
-- missing configuration fails closed. No credential, endpoint or Vault entry is
-- stored by this migration or committed to the repository. Database sessions
-- can read these settings, so the credential must authorise nothing beyond the
-- bounded dispatcher wake-up. A hint is a hint, never delivery proof: queueing
-- a request never blocks or rolls back the durable append.

begin;

set local role postgres;

create extension if not exists pg_net;

create function vortex_event.request_event_dispatch_wakeup()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  endpoint_url text := pg_catalog.nullif(
    pg_catalog.current_setting('vortex.event_dispatch_wakeup_url', true), ''
  );
  bearer_credential text := pg_catalog.nullif(
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

-- A row-level trigger fires only for an occurrence that was actually
-- appended, and the transaction-local marker above coalesces every row of one
-- transaction into a single hint. The same protected endpoint also handles the
-- scheduled recovery tick, so one bounded operation serves both sources.
create trigger event_outbox_dispatch_wakeup
after insert on vortex_event.event_outbox
for each row execute function vortex_event.request_event_dispatch_wakeup();

-- Bounded, content-free backlog status over the #639/#640 consumer claim rows.
-- It returns only the age of the oldest claimed occurrence that is neither
-- acknowledged nor terminally failed, measured from when the occurrence was
-- appended so a retried or reclaimed claim keeps ageing, and how many claims
-- are terminally failed. It exposes no occurrence identity, consumer identity
-- or event payload. The failure count stops at its cap and the age is capped,
-- so the result stays bounded under a large backlog.
create function vortex_event.event_dispatch_backlog_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with pending as (
    select pg_catalog.min(occurrence.occurred_at) as oldest_occurred_at
    from vortex_event.consumer_occurrence_progress as progress
    join vortex_event.event_outbox as occurrence
      on occurrence.occurrence_id = progress.occurrence_id
    where progress.acknowledged_at is null
      and progress.terminally_failed_at is null
  ), failed as (
    select pg_catalog.count(*) as failure_count
    from (
      select 1
      from vortex_event.consumer_occurrence_progress as progress
      where progress.terminally_failed_at is not null
      limit 1000000
    ) as bounded
  )
  select pg_catalog.jsonb_build_object(
    'oldestPendingAgeSeconds',
      case
        when pending.oldest_occurred_at is null then null
        else pg_catalog.least(
          2592000,
          pg_catalog.greatest(
            0,
            -- EXTRACT is SQL syntax, not a schema-qualifiable call; it always
            -- resolves from pg_catalog even under the empty search_path.
            pg_catalog.floor(
              extract(
                epoch from (pg_catalog.statement_timestamp() - pending.oldest_occurred_at)
              )
            )
          )
        )::integer
      end,
    'terminalFailureCount', failed.failure_count::integer
  )
  from pending, failed;
$function$;

alter function vortex_event.request_event_dispatch_wakeup() owner to postgres;
alter function vortex_event.event_dispatch_backlog_status() owner to postgres;

-- The wake-up hint is reachable only through its trigger; grant no caller the
-- ability to send arbitrary outbound requests. The backlog reader is exposed
-- only to the server-only runtime role that the protected route already uses.
revoke all on function vortex_event.request_event_dispatch_wakeup()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
revoke all on function vortex_event.event_dispatch_backlog_status()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;

grant execute on function vortex_event.event_dispatch_backlog_status() to vortex_runtime;

comment on function vortex_event.request_event_dispatch_wakeup() is
  'Best-effort database-webhook wake-up hint for the protected Vercel event dispatcher, queued once per appending transaction and sent after commit. Reads its HTTPS endpoint and bearer credential from the vortex.event_dispatch_wakeup_url and vortex.event_dispatch_wakeup_bearer database settings at runtime and sends nothing when either is absent or unusable.';
comment on function vortex_event.event_dispatch_backlog_status() is
  'Bounded, content-free event delivery backlog: age in seconds of the oldest claimed occurrence not yet acknowledged or terminally failed, and the terminal failure count. Reveals no occurrence identity, consumer identity or payload.';

reset role;
commit;
