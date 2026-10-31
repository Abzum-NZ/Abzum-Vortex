-- DT-8: write-only tables. organization_activity_super_administrator_authority gets a side row
-- for every activity entry a super administrator causes, and nothing has ever read it: no
-- projection, view or function selects authority_kind or assignment_id. The table, its
-- recording trigger and its immutability trigger go. alert_signals stays: it is the
-- Operations alert log, written by the live alert sink, and its comment now says so.

set role vortex_owner;

drop trigger organization_activity_super_administrator_authority_record
  on vortex_record.organization_activity_entries;
drop table vortex_record.organization_activity_super_administrator_authority;
drop function vortex_record.record_super_administrator_authority_internal();
drop function vortex_record.refuse_super_administrator_authority_change();

comment on table vortex_platform.alert_signals is
  'The Operations alert log: protected, content-free alert signals written by record_alert_signal from the Operations alert sink, deduplicated by the producer key with an occurrence count and first and last occurrence times. It is kept as an audit log; no product page reads it.';

reset role;
