"""message client idempotency key

Revision ID: c5d81e37a204
Revises: a1c7f20e8b64
Create Date: 2026-08-06 00:00:00.000000

Gives every client-originated message a durable idempotency key so a retry after
an UNCERTAIN send cannot create a second row.

send_message commits before the sender learns anything, so a lost response, a
request timeout or a 502 from in front of the app all leave the client holding a
message it cannot classify. The UI called that failed, offered a retry, and the
retry minted a fresh temp id — so precisely the case where the message HAD been
stored is the case that stored it twice. `temp_id` was already on the wire for
both transports and was only echoed back; this persists it.

The index is PARTIAL, and it has to be: system messages carry no client id, and
neither does any row written before this migration. A plain unique constraint
over a nullable column would be satisfied by those rows under Postgres NULL
semantics, but a partial index states the intent — uniqueness applies only where
a client id exists — instead of relying on that.

Scoped to (conversation_id, sender_id, client_msg_id) rather than the id alone:
client ids are uuid4 in practice, but they are client-supplied, and a key that
is only unique per sender per conversation cannot be used by one account to
block a send in another.

No backfill. Existing rows keep a NULL key and fall outside the index, which is
correct — they predate the guarantee and there is nothing to reconcile them to.
"""

from alembic import op
import sqlalchemy as sa

revision = "c5d81e37a204"
down_revision = "a1c7f20e8b64"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("client_msg_id", sa.String(length=64), nullable=True))
    op.execute(
        """CREATE UNIQUE INDEX uq_messages_client_msg_id
           ON messages (conversation_id, sender_id, client_msg_id)
           WHERE client_msg_id IS NOT NULL"""
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_messages_client_msg_id")
    op.drop_column("messages", "client_msg_id")
