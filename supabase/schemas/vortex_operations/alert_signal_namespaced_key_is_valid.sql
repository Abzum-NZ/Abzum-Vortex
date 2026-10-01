create or replace function vortex_operations.alert_signal_namespaced_key_is_valid(p_key text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select p_key is not null
    and pg_catalog.length(p_key) between 3 and 120
    and p_key ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$'
    and not exists (
      select 1
      from pg_catalog.unnest(pg_catalog.string_to_array(p_key, '.')) as part(value)
      where pg_catalog.length(part.value) > 40
    )
$function$;
revoke all on function vortex_operations.alert_signal_namespaced_key_is_valid(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_operations.alert_signal_namespaced_key_is_valid(text)
  to vortex_operations_owner;

comment on function vortex_operations.alert_signal_namespaced_key_is_valid(text) is
  'Private check for the contract namespaced-key shape used by alert code and runbook-reference fields.';

alter function vortex_operations.alert_signal_namespaced_key_is_valid(text)
  owner to postgres;
