# Demo walkthrough

A scripted tour of the local demo: the core applications `pnpm demo:setup` installs. Further applications are built in App Studio and installed from the App Store.

## Before you start

1. Start the local database and run `pnpm demo:setup` (it resets the database and installs every core application).
2. Run `pnpm dev` and open the site URL printed by the setup.
3. Pages live under `/<tenant>/<organisation>/<application>/<page>`. The setup uses `abzum/abzum`.

The setup installs IAM, Landing Zone, Operations, Organisation Administration, Tenant Administration and the App Store, with the first owner holding the application roles.

## 1. Sign in

1. Open `/auth/sign-in`.
2. Enter `VORTEX_DEMO_OWNER_EMAIL` and `VORTEX_DEMO_OWNER_PASSWORD` from `apps/web/.env.development.local`.
3. You arrive on **Landing Zone > Home**, the organisation's default application.

## 2. Find the IAM and Landing Zone views

1. **Landing Zone** > **Home** shows the application tiles; **All applications** lists the installed core applications.
2. **IAM** > **People** lists the organisation's accounts (the first owner).
3. **IAM** > **Assignments** is the role assignment ledger: the application installer and the other roles granted to the first owner.
4. **IAM** > **Roles and Groups** shows the roles and groups; **Access Requests** holds requests for access.
