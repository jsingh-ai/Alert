-- Keep pager machine scope in sync with the Prisma model.
ALTER TABLE "pager_devices" ADD COLUMN "machine_id" TEXT;

DROP INDEX "pager_devices_company_id_department_id_active_idx";

CREATE INDEX "pager_devices_company_id_department_id_machine_id_active_idx"
ON "pager_devices"("company_id", "department_id", "machine_id", "active");

ALTER TABLE "pager_devices"
ADD CONSTRAINT "pager_devices_machine_id_fkey"
FOREIGN KEY ("machine_id") REFERENCES "machines"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
