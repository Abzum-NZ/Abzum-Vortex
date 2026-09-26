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

revoke all on function vortex_event.request_event_dispatch_wakeup()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
comment on function vortex_event.request_event_dispatch_wakeup() is
  'Best-effort database-webhook wake-up hint for the protected Vercel event dispatcher, queued once per appending transaction and sent after commit. Reads its HTTPS endpoint and bearer credential from the vortex.event_dispatch_wakeup_url and vortex.event_dispatch_wakeup_bearer database settings at runtime and sends nothing when either is absent or unusable.';
