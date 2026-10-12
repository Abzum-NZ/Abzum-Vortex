begin;

set local role vortex_access_owner;

grant execute on function vortex_access.validation_reference_list(text) to postgres;

commit;
