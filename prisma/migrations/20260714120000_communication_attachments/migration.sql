CREATE TABLE "communication_attachments" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communication_attachments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "communication_attachments_storage_key_key" ON "communication_attachments"("storage_key");
CREATE INDEX "communication_attachments_company_id_message_id_idx" ON "communication_attachments"("company_id", "message_id");

ALTER TABLE "communication_attachments" ADD CONSTRAINT "communication_attachments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "communication_attachments" ADD CONSTRAINT "communication_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "communication_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
