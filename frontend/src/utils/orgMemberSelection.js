/**
 * The cross-org group builder's organization/member selection, as one pure
 * transition.
 *
 * WHY THIS IS NOT INSIDE THE COMPONENT
 *
 * toggleOrg mixed a functional state update with a closure read, and the closure
 * read was stale:
 *
 *     setSelectedOrgIds(prev => ...toggle orgId...);        // functional: correct
 *     setSelectedMembers(prev => prev.filter(m => {
 *       ...
 *       return !memberOrgId || selectedOrgIds.includes(memberOrgId) || ...;
 *                              ^^^^^^^^^^^^^^ render-time value, pre-toggle
 *     }));
 *
 * On a DESELECT, `selectedOrgIds` still contained the organization being removed,
 * so `includes(memberOrgId)` was true for exactly the members that were supposed
 * to be dropped and the filter kept every one of them. The comment above it read
 * "Clear members from deselected orgs"; it cleared nothing, ever.
 *
 * That is not a cosmetic staleness. handleCreate posts `org_ids: selectedOrgIds`
 * alongside those orphaned members, and api/cross_org.py refuses the request with
 * "User <name> does not belong to a selected organization" — naming somebody the
 * admin can no longer see anywhere, because that organization's section is gone
 * from the form. The only way out is to start the flow again.
 *
 * It also looked the member's organization up by scanning the cached roster for
 * their id, which selectedMembers already carries as `org_id`. That scan is what
 * made the whole thing depend on holding every organization's complete roster in
 * memory — and this change makes the roster a NARROWED, capped fetch, so the scan
 * would now miss members who are simply not in the current search result.
 *
 * One snapshot in, one snapshot out. No closure, nothing to go stale.
 */

/**
 * Add or remove an organization, and drop what depended on it.
 *
 * @param {{selectedOrgIds: string[], selectedMembers: {user_id: string, org_id: string}[], adminIds: string[]}} state
 * @param {string} orgId
 * @returns the same shape, never mutated in place
 */
export function toggleOrgSelection(state, orgId) {
  const selectedOrgIds = state.selectedOrgIds || [];
  const selectedMembers = state.selectedMembers || [];
  const adminIds = state.adminIds || [];

  if (!selectedOrgIds.includes(orgId)) {
    // Selecting: nothing is invalidated, so members and admins are untouched.
    return {
      selectedOrgIds: [...selectedOrgIds, orgId],
      selectedMembers,
      adminIds,
    };
  }

  const keptMembers = selectedMembers.filter((m) => m.org_id !== orgId);
  const keptIds = new Set(keptMembers.map((m) => m.user_id));
  return {
    selectedOrgIds: selectedOrgIds.filter((id) => id !== orgId),
    selectedMembers: keptMembers,
    // Admin flags follow membership. Left behind they are ids that are no longer
    // members, and stale companion state is what this function exists to stop.
    adminIds: adminIds.filter((id) => keptIds.has(id)),
  };
}
