CREATE TABLE IF NOT EXISTS "number_sequences" (
  "scope" text PRIMARY KEY NOT NULL,
  "current_value" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
