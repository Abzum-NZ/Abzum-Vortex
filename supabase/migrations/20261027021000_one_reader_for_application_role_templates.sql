-- Application role templates had a second and a third reader beside the protected
-- application_role_templates projection (ARCH4 D1): an administration list and an administration
-- detail read of the same continuities, registrations and releases. Their only caller was local
-- development setup, which now takes each installed application's templates from its active
-- release exactly as an App Store install does. The administration permission list and detail
-- reads served only that setup step and are removed with it. Their canonical files are removed.
set role vortex_owner;

drop function vortex_access.list_application_role_templates_for_administration(uuid, uuid, integer);
drop function vortex_access.read_application_role_template_for_administration(uuid, uuid);
drop function vortex_access.list_organization_permissions_for_administration(uuid, text, uuid, uuid, integer);
drop function vortex_access.read_organization_permission_for_administration(uuid, text, uuid, uuid);

reset role;
