-- Per department: closing a call needs a short description of the issue (admin setting).
ALTER TABLE "departments" ADD COLUMN "require_resolve_note" BOOLEAN NOT NULL DEFAULT false;
