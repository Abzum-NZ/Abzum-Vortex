begin;

set local role vortex_record_adapter;
alter function vortex_record.save_organization_settings_record(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) owner to vortex_record_adapter;
reset role;

commit;
