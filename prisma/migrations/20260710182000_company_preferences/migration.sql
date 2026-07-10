CREATE TABLE IF NOT EXISTS "company_preferences" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value_json" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "company_preferences_company_id_key_key" ON "company_preferences"("company_id", "key");

ALTER TABLE "company_preferences"
DROP CONSTRAINT IF EXISTS "company_preferences_company_id_fkey";

ALTER TABLE "company_preferences"
ADD CONSTRAINT "company_preferences_company_id_fkey"
FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
