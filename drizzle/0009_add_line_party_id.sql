-- Add party_id to journal_lines for per-line party assignment (Digits parity)
ALTER TABLE "journal_lines" ADD COLUMN "party_id" uuid REFERENCES "parties"("id");
