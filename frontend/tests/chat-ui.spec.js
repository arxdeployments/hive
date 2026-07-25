/**
 * The WhatsApp-parity chat surface, driven end to end.
 *
 * ChatPanel is the seam where five independently built components meet
 * (ChatHeaderMenu, CallButtonDropdown, MessageContextMenu, GroupInfoPanel,
 * ContactInfoPanel) and where the "frontend calls a route the API doesn't
 * expose" class of bug has landed repeatedly. Every assertion here is a wire
 * that used to be, or could silently become, disconnected: a menu row that
 * emits an action nobody handles reads exactly like a working button.
 *
 * Both tests fail on any console error, because a dead handler usually
 * announces itself as one first.
 */
import { expect, test } from '@playwright/test';
import { seedOrgWithUsers, uiLogin } from './helpers.js';

const API = process.env.E2E_API_URL || 'http://127.0.0.1:8000';
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
const suffix = `chatui${process.pid}${Math.floor(Math.random() * 1000)}`;
let seeded;

test.beforeAll(async ({ request }) => {
  seeded = await seedOrgWithUsers(request, suffix);
  // A group needs >= 2 members besides the creator.
  await request.post(`${API}/api/admin/users`, {
    headers: H,
    data: {
      org_id: seeded.org._id,
      dept_id: seeded.dept._id,
      email: `carol.${suffix}@rxhive-e2e.com`,
      display_name: 'Carol E2E',
      password: 'E2ePassword123',
      role: 'member',
    },
  });
});

