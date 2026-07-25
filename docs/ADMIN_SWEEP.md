# Admin portal browser sweep — findings

Manual click-through of every super-admin and org-admin screen in a real
browser, instrumented to record failed API calls (XHR + fetch) and uncaught JS
errors. Motivated by the WebSocket bug: the frontend was written against a spec
and had never been exercised in a browser, so contract drift could hide.

## Coverage

| Screen | Read | Write exercised | Result |
|---|---|---|---|
| Admin dashboard | ✓ | — | stats render |
| Organizations | ✓ | create, rename (slug regen), status toggle, type-to-confirm delete | pass |
| Departments | ✓ | org cascade, create | pass |
| Users | ✓ | create (org→dept cascade, email availability, auto-password), edit, reset password, bulk deactivate | pass |
| Cross-Org Groups | ✓ | full 4-step wizard: name/purpose → 2 orgs → members → admin assign → create | pass |
| Admin settings | ✓ | — | placeholder screen, as designed |
| Org-admin dashboard/users/departments/settings | ✓ | create user | pass |

**0 failed API calls, 0 uncaught JS errors across every screen.**

Server-side verification (not just UI optimism): renames and slug regeneration
persisted; soft-delete set `is_active=false`; `must_change_password` set by
reset-password; bulk deactivate applied; audit rows written for every mutation
(`create_organization`, `update_organization`, `delete_organization`,
`create_user`, `update_user`, `reset_password`, `bulk_deactivate`,
`user_created` with `actor_type=org_admin`); cross-org group stored with
`type=cross_org`, correct `purpose_tag`, 2 orgs, and per-member roles.

Authorization spot-checks: an org admin calling super-admin APIs gets **403**
(both read and write), and the `/admin` SPA route renders Access Denied.
Org-admin lists contained only that admin's own organization.

## Finding: missing test ids on org-admin screens

The super-admin pages carry `data-testid` throughout
(`orgs-create-button`, `user-create-submit`, `dept-save-button`, …). The
org-admin pages carry none — its create-user modal exposes bare `<select>` and
unlabelled inputs.

Impact is testability, not user-facing behaviour: org-admin flows cannot be
targeted by Playwright without brittle structural selectors, so they are the
surface most likely to regress unnoticed. Worth adding ids before writing E2E
coverage for that portal.

## Note for future sweeps

Two "bugs" found during this sweep were **harness** bugs, not app bugs, and both
came from selecting controls by visible text:

- Two buttons read "Create User" — the page-level opener and the modal submit.
  Clicking by text hit the opener and silently reset the form.
- A generic `input[type=text]` selector matched the page's *search* box rather
  than the modal's name field, so the record was never created and the table
  appeared empty.

Both produced "no API call, nothing created" — the same signature as a real
contract bug. Always confirm which element was actually clicked before
reporting. Select by `data-testid`, never by visible text.

---

# Calling UI browser verification

Driven with Playwright against a real LiveKit SFU, using Chromium's fake media
devices (`--use-fake-device-for-media-stream`) so calls run without hardware and
can run in CI.

## Two real defects found

**1. The callee never joined the SFU room.** `call:accepted` was published only
to `call.initiated_by`, and that handler was the frontend's only 1:1 trigger for
`livekitClient.joinCall()`. The callee's UI showed "connected" while it had
neither published nor subscribed to any track — every 1:1 call was silent and
black on one side. The group path had the same hole: `call:group_started`
reaches only the initiator, so joiners never connected either.

Fix: the server now sends `call:accepted` to both parties, so each side joins on
the server's confirmation that the call actually reached `connected`; and
`call:group_participants` (addressed to the joiner) triggers the group join.

Proof, from the SFU log: both participants in one room, each publishing VP8
simulcast 1280x720, and two `/api/calls/{id}/token` requests instead of one.

**2. Call controls rendered off-screen.** In a 1280x720 viewport the End Call
button measured `y=842..906` — 186px below the fold, visible to CSS but
unclickable. A user could not hang up. Cause: the video area is a flex child, and
`min-height: auto` stopped it shrinking, pushing the control bar out of the
`fixed inset-0` container. Fix: `min-h-0` + `overflow-hidden` on the flex-1
regions. Verified: the control moved to `y=632..696`, inside the viewport.

The test now asserts the control's bounding box lies within the viewport, so a
layout regression fails rather than merely looking odd.

## Test-design corrections made along the way

- Call history was a separate test that silently depended on the call test's side
  effect; when the call test failed, history read zero and reported a phantom
  backend bug. Merged into one self-contained test.
- Asserting "zero console errors" was too strict: a fresh context always probes
  `GET /api/auth/me` before it has a session (twice, since StrictMode
  double-invokes effects), so the 401 is expected. Errors are now captured only
  after login, and socket-teardown noise is filtered.
- Three layouts render `call-end-btn`; the selector must target the visible one.

## Still not covered

Screen share is wired and manually reachable, but not asserted here — automating
`getDisplayMedia` needs `--auto-select-desktop-capture-source`, which is
unreliable headless. Group calls (3+) are likewise unverified in a browser; the
join path is now correct by construction but has no test.
