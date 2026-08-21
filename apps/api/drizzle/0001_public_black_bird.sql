CREATE TABLE "api_rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "api_rate_limit_window_started_at_idx" ON "api_rate_limit" USING btree ("window_started_at");