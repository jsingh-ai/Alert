WITH duplicate_system_messages AS (
  SELECT
    id,
    client_message_id || ':duplicate:' || row_number() OVER (
      PARTITION BY channel_id, client_message_id
      ORDER BY created_at, id
    ) AS new_client_message_id,
    row_number() OVER (
      PARTITION BY channel_id, client_message_id
      ORDER BY created_at, id
    ) AS duplicate_rank
  FROM "communication_messages"
  WHERE
    user_id IS NULL
    AND client_message_id IS NOT NULL
    AND deleted_at IS NULL
),
system_messages_to_rename AS (
  SELECT id, new_client_message_id
  FROM duplicate_system_messages
  WHERE duplicate_rank > 1
)
UPDATE "communication_messages" AS message
SET client_message_id = system_messages_to_rename.new_client_message_id
FROM system_messages_to_rename
WHERE message.id = system_messages_to_rename.id;

CREATE UNIQUE INDEX IF NOT EXISTS "communication_messages_system_client_message_id_key"
ON "communication_messages"("channel_id", "client_message_id")
WHERE user_id IS NULL AND client_message_id IS NOT NULL AND deleted_at IS NULL;
