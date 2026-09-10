# Landing Zone application

Tasks: [#376](https://github.com/Abzum-NZ/Abzum-Vortex/issues/376) blocks,
[#377](https://github.com/Abzum-NZ/Abzum-Vortex/issues/377) application,
[#378](https://github.com/Abzum-NZ/Abzum-Vortex/issues/378) record links,
[#379](https://github.com/Abzum-NZ/Abzum-Vortex/issues/379) action-items rail.

The user asked for a personal start page: a rail down one side, and a main area with
search, recently used, favourites accepting drag-and-drop, and a grid of applications.
Each person configures their own. Tiles may point at an application, a page, a record or
an address the person types in, and each tile opens either in a new page or in place.

## What this is not

It is not the [neutral organisation launcher](../specification/02-people-organisations-and-sign-in.md).
That page is deliberately minimal: it lists only tenant and organisation display names to a
verified identity that has not yet chosen an organisation, and exposes no applications, roles
or permissions. The Landing Zone lives after that choice, inside one organisation, and adds
nothing to the launcher's entry contract.

## Shipped and installed by default — user decision, 10 September 2026

Every organisation gets the Landing Zone. It joins the platform applications that
[#72](https://github.com/Abzum-NZ/Abzum-Vortex/issues/72) already ships as locked, versioned
definitions built from ordinary modules, records, pages and permissions. Organisation
provisioning installs it and marks it the organisation's default application through the
**same protected installation operation** any application uses; provisioning supplies the
authority and adds no second installation path or backdoor. This reuses an existing concept
rather than adding an auto-install mechanism.

It is shipped, not frozen. An organisation may afterwards change the default, add rail
placements or replace the application entirely, exactly as it may for any installed
application. Nothing in the platform depends on the Landing Zone being present.

## Boundary decision

The Landing Zone is an ordinary application. Favourites, recency, bookmarks and the tile
model are definition semantics owned by that application, not engine behaviour. Four items
are platform, each because an ordinary definition cannot express it:

| Item | Owner | Why it cannot be an ordinary definition |
| --- | --- | --- |
| Permitted-applications read | [#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64) | Applications and who may open them are protected Access and Application data, not records. |
| Organisation default application | [#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64) | An application cannot declare itself the organisation's start point; two could claim it, and the choice belongs to the organisation. |
| Link, launcher and filter blocks | [#376](https://github.com/Abzum-NZ/Abzum-Vortex/issues/376) | Blocks are the platform's presentation vocabulary; customers cannot supply components. A link that opens a platform target is as generic as navigation. |
| Viewer-safe record link resolution | [#378](https://github.com/Abzum-NZ/Abzum-Vortex/issues/378) | A link field must enumerate its target record types at publication and cannot cover every record type of every installed application; reading an application-contained record from another application's context is refused; and copying the title at pin time is the leak this prevents. |

## Per-user configuration

Tiles are records in the Landing Zone's own module, in application-contained storage, owned
by the organisation account that created them. Every tile permission's only record scope
route is ownership, and the module declares no all-records permission — so no role in the
organisation can read another person's tiles through it. This reuses the existing ownership
route and record-visibility enforcement rather than adding a preference store.

Reordering favourites writes the moved tile's order as the midpoint between its neighbours:
one record write per move, with no renumbering pass over the rest.

## The rail is a page slot

A shell already declares layout placements and named content slots, each with `required` and
`allowedChildCategories`, and a page binds the shell and supplies content per slot. The rail
is therefore an ordinary optional content slot in the Landing Zone shell. No widget registry,
dashboard framework or dispatcher is added.

An empty rail renders at its declared width with its accessible name and no items — no
placeholder text. A placement whose bound capability is unavailable in the organisation
renders its unavailable state, which is what the specification's requirement that missing
capabilities stay visibly unavailable rather than mocked means here. An unregistered block
cannot publish at all, so it can never appear.

"Items needing my action" is one placement in that slot, delivered by
[#379](https://github.com/Abzum-NZ/Abzum-Vortex/issues/379) once the Workflow Inbox exists.
Making the rail a slot is what removes the Phase 7 dependency from the Landing Zone itself.

## Tiles and live availability

Tile targets are resolved on the server for the current person before anything reaches the
browser. Application and page tiles show the live application name and icon from the
permitted-applications read, never the stored label, so a withdrawn or refused application
becomes neutral on the next load. An unavailable tile shows a fixed "Unavailable" label with
no name, icon, address or reason, cannot be activated, and offers only removal; not
installed, withdrawn and refused are indistinguishable.

Page-level access is enforced by the destination page on open rather than on the landing
page. Evaluating every target application's context on each landing-page load is not
proportionate for the first release, so a tile is honest at application level live and at
page level on open.

A tile is user-authored data. It never grants access to what it names, and no engine reads a
tile to decide access.

## Addresses the person types in

HTTPS only, with no embedded credentials and at most 2,048 characters. This is enforced in
`safeHttpsUrlSchema`, the single place that already governs `web_address` fields, navigation
external links and public addresses — a root-cause correction rather than a block-level guard.
`javascript:`, `data:`, `http:` and `file:` are refused as invalid field values.

An external address is always a full document navigation and is never rendered inside the
application shell. "Replace" navigates the same tab after unsaved-work protection; "new page"
opens without opener access or referrer, so the destination cannot script the Vortex tab or
learn the organisation path. The server never fetches an address on the person's behalf,
which removes server-side request forgery and cross-tenant probing at the cause. A
same-origin address pointing at a protected platform route is treated as any other address:
the destination route applies its own checks and the tile gains no authority over it.

## Recently used

Recency covers only targets opened through the Landing Zone. The platform does not track page
visits and Activity records no ordinary reads, so wider tracking has no existing primitive and
none is proposed.

## Sequencing

The Landing Zone consumes the critical path rather than sitting on it. It cannot start before
the application runtime [#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64), the block
runtime [#66](https://github.com/Abzum-NZ/Abzum-Vortex/issues/66) and page permission
projection [#69](https://github.com/Abzum-NZ/Abzum-Vortex/issues/69).

It follows rather than joins the definition-led application proof
[#327](https://github.com/Abzum-NZ/Abzum-Vortex/issues/327). That proof is deliberately
narrowed to the existing fixtures through the Phase 4–6 engines and creates no new engine;
the Landing Zone needs new blocks and the default-application marker, so folding it in would
widen the proof's acceptance and add risk to the critical path. It is instead the first
definition-led application delivered after #327, reusing the same evidence pattern.
