-- The Claude connector: Wisdom reached from Claude instead of from its own Search and Ask pages.
--
-- Wisdom acts as its own OAuth authorization server for the connector (apps/api/src/mcp/oauth.ts), so a
-- teacher leader connects with the Google account they already use here and the server, not Claude,
-- decides what they can see. mcp_clients, mcp_grants and mcp_tokens are that server's state. Tokens and
-- codes are stored as hashes only.
--
-- mcp_calls is what replaces the visibility the Ask page gave: one row per tool call, with the tool and
-- small keys, never a draft or an answer. search_log.question carries the asker's own words, which the
-- search tool requires, and chat_turns.source tells an outcome Claude reported from one the Ask page wrote.
--
-- Everything is IF NOT EXISTS because every deploy migrates.
CREATE TABLE IF NOT EXISTS "mcp_clients" (
  "client_id" text PRIMARY KEY NOT NULL,
  "info" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_grants" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL REFERENCES "mcp_clients"("client_id") ON DELETE cascade,
  "user_id" uuid REFERENCES "users"("id") ON DELETE cascade,
  "redirect_uri" text NOT NULL,
  "code_challenge" text NOT NULL,
  "state" text,
  "scopes" text[] DEFAULT '{}'::text[] NOT NULL,
  "resource" text,
  "approve_hash" text,
  "code_hash" text UNIQUE,
  "used_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_tokens" (
  "hash" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "client_id" text NOT NULL REFERENCES "mcp_clients"("client_id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "scopes" text[] DEFAULT '{}'::text[] NOT NULL,
  "resource" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_tokens_user_idx" ON "mcp_tokens" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_tokens_expires_idx" ON "mcp_tokens" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "tool" text NOT NULL,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "ok" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_calls_created_idx" ON "mcp_calls" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_calls_tool_idx" ON "mcp_calls" ("tool", "created_at");
--> statement-breakpoint
ALTER TABLE "search_log" ADD COLUMN IF NOT EXISTS "question" text;
--> statement-breakpoint
ALTER TABLE "search_log" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'web' NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_turns" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'web' NOT NULL;