/** Console errors are per-test; socket teardown noise is not a defect. */
function watchConsole(page, sink) {
  page.on('console', (m) => {
    if (m.type() === 'error') sink.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => sink.push(`pageerror: ${e.message}`));
}

const realErrors = (errors) =>
  errors.filter((e) => !/favicon|manifest|\[WS\] Error|Failed to load resource/i.test(e));

test('direct chat: header menu, message menu and multi-select are all wired', async ({ page }) => {
  const errors = [];
  watchConsole(page, errors);

  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();

  // --- open a DM with Bob ------------------------------------------------
  await page.getByTestId('new-chat-button').click();
  await page.getByTestId('contact-item').filter({ hasText: 'Bob E2E' }).first().click();
  await expect(page.getByTestId('message-input')).toBeVisible();

  // DIRECT header: voice + video buttons keep their ids, plus the 3-dots menu.
  await expect(page.getByTestId('header-voice-call-btn')).toBeVisible();
  await expect(page.getByTestId('header-video-call-btn')).toBeVisible();
  await expect(page.getByTestId('chat-header-menu-trigger')).toBeVisible();

  // Send two messages so there is something to act on.
  for (const body of ['first wired message', 'second wired message']) {
    await page.getByTestId('message-input').fill(body);
    await page.getByTestId('message-send-btn').click();
    await expect(page.getByTestId('virtuoso-item-list').getByText(body)).toBeVisible();
  }

  // --- direct 3-dots menu shape -----------------------------------------
  await page.getByTestId('chat-header-menu-trigger').click();
  await expect(page.getByTestId('chat-header-menu')).toBeVisible();
  for (const a of ['info', 'search', 'select', 'mute', 'new-group-call', 'send-call-link', 'schedule-call', 'new-window', 'close']) {
    await expect(page.getByTestId(`chat-header-menu-${a}`)).toBeVisible();
  }

  // search -> the existing ConversationSearch bar
  await page.getByTestId('chat-header-menu-search').click();
  await expect(page.getByTestId('conversation-search-bar')).toBeVisible();
  await page.getByTestId('conv-search-input').press('Escape');

  // info -> ContactInfoPanel on the Info section
  await page.getByTestId('chat-header-menu-trigger').click();
  await page.getByTestId('chat-header-menu-info').click();
  await expect(page.getByTestId('contact-info-panel')).toBeVisible();
  await expect(page.getByTestId('contact-info-email')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('contact-info-panel')).toHaveCount(0);

  // header avatar click still opens the panel
  await page.getByTestId('chat-header-identity').click();
  await expect(page.getByTestId('contact-info-panel')).toBeVisible();
  await page.keyboard.press('Escape');

  // mute -> API + optimistic toggle (label flips)
  await page.getByTestId('chat-header-menu-trigger').click();
  await page.getByTestId('chat-header-menu-mute').click();
  await expect(page.getByText('Notifications muted')).toBeVisible();
  await page.getByTestId('chat-header-menu-trigger').click();
  await expect(page.getByTestId('chat-header-menu-mute')).toHaveText(/Unmute/);
  await page.keyboard.press('Escape');

  // --- message menu ------------------------------------------------------
  const bubble = page.getByTestId('virtuoso-item-list').getByText('second wired message');
  await bubble.hover();
  await page.getByTestId('message-menu-trigger').last().click();
  await expect(page.getByTestId('message-menu')).toBeVisible();
  for (const a of ['reply', 'react', 'star', 'pin', 'forward', 'copy', 'delete-me', 'select']) {
    await expect(page.getByTestId(`message-menu-${a}`)).toBeVisible();
  }

  // reply -> composer reply preview
  await page.getByTestId('message-menu-reply').click();
  await expect(page.getByTestId('reply-preview')).toBeVisible();
  await page.getByTestId('reply-preview').getByRole('button').click();

  // star -> optimistic indicator
  await bubble.hover();
  await page.getByTestId('message-menu-trigger').last().click();
  await page.getByTestId('message-menu-star').click();
  await expect(page.getByTestId('message-starred-indicator').last()).toBeVisible();

  // pin -> pinned banner appears and jumps
  await bubble.hover();
  await page.getByTestId('message-menu-trigger').last().click();
  await page.getByTestId('message-menu-pin').click();
  await expect(page.getByTestId('pinned-messages-banner')).toBeVisible();
  await expect(page.getByTestId('pinned-messages-banner')).toContainText('second wired message');
  await page.getByTestId('pinned-messages-banner').click();

  // react -> the reaction picker opens anchored, and the badge lands
  await bubble.hover();
  await page.getByTestId('message-menu-trigger').last().click();
  await page.getByTestId('message-menu-react').click();
  await expect(page.getByTestId('reaction-picker')).toBeVisible();
  await page.getByTestId('reaction-picker').getByRole('button').first().click();
  await expect(page.getByTestId('reaction-badge').first()).toBeVisible();

  // forward -> the existing modal
  await bubble.hover();
  await page.getByTestId('message-menu-trigger').last().click();
  await page.getByTestId('message-menu-forward').click();
  await expect(page.getByText('Forward Message')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // --- multi-select ------------------------------------------------------
  await page.getByTestId('chat-header-menu-trigger').click();
  await page.getByTestId('chat-header-menu-select').click();
  await expect(page.getByTestId('selection-action-bar')).toBeVisible();
  await expect(page.getByTestId('selection-count')).toHaveText('0 selected');
  const rows = page.getByTestId('message-select-row');
  await rows.first().click();
  await rows.last().click();
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected');
  await expect(page.getByTestId('selection-forward-btn')).toBeEnabled();
  // Escape exits
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('selection-action-bar')).toHaveCount(0);
  await expect(page.getByTestId('message-input')).toBeVisible();

  // select from a message menu seeds that message
  await bubble.hover();
  await page.getByTestId('message-menu-trigger').last().click();
  await page.getByTestId('message-menu-select').click();
  await expect(page.getByTestId('selection-count')).toHaveText('1 selected');
  await page.getByTestId('selection-cancel-btn').click();

  const real = realErrors(errors);
  expect(real, `console errors:\n${real.join('\n')}`).toEqual([]);
});

test('group chat: call dropdown, group menu, info sections and reply privately', async ({ page }) => {
  const errors = [];
  watchConsole(page, errors);

  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();

  // Create a group with Bob.
  await page.getByTestId('new-group-button').click();
  await page.getByTestId('group-contact-item').filter({ hasText: 'Bob E2E' }).first().click();
  await page.getByTestId('group-contact-item').filter({ hasText: 'Carol E2E' }).first().click();
  await page.getByTestId('group-next-button').click();
  await page.getByTestId('group-name-input').fill('Wiring Group');
  await page.getByTestId('group-create-button').click();
  await expect(page.getByTestId('message-input')).toBeVisible();

  // GROUP header: one video button with a chevron, no standalone voice button.
  await expect(page.getByTestId('header-video-call-btn')).toBeVisible();
  await expect(page.getByTestId('header-voice-call-btn')).toHaveCount(0);
  await expect(page.getByTestId('call-dropdown-trigger')).toBeVisible();

  // Call dropdown panel
  await page.getByTestId('call-dropdown-trigger').click();
  await expect(page.getByTestId('call-dropdown')).toBeVisible();
  for (const a of ['select-people', 'voice', 'video', 'send-call-link', 'schedule-call']) {
    await expect(page.getByTestId(`call-dropdown-${a}`)).toBeVisible();
  }
  // "Select people" -> group info opened straight on Members
  await page.getByTestId('call-dropdown-select-people').click();
  await expect(page.getByTestId('group-info-panel')).toBeVisible();
  await expect(page.getByTestId('group-member-row').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('group-info-panel')).toHaveCount(0);

  // GROUP 3-dots menu shape
  await page.getByTestId('chat-header-menu-trigger').click();
  for (const a of ['info', 'search', 'select', 'mute', 'exit', 'new-window', 'close']) {
    await expect(page.getByTestId(`chat-header-menu-${a}`)).toBeVisible();
  }
  await expect(page.getByTestId('chat-header-menu-new-group-call')).toHaveCount(0);

  // "Group info" opens the Info section, not Members (initialSection is re-armed)
  await page.getByTestId('chat-header-menu-info').click();
  await expect(page.getByTestId('group-info-panel')).toBeVisible();
  await expect(page.getByTestId('group-info-created')).toBeVisible();
  await page.keyboard.press('Escape');

  // Exit group -> ChatPanel's confirm dialog, cancellable
  await page.getByTestId('chat-header-menu-trigger').click();
  await page.getByTestId('chat-header-menu-exit').click();
  await expect(page.getByTestId('chat-leave-group-confirm')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('chat-leave-group-confirm')).toHaveCount(0);

  // Group message menu carries the group-only social block for others' messages
  await page.getByTestId('message-input').fill('group hello');
  await page.getByTestId('message-send-btn').click();
  await expect(page.getByTestId('virtuoso-item-list').getByText('group hello')).toBeVisible();
  await page.getByTestId('virtuoso-item-list').getByText('group hello').hover();
  await page.getByTestId('message-menu-trigger').last().click();
  // own message -> edit + info, no report
  await expect(page.getByTestId('message-menu-edit')).toBeVisible();
  await expect(page.getByTestId('message-menu-info')).toBeVisible();
  await expect(page.getByTestId('message-menu-report')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // --- reply privately (needs a message from somebody else) ---------------
  const bobCtx = await page.context().browser().newContext();
  const bp = await bobCtx.newPage();
  await uiLogin(bp, seeded.users.bob.email, seeded.users.bob.password);
  await expect(bp.getByTestId('conversation-search')).toBeVisible();
  await bp.getByTestId('conversation-item').filter({ hasText: 'Wiring Group' }).first().click();
  await bp.getByTestId('message-input').fill('bob says hi');
  await bp.getByTestId('message-send-btn').click();

  const bobMsg = page.getByTestId('virtuoso-item-list').getByText('bob says hi');
  await expect(bobMsg).toBeVisible({ timeout: 15000 });
  await bobMsg.hover();
  await page.getByTestId('message-menu-trigger').last().click();
  await expect(page.getByTestId('message-menu-reply-privately')).toBeVisible();
  await expect(page.getByTestId('message-menu-report')).toBeVisible();
  await expect(page.getByTestId('message-menu-message-user')).toBeVisible();
  await page.getByTestId('message-menu-reply-privately').click();

  // Lands in the DM with Bob, composer seeded with the quote.
  await expect(page.getByTestId('chat-header-identity')).toContainText('Bob E2E');
  await expect(page.getByTestId('message-input')).toHaveValue(/> Bob E2E: bob says hi/);
  await expect(page.getByTestId('header-voice-call-btn')).toBeVisible();
  await bobCtx.close();

  // back to the group
  await page.getByTestId('conversation-item').filter({ hasText: 'Wiring Group' }).first().click();
  await expect(page.getByTestId('call-dropdown-trigger')).toBeVisible();

  // close chat -> back to the empty state
  await page.getByTestId('chat-header-menu-trigger').click();
  await page.getByTestId('chat-header-menu-close').click();
  await expect(page.getByTestId('message-input')).toHaveCount(0);

  const real = realErrors(errors);
  expect(real, `console errors:\n${real.join('\n')}`).toEqual([]);
});
