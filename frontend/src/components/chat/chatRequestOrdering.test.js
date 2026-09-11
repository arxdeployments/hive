/**
 * Request ordering for the two chat loads that reload on user input.
 *
 * Wiring guards, in the style of the CrossOrgGroups check in
 * utils/orgMemberSelection.test.js — the ordering mechanism itself is covered by
 * utils/latestRequest.test.js, and there is no component test harness in this
 * repo (no jsdom, no testing-library), so what can be pinned here is that these
 * loads actually go through it.
 *
 * Both are the case that check already records, in a component its sweep did not
 * reach:
 *
 *   The debounce timer only cancels a load that has not STARTED. Once a request
 *   is open, clearing the timer does nothing and the response still writes.
 *
 * CreateGroupModal debounces its contact search by 300ms and nothing orders the
 * responses, so a two-character prefix — which matches more rows and answers
 * slower — can land after the five-character query typed after it and leave the
 * member picker showing people the search box no longer asks for. You then choose
 * someone to add to a group from a list that does not match what you typed.
 *
 * MediaLinksDocsSection has no debounce and no ordering: its load is keyed on
 * [conversationId, tab], so switching Media -> Docs quickly races two loads. The
 * Media tab issues TWO requests (images and videos, interleaved), which widens
 * the window, and the loser writing last leaves images under a Docs header.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const read = (rel) => readFileSync(join(import.meta.dirname, rel), 'utf8');

const CASES = [
  {
    name: 'CreateGroupModal contact search',
    file: 'CreateGroupModal.jsx',
    importFrom: "'../../utils/latestRequest'",
    // The guard must sit immediately before the write it protects. Asserting
    // only that `isCurrent` appears SOMEWHERE was satisfied by the copy in the
    // catch block: removing the one on the success path left the test green,
    // which mutation caught and this pins.
    guardedWrite: /isCurrent\([^)]*\)\)\s*return;\s*setContacts\(/,
    writeName: 'setContacts',
  },
  {
    name: 'MediaLinksDocsSection tab loads',
    file: 'info/MediaLinksDocsSection.jsx',
    importFrom: "'../../../utils/latestRequest'",
    guardedWrite: /isCurrent\([^)]*\)\)\s*return;\s*setItems\(next\)/,
    writeName: 'setItems(next)',
  },
];

describe('chat loads that reload on user input are ordered', () => {
  for (const { name, file, importFrom, guardedWrite, writeName } of CASES) {
    describe(name, () => {
      const source = read(file);

      it('imports the shared request ticket', () => {
        assert.match(
          source,
          new RegExp(
            `import\\s*\\{[^}]*\\bcreateRequestTicket\\b[^}]*\\}\\s*from\\s*${importFrom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
          ),
          `${file} does not use the shared request ticket, so a slow earlier load can overwrite a newer one.`,
        );
      });

      it('takes a ticket for each load', () => {
        assert.match(source, /\.take\(\)/, `${file} takes no ticket, so nothing can be ordered.`);
      });

      it('refuses to write when its ticket is no longer current', () => {
        assert.match(
          source,
          guardedWrite,
          `${file} writes ${writeName} without an isCurrent guard immediately before ` +
            'it, so a stale response still overwrites the current one.',
        );
      });
    });
  }
});
