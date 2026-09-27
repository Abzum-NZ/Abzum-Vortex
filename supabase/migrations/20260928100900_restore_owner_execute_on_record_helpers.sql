begin;

set local role vortex_record_owner;

grant execute on function vortex_record.is_record_type_lifecycle_policy(jsonb)
  to vortex_record_owner;
grant execute on function vortex_record.initialize_organization_lifecycle_limits(uuid, jsonb)
  to vortex_record_owner;

reset role;

commit;
