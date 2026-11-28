ALTER TABLE "pos_shifts" ADD COLUMN IF NOT EXISTS "cashier_user_id" uuid;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD COLUMN IF NOT EXISTS "closed_by" text;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD COLUMN IF NOT EXISTS "closed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "cashier_user_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "parked_baskets" ADD COLUMN IF NOT EXISTS "cashier_user_id" uuid;--> statement-breakpoint
ALTER TABLE "parked_baskets" ADD COLUMN IF NOT EXISTS "recalled_by_user_id" uuid;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pos_cash_drops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_id" uuid NOT NULL,
	"register_code" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_by_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_pos_cash_drops_amount_pos" CHECK (amount_cents >= 1)
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pos_shifts_cashier_user_id_users_id_fk') THEN
    ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_cashier_user_id_users_id_fk" FOREIGN KEY ("cashier_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pos_shifts_closed_by_user_id_users_id_fk') THEN
    ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_cashier_user_id_users_id_fk') THEN
    ALTER TABLE "sales" ADD CONSTRAINT "sales_cashier_user_id_users_id_fk" FOREIGN KEY ("cashier_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_actor_user_id_users_id_fk') THEN
    ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parked_baskets_cashier_user_id_users_id_fk') THEN
    ALTER TABLE "parked_baskets" ADD CONSTRAINT "parked_baskets_cashier_user_id_users_id_fk" FOREIGN KEY ("cashier_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parked_baskets_recalled_by_user_id_users_id_fk') THEN
    ALTER TABLE "parked_baskets" ADD CONSTRAINT "parked_baskets_recalled_by_user_id_users_id_fk" FOREIGN KEY ("recalled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pos_cash_drops_shift_id_pos_shifts_id_fk') THEN
    ALTER TABLE "pos_cash_drops" ADD CONSTRAINT "pos_cash_drops_shift_id_pos_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."pos_shifts"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pos_cash_drops_recorded_by_user_id_users_id_fk') THEN
    ALTER TABLE "pos_cash_drops" ADD CONSTRAINT "pos_cash_drops_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pos_shifts_cashier_user" ON "pos_shifts" USING btree ("cashier_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sales_cashier_user" ON "sales" USING btree ("cashier_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_logs_actor_user" ON "audit_logs" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pos_cash_drops_shift" ON "pos_cash_drops" USING btree ("shift_id");--> statement-breakpoint
ALTER TABLE "parked_baskets" DROP CONSTRAINT IF EXISTS "parked_baskets_hold_code_key";--> statement-breakpoint
DROP INDEX IF EXISTS "parked_baskets_hold_code_key";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_parked_baskets_active_hold_code" ON "parked_baskets" ("hold_code") WHERE "status" = 'parked';--> statement-breakpoint
WITH unique_names AS (
  SELECT lower(full_name) AS lname, (array_agg(id))[1] AS uid
  FROM users
  GROUP BY lower(full_name)
  HAVING count(*) = 1
)
UPDATE sales s SET cashier_user_id = u.uid
FROM unique_names u
WHERE s.cashier_user_id IS NULL AND lower(s.cashier_name) = u.lname;--> statement-breakpoint
WITH unique_names AS (
  SELECT lower(full_name) AS lname, (array_agg(id))[1] AS uid
  FROM users
  GROUP BY lower(full_name)
  HAVING count(*) = 1
)
UPDATE pos_shifts sh SET cashier_user_id = u.uid
FROM unique_names u
WHERE sh.cashier_user_id IS NULL AND lower(sh.cashier_name) = u.lname;--> statement-breakpoint
WITH unique_names AS (
  SELECT lower(full_name) AS lname, (array_agg(id))[1] AS uid
  FROM users
  GROUP BY lower(full_name)
  HAVING count(*) = 1
)
UPDATE audit_logs a SET actor_user_id = u.uid
FROM unique_names u
WHERE a.actor_user_id IS NULL AND lower(a.actor) = u.lname;
