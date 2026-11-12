-- Stewards, and readers' flags.
--
-- Much of the library was written by people who have since left Wildflower. Nobody then owns keeping
-- it right. A steward is the person who looks after a resource now; the author stays as written and
-- both are shown. It is a user rather than a name so "the resources I look after" is a real question.
--
-- item_flags records a reader saying a resource looks out of date or unclear. A flag stays open until
-- a staff member reviews the resource, which stamps item_meta.reviewed_at (already there, from the
-- retirement queue) and closes the flags on it.
ALTER TABLE "item_meta" ADD COLUMN IF NOT EXISTS "steward_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "item_flags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "item_id" uuid NOT NULL REFERENCES "items"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "resolved_by" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "item_flags_item_idx" ON "item_flags" ("item_id");
