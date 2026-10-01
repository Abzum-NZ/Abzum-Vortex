create or replace function vortex_operations.alert_signal_builder_key_is_valid(p_key text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select p_key is not null
    and pg_catalog.length(p_key) between 1 and 40
    and p_key ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
$function$;
revoke all on function vortex_operations.alert_signal_builder_key_is_valid(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_operations.alert_signal_builder_key_is_valid(text)
  to vortex_operations_owner;

comment on function vortex_operations.alert_signal_builder_key_is_valid(text) is
  'Private check for the contract builder-key shape used by alert service and owning-role fields.';

alter function vortex_operations.alert_signal_builder_key_is_valid(text)
  owner to postgres;
