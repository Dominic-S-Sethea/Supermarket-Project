CREATE TABLE IF NOT EXISTS "supervisor_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"action_type" text NOT NULL,
	"reason" text NOT NULL,
	"register_code" text DEFAULT 'REG-01' NOT NULL,
	"cashier_user_id" uuid NOT NULL,
	"supervisor_user_id" uuid NOT NULL,
	"supervisor_name" text NOT NULL,
	"supervisor_role" text NOT NULL,
	"consumed_by_sale_id" uuid,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'supervisor_overrides_cashier_user_id_users_id_fk') THEN
    ALTER TABLE "supervisor_overrides" ADD CONSTRAINT "supervisor_overrides_cashier_user_id_users_id_fk" FOREIGN KEY ("cashier_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'supervisor_overrides_supervisor_user_id_users_id_fk') THEN
    ALTER TABLE "supervisor_overrides" ADD CONSTRAINT "supervisor_overrides_supervisor_user_id_users_id_fk" FOREIGN KEY ("supervisor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'supervisor_overrides_consumed_by_sale_id_sales_id_fk') THEN
    ALTER TABLE "supervisor_overrides" ADD CONSTRAINT "supervisor_overrides_consumed_by_sale_id_sales_id_fk" FOREIGN KEY ("consumed_by_sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_supervisor_overrides_expires" ON "supervisor_overrides" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_supervisor_overrides_consumed_sale" ON "supervisor_overrides" USING btree ("consumed_by_sale_id");--> statement-breakpoint
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "store_timezone" text DEFAULT 'Asia/Phnom_Penh' NOT NULL;--> statement-breakpoint
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "rail_fx_rates_json" jsonb;--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT IF EXISTS "stock_movements_batch_id_inventory_batches_id_fk";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batch_id_inventory_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."inventory_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" DROP CONSTRAINT IF EXISTS "ai_conversations_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_proposed_actions" DROP CONSTRAINT IF EXISTS "ai_proposed_actions_conversation_id_ai_conversations_id_fk";--> statement-breakpoint
ALTER TABLE "ai_proposed_actions" ADD CONSTRAINT "ai_proposed_actions_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sale_payments_payment_intent_id_payment_intents_id_fk') THEN
    ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_proposed_actions_message_id_ai_messages_id_fk') THEN
    ALTER TABLE "ai_proposed_actions" ADD CONSTRAINT "ai_proposed_actions_message_id_ai_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ai_messages"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_product_primary_barcode" ON "product_barcodes" ("product_id") WHERE "is_primary" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_stock_movements_unfolded" ON "stock_movements" ("product_id") WHERE "folded" = false;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_pos_shifts_open_register" ON "pos_shifts" ("register_code") WHERE "closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sales_kind_sold_at" ON "sales" ("kind", "sold_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sales_original_sale" ON "sales" ("original_sale_id") WHERE "original_sale_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sales_single_void_per_original" ON "sales" ("original_sale_id") WHERE "kind" = 'void' AND "original_sale_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_targeted_coupons_upper_code" ON "targeted_coupons" (upper("code"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sale_payments_intent_not_null" ON "sale_payments" ("payment_intent_id") WHERE "payment_intent_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_pos_shifts_z_report_no" ON "pos_shifts" ("z_report_no") WHERE "z_report_no" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_po_lines_po_product" ON "purchase_order_lines" ("po_id", "product_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_lp_anomalies_cashier" ON "analytics_lp_anomalies" ("cashier_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_logs_action" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_logs_entity_type" ON "audit_logs" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_intents_status_expires" ON "payment_intents" USING btree ("status", "expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sale_payments_sale_method" ON "sale_payments" USING btree ("sale_id", "method");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inventory_batches_fefo_active" ON "inventory_batches" ("product_id", "best_before_date", "id") WHERE "qty_remaining" > 0 AND "status" IN ('active', 'clearance');--> statement-breakpoint
DROP INDEX IF EXISTS "uq_stock_baselines_product";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_store_footfall_bucket";--> statement-breakpoint
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING gin (name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_products_sku_trgm ON products USING gin (sku gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_products_brand_trgm ON products USING gin (brand gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_product_barcodes_barcode_trgm ON product_barcodes USING gin (barcode gin_trgm_ops);
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inventory_batches_qty_nonneg') THEN
    ALTER TABLE inventory_batches ADD CONSTRAINT chk_inventory_batches_qty_nonneg CHECK (qty_remaining >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_sales_totals_nonneg') THEN
    ALTER TABLE sales ADD CONSTRAINT chk_sales_totals_nonneg CHECK (subtotal_cents >= 0 AND total_cents >= 0 AND discount_cents >= 0 AND tax_cents >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_sales_kind_valid') THEN
    ALTER TABLE sales ADD CONSTRAINT chk_sales_kind_valid CHECK (kind IN ('sale', 'refund', 'void'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_sale_lines_qty_pos') THEN
    ALTER TABLE sale_lines ADD CONSTRAINT chk_sale_lines_qty_pos CHECK (pack_qty >= 1 AND qty_packs >= 1 AND base_units_sold >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_product_barcodes_valid') THEN
    ALTER TABLE product_barcodes ADD CONSTRAINT chk_product_barcodes_valid CHECK (pack_qty >= 1 AND sell_price_cents >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_products_costs_valid') THEN
    ALTER TABLE products ADD CONSTRAINT chk_products_costs_valid CHECK (avg_cost_cents >= 0 AND min_margin_bp BETWEEN 0 AND 9500);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_sale_payments_amount_nonneg') THEN
    ALTER TABLE sale_payments ADD CONSTRAINT chk_sale_payments_amount_nonneg CHECK (amount_cents >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_po_lines_cases_valid') THEN
    ALTER TABLE purchase_order_lines ADD CONSTRAINT chk_po_lines_cases_valid CHECK (ordered_cases >= 1 AND received_cases >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_purchase_orders_status_valid') THEN
    ALTER TABLE purchase_orders ADD CONSTRAINT chk_purchase_orders_status_valid CHECK (
      status IN ('draft', 'approved', 'sent', 'partially_received', 'received', 'cancelled')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_grn_lines_valid') THEN
    ALTER TABLE grn_lines ADD CONSTRAINT chk_grn_lines_valid CHECK (
      case_qty >= 1 AND paid_cases >= 0 AND free_bonus_cases >= 0
      AND base_units_received >= 1 AND invoice_line_total_cents >= 0
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_targeted_coupons_valid') THEN
    ALTER TABLE targeted_coupons ADD CONSTRAINT chk_targeted_coupons_valid CHECK (
      discount_cents >= 1 AND min_basket_cents >= 0 AND valid_until >= valid_from
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_pos_shifts_float_nonneg') THEN
    ALTER TABLE pos_shifts ADD CONSTRAINT chk_pos_shifts_float_nonneg CHECK (
      opening_float_cents >= 0 AND cash_drops_cents >= 0
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_store_footfall_nonneg') THEN
    ALTER TABLE store_footfall ADD CONSTRAINT chk_store_footfall_nonneg CHECK (
      entries >= 0 AND exits >= 0 AND open_lanes >= 1
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_role_valid') THEN
    ALTER TABLE users ADD CONSTRAINT chk_users_role_valid CHECK (
      role IN ('owner', 'manager', 'stock_clerk', 'cashier', 'accountant')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_promotions_window') THEN
    ALTER TABLE promotions ADD CONSTRAINT chk_promotions_window CHECK (ends_at >= starts_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_promotions_daypart_hours') THEN
    ALTER TABLE promotions ADD CONSTRAINT chk_promotions_daypart_hours CHECK (
      (daypart_start_hour IS NULL AND daypart_end_hour IS NULL)
      OR (daypart_start_hour BETWEEN 0 AND 23 AND daypart_end_hour BETWEEN 1 AND 24)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_products_unit_mode_valid') THEN
    ALTER TABLE products ADD CONSTRAINT chk_products_unit_mode_valid CHECK (
      unit_mode IN ('each', 'weight_g', 'volume_ml') AND default_tare_grams >= 0
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_sale_lines_weight_valid') THEN
    ALTER TABLE sale_lines ADD CONSTRAINT chk_sale_lines_weight_valid CHECK (
      (weight_grams IS NULL OR weight_grams >= 1) AND (tare_grams IS NULL OR tare_grams >= 0)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_recipes_valid') THEN
    ALTER TABLE recipes ADD CONSTRAINT chk_recipes_valid CHECK (
      expected_yield_base_units >= 1 AND shelf_life_days >= 1
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_production_batches_valid') THEN
    ALTER TABLE production_batches ADD CONSTRAINT chk_production_batches_valid CHECK (
      batch_multiplier >= 1 AND expected_output_units >= 1 AND actual_output_units >= 1 AND trim_waste_units >= 0
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_store_settings_valid') THEN
    ALTER TABLE store_settings ADD CONSTRAINT chk_store_settings_valid CHECK (
      secondary_fx_rate > 0 AND secondary_rounding_step >= 1 AND cash_skim_limit_cents >= 1000
      AND default_qr_rail IN ('khqr', 'promptpay', 'paynow')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_payment_intents_valid') THEN
    ALTER TABLE payment_intents ADD CONSTRAINT chk_payment_intents_valid CHECK (
      amount_cents >= 1
      AND rail IN ('khqr', 'promptpay', 'paynow', 'card_terminal')
      AND status IN ('pending', 'paid', 'expired', 'failed', 'cancelled')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_parked_baskets_valid') THEN
    ALTER TABLE parked_baskets ADD CONSTRAINT chk_parked_baskets_valid CHECK (
      subtotal_cents >= 0 AND item_count >= 1
      AND status IN ('parked', 'recalled', 'cancelled')
    );
  END IF;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION unit_cost_divisor(mode text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN mode IN ('weight_g', 'volume_ml') THEN 1000.0 ELSE 1.0 END;
$$;--> statement-breakpoint
CREATE OR REPLACE VIEW v_product_live_stock AS
SELECT
  p.id AS product_id,
  COALESCE(sb.quantity, 0) + COALESCE(unfolded.delta_sum, 0) AS on_hand_units
FROM products p
LEFT JOIN stock_baselines sb ON sb.product_id = p.id
LEFT JOIN (
  SELECT product_id, SUM(qty_delta)::int AS delta_sum
  FROM stock_movements
  WHERE folded = false
  GROUP BY product_id
) unfolded ON unfolded.product_id = p.id;
