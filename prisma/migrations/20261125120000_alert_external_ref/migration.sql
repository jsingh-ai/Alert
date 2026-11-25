-- Work order folio in the maintenance app, set when a mechanical/electrical call is accepted.
ALTER TABLE "andon_alerts" ADD COLUMN "external_ref" TEXT;
