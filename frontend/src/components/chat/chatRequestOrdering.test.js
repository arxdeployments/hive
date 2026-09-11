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
 *
 * Every site a stale response can reach is asserted, not just the happy path.
 * Mutation found that pinning only the success-path write left four deletions
 * green: the close-invalidate, both spinner guards, and the error-path write.
 * A guard is only load-bearing if removing it reds something.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const read = (rel) => readFileSync(join(import.meta.dirname, rel), 'utf8');

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `isCurrent(<anything>))` followed by the statement it protects, tolerating the
// comments and reflow that sit between them.
const guarding = (statement) =>
  new RegExp(`isCurrent\\([^)]*\\)\\)(?:\\s*return;)?\\s*(?://[^\\n]*\\n\\s*)*${escape(statement)}`);

const CASES = [
  {
    name: 'CreateGroupModal contact search',
    file: 'CreateGroupModal.jsx',
    importFrom: '../../utils/latestRequest',
    guards: [
      {
        what: 'writes contacts only while its ticket is current',
        pattern: guarding('setContacts('),
        why: 'a stale search result would replace the picker the current query is filling',
      },
      {
        what: 'clears the spinner only while its ticket is current',
        pattern: guarding('setLoading(false)'),
        why: 'a stale response clearing it would show an idle picker mid-search',
      },
      {
        // The close transition is the one supersession point with no response to
        // guard: nothing takes a new ticket, so the in-flight one stays current
        // and would repopulate a modal that has just been reset.
        what: 'disowns anything in flight when the modal closes',
        pattern: /!isOpen\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*ticketRef\.current\.invalidate\(\)/,
        why: 'a response arriving after close would write contacts into a reset modal',
      },
    ],
  },
  {
    name: 'MediaLinksDocsSection tab loads',
    file: 'info/MediaLinksDocsSection.jsx',
    importFrom: '../../../utils/latestRequest',
    guards: [
      {
        what: 'writes items only while its ticket is current',
        pattern: guarding('setItems(next)'),
        why: 'the losing tab writing last leaves images under a Docs header',
      },
      {
        what: 'writes the error state only while its ticket is current',
        pattern: guarding('setItems([])'),
        why: "a stale failure would empty the current tab's list and show its error",
      },
      {
        what: 'clears the spinner only while its ticket is current',
        pattern: guarding('setLoading(false)'),
        why: 'a stale response clearing it would show an empty-looking panel mid-load',
      },
    ],
  },
];

describe('chat loads that reload on user input are ordered', () => {
  for (const { name, file, importFrom, guards } of CASES) {
    describe(name, () => {
      const source = read(file);

      it('imports the shared request ticket', () => {
        assert.match(
          source,
          new RegExp(
            `import\\s*\\{[^}]*\\bcreateRequestTicket\\b[^}]*\\}\\s*from\\s*'${escape(importFrom)}'`,
          ),
          `${file} does not use the shared request ticket, so a slow earlier load can overwrite a newer one.`,
        );
      });

      it('takes a ticket for each load', () => {
        assert.match(source, /\.take\(\)/, `${file} takes no ticket, so nothing can be ordered.`);
      });

      for (const { what, pattern, why } of guards) {
        it(what, () => {
          assert.match(source, pattern, `${file} is missing that guard: ${why}.`);
        });
      }
    });
  }
});
