# Studio-generated pages: appearance review

Issue: [#2897](https://github.com/Abzum-NZ/Abzum-Vortex/issues/2897).
Reviewed on 19 October 2026 against `b9ca613d`, which was `origin/main` when the
production build and fresh database setup began.

## Application and method

Created **Validation Workshop** (`val.workshop2897`) in Studio, rather than using
the shipped CRM. Its owned module contains a Job record type with these fields:

| Field         | Type             | Configuration                         |
| ------------- | ---------------- | ------------------------------------- |
| Job number    | Reference number | Created with the record type          |
| Name          | Text             | Required title                        |
| Stage         | Choice           | Queued, Working, Finished; filterable |
| Contact phone | Phone number     | Local validation number               |
| Parts         | Table            | Starter required text column `item`   |
| Related job   | Link to a record | Another Job; many-to-one               |

Created the Workshop progress pipeline, permitting Queued → Working and Working
→ Finished. Generated List, Detail, Create form and Edit form through **Structure
→ Add → Page for a record type**. Added a Board to Home through the Blocks palette
and selected that pipeline. Reloaded Studio to check the saved generated pages.
Published version 1.0.0 and installed it through App Store, selecting **Give me the
role Members now**.

Used a production Next.js build, freshly reset Supabase lane 7, the isolated
`val-2897@vortex.test` account, and headless Playwright with Microsoft Edge.
The build completed before taking the lane. No automated tests were created or
run. Browser screenshots and temporary walkthrough scripts are outside the repository.

## Results

The matrix uses 1440 × 1000 and 390 × 844 CSS-pixel viewports. Appearance was
selected through the application's Light/Dark menu for every capture.

| Page        | Light 1440 | Dark 1440 | Light 390 | Dark 390 | Functional result                                            |
| ----------- | ---------- | --------- | --------- | -------- | ------------------------------------------------------------ |
| Jobs list   | Pass       | Pass      | Pass      | Pass     | Two saved records; selecting a row opens its detail           |
| Create form | Pass       | Pass      | Pass      | Pass     | Choice, phone, Parts row and related-record selection save    |
| Edit form   | Pass       | Pass      | Pass      | Pass     | Stored table row reappears; changes survive reload            |
| Job detail  | See #3080  | See #3080 | See #3080 | See #3080 | Choice, phone and related label render; table value is hidden |
| Board       | Pass       | Pass      | Pass      | Pass     | Stage buckets render; allowed move persists after reload      |

All captured pages had document and body widths equal to the viewport width.
The phone Board confines horizontal scrolling to its columns; keyboard Right
arrows moved that region to `scrollLeft = 320` with a 326-pixel client width and
1060-pixel scroll width. Its later columns were also inspected by scrolling to
the end. List columns follow the generated responsive definition.

Created Pump inspection with Stage Queued, a phone number and Parts row
`item = Seal kit`. Created Valve replacement in Working, linked to Pump
inspection. The linked record's label rendered in detail, and the reverse-related
list showed Valve replacement. Changed the phone, saved, reloaded and reverted
it. At 390 pixels, changed the title, saved, reloaded, reverted and reloaded again.
Moved Pump inspection to Working through its Board card menu; both records
appeared in Working after reload.

The final navigation pass returned HTTP 200 for `jobs`, `new_job`, `job`,
`edit_job` and `home`, with no browser console errors or page errors during that
pass. This was a small functional and visual walkthrough, not a performance,
contrast-ratio or complete accessibility audit.

## Defect

[#3080: Generated detail pages hide saved table field rows as No value](https://github.com/Abzum-NZ/Abzum-Vortex/issues/3080)
tracks the failed detail result in milestone **Demo: CRM rebuilt in App Studio**.
The generated edit form retains `Seal kit`, including after reload, while the
same record's detail shows an em dash with accessible text **No value**.

The projection currently maps structured table rows to an empty display cell.
Displaying them requires coordinated field metadata, a closed projected value
contract and its renderer, including column labels and permission-safe linked
values. This is broader than a bounded theme correction. The issue contains the
exact Studio reproduction and paired edit/detail screenshots. No renderer or
grid-owned files were changed for this review.

## Screenshots

The [draft proof release](https://github.com/Abzum-NZ/Abzum-Vortex/releases/tag/untagged-e21dd79e668b5644a446)
contains the matrix and supplementary screenshots. Its configured tag is
`m2897-proof-20261019`; GitHub currently exposes draft assets under the temporary
release URL above. Draft access requires repository access. Delete the draft
release after the review PR merges.

Matrix filenames use `<page>-<appearance>-<width>.png`, where page is `list`,
`create`, `edit`, `detail` or `board`; appearance is `light` or `dark`; and width is
`1440` or `390`. Supplementary files show the populated related detail, the
Board's last phone columns, the related-record list and a saved phone edit.

The worker's server and browser were stopped and its lane/dev locks released
after the walkthrough. The report preserves the inspected build above; it does
not claim later main commits were part of that build.
