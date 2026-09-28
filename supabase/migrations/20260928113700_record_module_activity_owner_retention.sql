-- Preserve postgres ownership until the cross-schema appender can run behind an
-- Activity-owned definer interface. The current appender is SECURITY INVOKER.
alter function vortex_record.append_base_save_activity_internal(
  uuid, text, uuid, uuid[], text
) owner to postgres;
alter function vortex_record.append_lifecycle_policy_activity_internal(uuid, uuid)
  owner to postgres;
alter function vortex_record.append_named_action_activity_internal(uuid, uuid, uuid[], text)
  owner to postgres;
alter function vortex_record.append_ownership_transfer_activity_internal(uuid, uuid, text)
  owner to postgres;
alter function vortex_record.append_record_lifecycle_activity_internal(uuid, text, uuid[])
  owner to postgres;
alter function vortex_module.append_application_installation_activity_internal(uuid, uuid, text)
  owner to postgres;

-- This helper directly reads vortex_access.permission_registrations. Keep the
-- cross-schema table read with postgres until Access exposes an equivalent definer.
alter function vortex_module.is_current_application_address_release(bigint)
  owner to postgres;
