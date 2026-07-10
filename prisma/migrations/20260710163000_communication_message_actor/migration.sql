ALTER TABLE "communication_messages" ADD COLUMN IF NOT EXISTS "actor_name_text" TEXT;

ALTER TABLE "communication_messages" DROP CONSTRAINT IF EXISTS "communication_messages_user_id_fkey";

ALTER TABLE "communication_messages" ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE "communication_messages"
ADD CONSTRAINT "communication_messages_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
