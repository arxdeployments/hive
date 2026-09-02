import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toggleOrgSelection } from './orgMemberSelection.js';

/**
 * Run by Node's own test runner (`npm run test:unit`). No DOM.
 *
 * The subject is a deselect. The previous implementation read `selectedOrgIds`
 * from the render closure while updating it functionally, so on a deselect the
 * organization was still present in the value the filter consulted — and the
 * filter therefore kept exactly the members it was written to remove.
 */

const STATE = {
  selectedOrgIds: ['org-a', 'org-b'],
  selectedMembers: [
    { user_id: 'a1', org_id: 'org-a' },
    { user_id: 'a2', org_id: 'org-a' },
    { user_id: 'b1', org_id: 'org-b' },
  ],
  adminIds: ['a1', 'b1'],
};

describe('toggleOrgSelection', () => {
  it('drops the deselected organization members, which is what never happened', () => {
    const next = toggleOrgSelection(STATE, 'org-b');

    assert.deepEqual(next.selectedOrgIds, ['org-a']);
    assert.deepEqual(
      next.selectedMembers.map((m) => m.user_id),
      ['a1', 'a2'],
    );
  });

  it('drops the admin flags of members it removed', () => {
    // Otherwise adminIds keeps ids that are no longer members — the same kind of
    // stale companion state as the bug itself.
    const next = toggleOrgSelection(STATE, 'org-b');
    assert.deepEqual(next.adminIds, ['a1']);
  });

  it('is what stops the create from being refused for an invisible user', () => {
    // handleCreate posts org_ids alongside the members. api/cross_org.py rejects
    // any member whose org is not in that list with "User <name> does not belong
    // to a selected organization" — and the admin can no longer see that
    // organization's section to fix it.
    const next = toggleOrgSelection(STATE, 'org-b');
    const orphans = next.selectedMembers.filter((m) => !next.selectedOrgIds.includes(m.org_id));
    assert.deepEqual(orphans, [], 'a member survived without its organization');
  });

  it('keeps everything when an organization is added', () => {
    const next = toggleOrgSelection(STATE, 'org-c');

    assert.deepEqual(next.selectedOrgIds, ['org-a', 'org-b', 'org-c']);
    assert.equal(next.selectedMembers.length, 3);
    assert.deepEqual(next.adminIds, ['a1', 'b1']);
  });

  it('does not need the roster to know a member org', () => {
    // The old code scanned the cached roster for the member's id to find their
    // organization. The roster is now a narrowed, capped fetch, so that scan
    // would miss anyone outside the current search result. Members carry org_id.
    const narrowed = {
      selectedOrgIds: ['org-a', 'org-b'],
      selectedMembers: [{ user_id: 'not-in-any-loaded-roster', org_id: 'org-b' }],
      adminIds: [],
    };
    const next = toggleOrgSelection(narrowed, 'org-b');
    assert.deepEqual(next.selectedMembers, []);
  });

  it('never mutates what it was given', () => {
    const before = JSON.stringify(STATE);
    toggleOrgSelection(STATE, 'org-b');
    assert.equal(JSON.stringify(STATE), before);
  });

  it('tolerates an empty state', () => {
    assert.deepEqual(toggleOrgSelection({}, 'org-a'), {
      selectedOrgIds: ['org-a'],
      selectedMembers: [],
      adminIds: [],
    });
  });
});
