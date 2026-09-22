-- #642: Database-webhook wake-up hints and safe dispatcher backlog status.
--
-- The durable event outbox and logged queue remain authoritative. This
-- migration adds only a best-effort wake-up hint, fired once after an outbox
-- append commits, and one bounded, content-free backlog reader. Neither claims
-- work, settles a claim, mutates an outbox row nor replaces dispatch.
--
-- The wake-up endpoint and its bearer credential are environment-managed
-- database server settings, read from custom GUCs at call time:
--
--   vortex.event_dispatch_wakeup_url
--   vortex.event_dispatch_wakeup_bearer
--
-- Both are optional. When either is absent, empty, non-HTTPS or too short the
-- hint is skipped and no request leaves the database, so missing configuration
-- fails closed. No credential, endpoint or Vault entry is stored by this
-- migration or committed to the repository. A hint is a hint, never delivery
-- proof: queueing a request never blocks or rolls back the durable append.

begin;

set local role postgres;

create extension if not exists pg_net;

create function vortex_event.request_event_dispatch_wakeup()
returns void
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
    return;
  end if;
  -- Only a whitespace-free HTTPS endpoint is accepted, so a database setting
  -- cannot point the hint at a plaintext or non-HTTP target.
  if endpoint_url !~ '^https://[^[:space:]]+$' then
    return;
  end if;
  -- The bearer is compared by #641 to a configured SHA-256 digest; refuse an
  -- obviously unusable value here instead of queueing a doomed request.
  if pg_catalog.octet_length(bearer_credential) not between 32 and 512 then
    return;
  end if;

  -- One hint per transaction is enough: a multi-occurrence append is one
  -- durable unit of work, and the scheduled recovery tick covers a missed
  -- hint. A later statement in the same transaction queues no second request.
  if pg_catalog.current_setting('vortex.event_dispatch_wakeup_sent', true) = 'true' then
    return;
  end if;
  perform pg_catalog.set_config('vortex.event_dispatch_wakeup_sent', 'true', true);

  -- Best effort only: the hint must never make a committed record save fail.
  begin
    perform net.http_post(
      url := endpoint_url,
      headers := pg_catalog.jsonb_build_object(
        'Authorization', 'Bearer ' || bearer_credential,
        'Content-Type', 'application/json',
        'X-Vortex-Wakeup-Source', 'database_webhook'
      ),
      body := pg_catalog.jsonb_build_object('source', 'database_webhook'),
      timeout_milliseconds := 5000
    );
  exception when others then
    return;
  end;
end
$function$;

-- A statement-level trigger coalesces a multi-row insert into one hint and
-- fires only after the occurrences are durable in this transaction. The same
-- endpoint also handles the scheduled recovery tick, so one bounded operation
-- serves both wake-up sources.
create trigger event_outbox_dispatch_wakeup
after insert on vortex_event.event_outbox
for each statement execute function vortex_event.request_event_dispatch_wakeup();

-- Bounded, content-free backlog status over the #639/#640 consumer claim rows.
-- It returns only the age of the oldest live unsettled claim and how many
-- claims are terminally failed, and exposes no occurrence identity, consumer
-- identity or event payload. Counts and ages are capped so the result is safe
-- and bounded even under a large backlog.
create function vortex_event.event_dispatch_backlog_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with pending as (
    select pg_catalog.min(progress.claimed_at) as oldest_claimed_at
    from vortex_event.consumer_occurrence_progress as progress
    where progress.acknowledged_at is null
      and progress.terminally_failed_at is null
  ), failed as (
    select pg_catalog.count(*) as failure_count
    from vortex_event.consumer_occurrence_progress as progress
    where progress.terminally_failed_at is not null
  )
  select pg_catalog.jsonb_build_object(
    'oldestPendingAgeSeconds',
      case
        when pending.oldest_claimed_at is null then null
        else pg_catalog.least(
          2592000,
          pg_catalog.greatest(
            0,
            pg_catalog.floor(
              pg_catalog.extract(
                epoch from (pg_catalog.statement_timestamp() - pending.oldest_claimed_at)
              )
            )
          )
        )::integer
      end,
    'terminalFailureCount',
      pg_catalog.least(failed.failure_count, 1000000::bigint)::integer
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
  'Best-effort database-webhook wake-up hint for the protected Vercel event dispatcher. Reads its HTTPS endpoint and bearer credential from the vortex.event_dispatch_wakeup_url and vortex.event_dispatch_wakeup_bearer database settings at runtime and sends nothing when either is absent or unusable.';
comment on function vortex_event.event_dispatch_backlog_status() is
  'Bounded, content-free event delivery backlog: oldest live unsettled claim age in seconds and terminal failure count. Reveals no occurrence identity, consumer identity or payload.';

reset role;
commit;
