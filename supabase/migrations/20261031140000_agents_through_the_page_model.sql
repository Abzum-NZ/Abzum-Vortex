-- SF-AGENT (#3742, #3751): agents act through the page model and the one page runner.
set role vortex_owner;

-- The server-driven run is gone: no request pauses a flow on the server or resumes it, so the
-- continuation store and its functions have no caller left.
drop function vortex_platform.issue_flow_continuation(text, uuid, uuid, uuid, uuid, uuid, text, jsonb, integer, integer);
drop function vortex_platform.peek_flow_continuation(text, uuid, uuid, uuid, uuid);
drop function vortex_platform.admit_flow_continuation(text, uuid, uuid, text, uuid);
drop function vortex_platform.complete_flow_continuation(text, uuid, text, jsonb, integer, integer, text);
drop table vortex_platform.flow_continuations;

reset role;
