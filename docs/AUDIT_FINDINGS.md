# Pre-deploy audit — findings and disposition

An adversarial production-readiness audit ran over the code added in commits
`528773a` and `8b0ac6d` (stars/pins, conversation permissions, the WhatsApp-parity
chat UI, call fixes) — none of which had been security-reviewed — plus the AWS
deployment artifacts. 25 findings were reported; 22 survived adversarial
verification against the code.

Every one of these passed lint, typecheck, build, 76 backend tests and 12 E2E
tests. That is the recurring lesson of this project: green checks constrain, but
do not establish, correctness.

## Fixed before packaging

| Sev | Finding | Why it mattered |
|---|---|---|
| HIGH | `ForwardModal` dereferenced a `message` prop that the new Media/Links/Docs multi-select flow never passes | 100% reproducible crash of the whole chat pane via ChatErrorBoundary; user loses the conversation and must hard-reload |
| HIGH | Web Push awaited inline in the send path, `webpush()` with no timeout | One blackholed push endpoint hangs a message-send forever, holding a DB session and a worker thread; a 30-member offline group serialises 30 remote POSTs into send latency |
| HIGH | `GET /{conv_id}/export` materialised an entire history in memory, formatted synchronously in an async handler *(endpoint has since been removed entirely, along with the Export chat feature — kept here as a record of what the code did, not of code that still exists)* | Hundreds of MB per concurrent export on the 2-worker t3.large target, plus event-loop blocking that stalls every other request and WebSocket frame on that worker |
| MED | `/{conv_id}/permissions` gated only on membership | A normal user made admin of a **cross-org** group could silence participants in other organisations, unaudited — a tenant-boundary crossing |
| MED | `perm_send_history` stored, returned and rendered, enforced nowhere | A privacy switch that reports success while new members still read the full pre-join history through six read paths. Removed rather than half-enforced |
| MED | `/pinned` and `/starred` unbounded; no pin cap | Pinned is on the conversation-open hot path, so an uncapped pin list degrades the most frequent action in the app without limit |
| MED | `GET /api/metrics` unauthenticated | Exposed per-route request counts and latencies to anyone |

## Also fixed (second pass — everything remaining)

| Sev | Finding | Fix |
|---|---|---|
| HIGH | `message_pin_update` / `permissions_updated` broadcast but unhandled by the WS client | Pins and permission changes never propagated live; handlers added |
| HIGH | Runbook's super-admin password retrieval named the wrong SSM leaf and a nonexistent output | Operator could not log in; corrected against `secrets.tf` |
| HIGH | Runbook §3.1 referenced a missing tfvars example and two variables that do not exist | Matched to the real `terraform.tfvars.example` |
| MED | Own media messages stuck at `sending` forever — POST response discarded | Reconciled via `replaceOptimisticMessage`; failures now retryable |
| MED | Redis outage 500'd already-committed sends | `degrade_on_outage` guard; presence falls back to offline. Rate limiting deliberately still fails **closed** |
| MED | `iam.tf` read `alias/aws/ssm` at plan time | First `apply` failed in a greenfield account; replaced with a `kms:ViaService` condition |
| MED | groups-in-common: 3 unbatched round-trips per group, unbounded | Batched + capped at 50 |
| MED | Metrics label set grew without bound on 404s | Unmatched paths bucket to `<unmatched>` |
| MED | Rotation procedure invoked a script that does not exist | Replaced with verified commands |
| LOW | EIP associated after boot could strand the bootstrap | Pre-created ENI so the box boots with its final address |
| LOW | VAPID silently unprovisioned | Left manual (a wrong-format key is worse than none) but now surfaced via a Terraform output + runbook section |
| LOW | `ContactInfoPanel` org/bio rows had no data source | Removed rather than left permanently blank |
| LOW | Reaction tooltips read `user_name`, absent from `serialize_message` | Batch-loaded into the message shape |
| LOW | Links tab ran an unindexable scan on every open | Partial index; measured 2470 → 91 buffers |
| INFO | Six routes omitted the org check | Moved into `require_membership` so it cannot drift |

Test isolation was also fixed: per-session Postgres schema + Redis logical DB, so the
suite is safe to run concurrently. Proven — two simultaneous runs, both 77/77,
no leftover schemas. It is now a real CI gate rather than a serial-only one.

## Still open

Everything reported by the audit is now fixed. These are defects noticed *in
passing* while fixing it — outside the audit's scope, none of them blocking, all
recorded so they are not rediscovered as surprises:

- **Media is POSTed twice when the socket is down.** `ChatPanel.handleSend`'s
  `if (!wsConnected)` fallback posts, and `MessageComposer.sendMediaFile` posts
  as well, so one file becomes two server messages. Pre-existing; only reachable
  while the WebSocket is disconnected.
- **The cross-org conversation header always renders `?`.** `ChatPanel.jsx`
  builds "N members from X organizations" from `p.org_name`, which
  `enrich.serialize_user_brief` does not send — the same class of defect as the
  ContactInfoPanel rows that were removed.
- **Group permissions do not live-update while the panel is open.**
  `permissions_updated` now reaches the store, but `GroupInfoPanel` keeps the
  toggles it fetched when the section was opened until it is reopened. Only
  `send_messages` (which gates the composer) propagates immediately.
- **One unexplained test count.** A single concurrent run reported `78 passed`
  against 77 collected; never reproduced across six later runs, and executed
  node-ids matched collection exactly. Probably a reporting artefact of the
  concurrent-run harness, but it is unexplained rather than understood.

## Accepted trade-offs

Deliberate decisions, not omissions:

- **Rate limiting fails closed on a Redis outage.** Realtime fan-out and
  presence degrade, but `core/rate_limit.py` still raises — degrading it would
  fail *open* and allow unlimited login attempts during an outage.
- **VAPID keys are provisioned by hand.** Terraform cannot generate an EC P-256
  keypair, and a wrong-format key is worse than none: an empty key is a clean
  feature-off no-op, while an invalid one passes the check and then fails at
  send time. A Terraform output prints the exact commands instead.
- **`perm_send_history` / `invite_via_link` / `approve_new_members` columns
  remain in the schema** but are no longer exposed. Dropping them needs a
  migration; they are commented RESERVED / NOT ENFORCED at the model.

## Method

Four parallel audit dimensions (tenant isolation, production runtime, AWS
deployment correctness, frontend/backend contract drift), each finding then
handed to an independent verifier instructed to default to FALSE_POSITIVE unless
the code plainly confirmed it. Three findings were rejected that way, and
several had their severity corrected down — the verification pass is what makes
the remainder trustworthy.
