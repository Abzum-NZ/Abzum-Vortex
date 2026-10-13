set local role vortex_owner;

drop function vortex_record.read_current_legal_holds(jsonb);
drop policy legal_hold_versions_validated_scope on vortex_record.legal_hold_versions;
drop table vortex_record.legal_hold_versions;

reset role;
