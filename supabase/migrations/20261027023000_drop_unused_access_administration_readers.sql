-- Access administration readers beside the protected projections (ARCH4 D9). The organisation role
-- list and role assignment list read the same data as the protected roles and role assignments
-- projections; their one caller, local development setup, now reads those projections, which apply
-- the same administration scope inside (role administration, assignment ledger). The role assignment,
-- delegation authority, role activation, group and group membership list and detail readers had no
-- caller at all. Nothing in the repository or the database names any of them (checked across
-- packages, apps, tooling, workflows, supabase/schemas and docs). Their canonical files are removed.
set role vortex_owner;

drop function vortex_access.list_organization_roles_for_administration(uuid, integer);
drop function vortex_access.list_organization_role_assignments_for_administration(uuid, integer);
drop function vortex_access.read_organization_role_assignment_for_administration(uuid);
drop function vortex_access.list_organization_delegation_authorities_for_administration(uuid, integer);
drop function vortex_access.read_organization_delegation_authority_for_administration(uuid);
drop function vortex_access.list_organization_role_activations_for_administration(uuid, integer);
drop function vortex_access.read_organization_role_activation_for_administration(uuid);
drop function vortex_access.list_organization_groups_for_administration(uuid, integer);
drop function vortex_access.list_organization_group_memberships_for_administration(uuid, uuid, integer);
drop function vortex_access.read_organization_group_membership_for_administration(uuid);

grant execute on function vortex_access.list_organization_roles_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_request;
grant execute on function vortex_access.list_organization_role_assignments_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_request;

reset role;
