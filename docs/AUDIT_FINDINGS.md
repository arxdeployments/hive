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
| HIGH | `GET /{conv_id}/export` materialised an entire history in memory, formatted synchronously in an async handler | Hundreds of MB per concurrent export on the 2-worker t3.large target, plus event-loop blocking that stalls every other request and WebSocket frame on that worker |
| MED | `/{conv_id}/permissions` gated only on membership | A normal user made admin of a **cross-org** group could silence participants in other organisations, unaudited — a tenant-boundary crossing |
| MED | `perm_send_history` stored, returned and rendered, enforced nowhere | A privacy switch that reports success while new members still read the full pre-join history through six read paths. Removed rather than half-enforced |
| MED | `/pinned` and `/starred` unbounded; no pin cap | Pinned is on the conversation-open hot path, so an uncapped pin list degrades the most frequent action in the app without limit |
| MED | `GET /api/metrics` unauthenticated | Exposed per-route request counts and latencies to anyone |

## Accepted, not fixed

Lower-severity items were left deliberately rather than churn code immediately
before a deploy. They are recorded here so they are not rediscovered as
surprises:

- Reaction shape differs between `serialize_message` (`{user_id, emoji, created_at}`)
  and `enriched_reactions` (`{user_id, user_name, emoji}`). Cosmetic today; a
  trap for the next person who assumes one shape.
- `contacts.py` groups-in-common serialises conversations sequentially without
  the batch helpers, so it is O(n) awaited queries. Fine at current scale.
- Media/links scan uses `ILIKE '%http%'`, which cannot use an index; bounded by
  `_LINK_SCAN_LIMIT = 500`.
- `terraform.tfvars.example` is absent, so the operator must read `variables.tf`
  to know what to set.
- `alert_email` is declared but wired to nothing — no CloudWatch alarms exist.

## Method

Four parallel audit dimensions (tenant isolation, production runtime, AWS
deployment correctness, frontend/backend contract drift), each finding then
handed to an independent verifier instructed to default to FALSE_POSITIVE unless
the code plainly confirmed it. Three findings were rejected that way, and
several had their severity corrected down — the verification pass is what makes
the remainder trustworthy.
