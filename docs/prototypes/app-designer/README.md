# App Designer — canvas-first HTML prototype

[Open the HTML](index.html) · [Prototype task #323](https://github.com/Abzum-NZ/Abzum-Vortex/issues/323) · [Full acceptance plan](../../build-plan/app-designer-html-prototype.md)

## Current checkpoint

The 7 September 2026 layout checkpoint implements the user's supplied dark shell-editor direction: application navigation, contextual palette, central canvas and right-hand inspector. It is a self-contained, disposable HTML prototype. It contains no external dependencies, live database calls, real publication, permission grants or authenticated Vortex MCP server. Reloading resets its draft. The full prototype task remains open.

## Try it

1. Start on **Pages**. Drag a Records table, Form or Action button from the left palette onto the page. Clicking the tile is the keyboard-friendly alternative.
2. Select a component and choose **Configure component** to change its label or linked flow. Tables require a flow returning rows. **Outline** provides explicit component ordering.
3. Choose **Edit linked flow**. Drag a node from the searchable palette onto the graph; drag its grip to reposition it. Alt + arrow keys on the grip move it without a pointer.
4. Drag an output circle to an input circle, or click the two circles in sequence. Conditions have separate matches/otherwise outputs. The inspector shows outgoing connections and Disconnect. Moving a node changes presentation, not its execution route.
5. Configure nodes and typed flow variables. Current user, Specified user and scoped System are configuration choices, not authority grants. Managed-flow internals remain absent; the bound table exposes public settings.
6. **Try form continuation** demonstrates required input, continuation and cancellation before/after an explicit simulated write. It is a scripted interaction example, not an interpreter of the edited graph.
7. Explore the other application sections, **Validate**, **Preview draft**, and **Review release**. Publication and installation are clearly separate simulations. Missing-dependency, unavailable-authority and stale-revision states are selectable from validation.

## UI and agent coverage

Where the browser supports WebMCP, the prototype registers four local tools: read, navigate, configure and simulate. They use the same draft operations and revision checks as the visible controls. Their names explicitly identify them as demo tools. The live authenticated transport and complete authoring parity remain [#200](https://github.com/Abzum-NZ/Abzum-Vortex/issues/200), using the domain operations owned below.

| Authoring capability                           | Implementation owners                                                                                                                                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application and module composition             | [#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64), [#43](https://github.com/Abzum-NZ/Abzum-Vortex/issues/43), [#52](https://github.com/Abzum-NZ/Abzum-Vortex/issues/52)                                                              |
| Fields, relationships, exposed queries         | [#44](https://github.com/Abzum-NZ/Abzum-Vortex/issues/44), [#49](https://github.com/Abzum-NZ/Abzum-Vortex/issues/49), [#52](https://github.com/Abzum-NZ/Abzum-Vortex/issues/52), [#54](https://github.com/Abzum-NZ/Abzum-Vortex/issues/54)   |
| Pages, slots, components, navigation           | [#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249), [#65](https://github.com/Abzum-NZ/Abzum-Vortex/issues/65), [#66](https://github.com/Abzum-NZ/Abzum-Vortex/issues/66), [#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64) |
| Data/action bindings and forms                 | [#250](https://github.com/Abzum-NZ/Abzum-Vortex/issues/250), [#67](https://github.com/Abzum-NZ/Abzum-Vortex/issues/67), [#68](https://github.com/Abzum-NZ/Abzum-Vortex/issues/68)                                                            |
| Frontend nodes, conditions, execution identity | [#58](https://github.com/Abzum-NZ/Abzum-Vortex/issues/58), [#57](https://github.com/Abzum-NZ/Abzum-Vortex/issues/57), [#322](https://github.com/Abzum-NZ/Abzum-Vortex/issues/322)                                                            |
| Background definitions and starts              | [#76](https://github.com/Abzum-NZ/Abzum-Vortex/issues/76), [#77](https://github.com/Abzum-NZ/Abzum-Vortex/issues/77), [#78](https://github.com/Abzum-NZ/Abzum-Vortex/issues/78)                                                              |
| Role templates and governed IAM                | [#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64), [#72](https://github.com/Abzum-NZ/Abzum-Vortex/issues/72), [#267](https://github.com/Abzum-NZ/Abzum-Vortex/issues/267)                                                            |
| Connections and protected interfaces           | [#99](https://github.com/Abzum-NZ/Abzum-Vortex/issues/99), [#102](https://github.com/Abzum-NZ/Abzum-Vortex/issues/102), [#103](https://github.com/Abzum-NZ/Abzum-Vortex/issues/103)                                                          |
| Preview, publication and installation          | [#73](https://github.com/Abzum-NZ/Abzum-Vortex/issues/73), [#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64)                                                                                                                         |

## Verification of this checkpoint

- Inline JavaScript parsed successfully; the repository formatter completed.
- The actual browser displayed all four areas, the page component canvas and the connected frontend graph.
- A Condition tile was dragged from the palette into the graph; WebMCP read-back confirmed its new identity, position and one draft revision change.
- Both click-to-connect and an exact-coordinate port drag changed the stored graph connection. Alt + Right on a node grip changed its position and retained keyboard focus.
- All four intended WebMCP tools completed representative valid calls. Unsupported read/navigation input and stale configuration/simulation calls refused; read-back retained the previous revision and node label.
- The visible form-continuation example refused empty input, then accepted a value and reported the simulated committed save separately from the still-pending background request.
- Phone layout was visually checked; phone/tablet document-width checks showed no page-level horizontal overflow. The graph scrolls inside its own viewport. Temporary viewport overrides were reset. Full responsive, enlarged-text and reduced-motion acceptance remains to be completed for the whole task.
- Independent Sol review approved the corrected layout checkpoint at HTML SHA-256 `936E5FD49304D20B0359F9EA591FC49D0858A41FD98BA4387EB66C8291233AE4`. It checked generic boundaries, shared UI/tool operations, managed-graph non-disclosure, connection integrity, palette placement and truthful simulated results. No whole-task completion was claimed.

## Testing source delivery — 7 September 2026

[PR #325](https://github.com/Abzum-NZ/Abzum-Vortex/pull/325) merged normally into Testing at `2026-09-07T03:35:43Z`, after both preview checks passed. Reviewed source `dbd1c8053c47f075a2a4aee02006bb560d10559b` and Testing merge `763df5c7d0101a8145189b3f1ac21a8fb5c3e321` have the identical tree `c9110b2795e19e83efad0979a2cf5918f4dc6c79`. This delivers the six prototype/documentation files only; it does not deliver the separate uncommitted Phase 3 work, complete the whole prototype, or claim a Production deployment.

## Remaining full-prototype acceptance

Create an application from blank; remove definitions/components/nodes; complete typed condition and node-reference editors; complete background, shell/slot and history/restore walkthroughs; final whole-journey accessibility, responsive and screenshot evidence. The current metadata editors and scripted form example do not claim those complete capabilities. Keep [#323](https://github.com/Abzum-NZ/Abzum-Vortex/issues/323) open and do not start the production designer because this layout checkpoint passed.
