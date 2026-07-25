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
