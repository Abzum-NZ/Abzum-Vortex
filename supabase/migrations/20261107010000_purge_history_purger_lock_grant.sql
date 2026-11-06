-- Deleting an application with its data failed with "permission denied for function
-- lock_application_installation_authority": the history purger runs the history deletion, which
-- locks the installation authority, and its execute grant was given on the no-argument signature
-- that 20261102070000 replaced by the one taking the recent-authentication requirement. The grant
-- moves to the live signature.
set role vortex_owner;

grant execute on function vortex_access.lock_application_installation_authority(jsonb)
  to vortex_history_purger;

reset role;
