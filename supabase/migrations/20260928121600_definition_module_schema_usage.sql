-- Grant as the Module schema owner so Definition receives effective schema access.
begin;

set local role vortex_module_owner;
grant usage on schema vortex_module to vortex_definition_owner;
reset role;

commit;
