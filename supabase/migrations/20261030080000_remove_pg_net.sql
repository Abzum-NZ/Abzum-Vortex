begin;

-- Prevent a new queued request between the check and extension removal.
lock table net.http_request_queue in access exclusive mode;
do $migration$
begin
  if exists (select 1 from net.http_request_queue) then
    raise exception 'Cannot remove pg_net while its HTTP request queue contains unsent requests';
  end if;
end
$migration$;

set local role vortex_owner;
drop trigger if exists event_outbox_dispatch_wakeup on vortex_platform.event_outbox;
reset role;
-- guard-allow: migration-owner-role The integration function is owned by postgres and must be dropped by its owner.
drop function if exists vortex_platform.request_event_dispatch_wakeup();
drop extension if exists pg_net;

commit;
reset role;
