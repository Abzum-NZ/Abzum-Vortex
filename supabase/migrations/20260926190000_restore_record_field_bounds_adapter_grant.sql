-- Restore the adapter-only definer mode and grant from
-- 20260912011556_fixed_record_adapters.sql after the later rebaseline.
-- The function body and existing owner stay unchanged.
alter function vortex_access.resolve_record_field_bounds_internal(jsonb)
  security definer;
alter function vortex_access.resolve_record_field_bounds_internal(jsonb)
  set search_path = '';

grant execute on function vortex_access.resolve_record_field_bounds_internal(jsonb)
  to vortex_record_adapter;
