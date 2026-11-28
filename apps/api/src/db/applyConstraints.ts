import { sql } from "drizzle-orm";
import { db, pool } from "./index.js";

/**
 * Applies idempotent PostgreSQL CHECK constraints, partial unique indexes,
 * and live inventory SQL views that Drizzle schema builder does not express natively.
 */
export async function applyDatabaseConstraintsAndViews() {
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_product_primary_barcode
      ON product_barcodes (product_id)
      WHERE is_primary = true;
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_stock_movements_unfolded
      ON stock_movements (product_id)
      WHERE folded = false;
  `);

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_shifts_open_register
      ON pos_shifts (register_code)
      WHERE closed_at IS NULL;
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_sales_kind_sold_at
      ON sales (kind, sold_at);
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_sales_original_sale
      ON sales (original_sale_id)
      WHERE original_sale_id IS NOT NULL;
  `);

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_single_void_per_original
      ON sales (original_sale_id)
      WHERE kind = 'void' AND original_sale_id IS NOT NULL;
  `);

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_targeted_coupons_upper_code
      ON targeted_coupons (upper(code));
  `);

  // Drop redundant indexes superseded by column-level UNIQUE constraints (M-09)
  await db.execute(sql`DROP INDEX IF EXISTS uq_stock_baselines_product;`);
  await db.execute(sql`DROP INDEX IF EXISTS idx_store_footfall_bucket;`);

  // PostgreSQL pg_trgm GIN indexes for fast wildcard ILIKE catalog/barcode search (M-06)
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_products_name_trgm
      ON products USING gin (name gin_trgm_ops);
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_products_sku_trgm
      ON products USING gin (sku gin_trgm_ops);
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_products_brand_trgm
      ON products USING gin (brand gin_trgm_ops);
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_product_barcodes_barcode_trgm
      ON product_barcodes USING gin (barcode gin_trgm_ops);
  `);

  // Idempotent CHECK constraint helper statements
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_inventory_batches_qty_nonneg'
      ) THEN
        ALTER TABLE inventory_batches
          ADD CONSTRAINT chk_inventory_batches_qty_nonneg CHECK (qty_remaining >= 0);
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_sales_totals_nonneg'
      ) THEN
        ALTER TABLE sales
          ADD CONSTRAINT chk_sales_totals_nonneg CHECK (subtotal_cents >= 0 AND total_cents >= 0 AND discount_cents >= 0 AND tax_cents >= 0);
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_sales_kind_valid'
      ) THEN
        ALTER TABLE sales
          ADD CONSTRAINT chk_sales_kind_valid CHECK (kind IN ('sale', 'refund', 'void'));
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_sale_lines_qty_pos'
      ) THEN
        ALTER TABLE sale_lines
          ADD CONSTRAINT chk_sale_lines_qty_pos CHECK (pack_qty >= 1 AND qty_packs >= 1 AND base_units_sold >= 1);
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_product_barcodes_valid'
      ) THEN
        ALTER TABLE product_barcodes
          ADD CONSTRAINT chk_product_barcodes_valid CHECK (pack_qty >= 1 AND sell_price_cents >= 1);
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_products_costs_valid'
      ) THEN
        ALTER TABLE products
          ADD CONSTRAINT chk_products_costs_valid CHECK (avg_cost_cents >= 0 AND min_margin_bp BETWEEN 0 AND 9500);
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_sale_payments_amount_nonneg'
      ) THEN
        ALTER TABLE sale_payments
          ADD CONSTRAINT chk_sale_payments_amount_nonneg CHECK (amount_cents >= 0);
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_po_lines_cases_valid'
      ) THEN
        ALTER TABLE purchase_order_lines
          ADD CONSTRAINT chk_po_lines_cases_valid CHECK (ordered_cases >= 1 AND received_cases >= 0);
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_purchase_orders_status_valid'
      ) THEN
        ALTER TABLE purchase_orders
          ADD CONSTRAINT chk_purchase_orders_status_valid CHECK (
            status IN ('draft', 'approved', 'sent', 'partially_received', 'received', 'cancelled')
          );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_grn_lines_valid'
      ) THEN
        ALTER TABLE grn_lines
          ADD CONSTRAINT chk_grn_lines_valid CHECK (
            case_qty >= 1 AND paid_cases >= 0 AND free_bonus_cases >= 0
            AND base_units_received >= 1 AND invoice_line_total_cents >= 0
          );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_targeted_coupons_valid'
      ) THEN
        ALTER TABLE targeted_coupons
          ADD CONSTRAINT chk_targeted_coupons_valid CHECK (
            discount_cents >= 1 AND min_basket_cents >= 0 AND valid_until >= valid_from
          );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_pos_shifts_float_nonneg'
      ) THEN
        ALTER TABLE pos_shifts
          ADD CONSTRAINT chk_pos_shifts_float_nonneg CHECK (
            opening_float_cents >= 0 AND cash_drops_cents >= 0
          );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_store_footfall_nonneg'
      ) THEN
        ALTER TABLE store_footfall
          ADD CONSTRAINT chk_store_footfall_nonneg CHECK (
            entries >= 0 AND exits >= 0 AND open_lanes >= 1
          );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_role_valid'
      ) THEN
        ALTER TABLE users
          ADD CONSTRAINT chk_users_role_valid CHECK (
            role IN ('owner', 'manager', 'stock_clerk', 'cashier', 'accountant')
          );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_promotions_window'
      ) THEN
        ALTER TABLE promotions
          ADD CONSTRAINT chk_promotions_window CHECK (ends_at >= starts_at);
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_promotions_daypart_hours'
      ) THEN
        ALTER TABLE promotions
          ADD CONSTRAINT chk_promotions_daypart_hours CHECK (
            (daypart_start_hour IS NULL AND daypart_end_hour IS NULL)
            OR (daypart_start_hour BETWEEN 0 AND 23 AND daypart_end_hour BETWEEN 1 AND 24)
          );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_products_unit_mode_valid'
      ) THEN
        ALTER TABLE products
          ADD CONSTRAINT chk_products_unit_mode_valid CHECK (
            unit_mode IN ('each', 'weight_g', 'volume_ml') AND default_tare_grams >= 0
          );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_sale_lines_weight_valid'
      ) THEN
        ALTER TABLE sale_lines
          ADD CONSTRAINT chk_sale_lines_weight_valid CHECK (
            (weight_grams IS NULL OR weight_grams >= 1) AND (tare_grams IS NULL OR tare_grams >= 0)
          );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_recipes_valid'
      ) THEN
        ALTER TABLE recipes
          ADD CONSTRAINT chk_recipes_valid CHECK (
            expected_yield_base_units >= 1 AND shelf_life_days >= 1
          );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_production_batches_valid'
      ) THEN
        ALTER TABLE production_batches
          ADD CONSTRAINT chk_production_batches_valid CHECK (
            batch_multiplier >= 1 AND expected_output_units >= 1 AND actual_output_units >= 1 AND trim_waste_units >= 0
          );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_store_settings_valid'
      ) THEN
        ALTER TABLE store_settings
          ADD CONSTRAINT chk_store_settings_valid CHECK (
            secondary_fx_rate > 0 AND secondary_rounding_step >= 1 AND cash_skim_limit_cents >= 1000
            AND default_qr_rail IN ('khqr', 'promptpay', 'paynow')
          );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_payment_intents_valid'
      ) THEN
        ALTER TABLE payment_intents
          ADD CONSTRAINT chk_payment_intents_valid CHECK (
            amount_cents >= 1
            AND rail IN ('khqr', 'promptpay', 'paynow', 'card_terminal')
            AND status IN ('pending', 'paid', 'expired', 'failed', 'cancelled')
          );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_parked_baskets_valid'
      ) THEN
        ALTER TABLE parked_baskets
          ADD CONSTRAINT chk_parked_baskets_valid CHECK (
            subtotal_cents >= 0 AND item_count >= 1
            AND status IN ('parked', 'recalled', 'cancelled')
          );
      END IF;
    END $$;
  `);

  await db.execute(sql`
    CREATE OR REPLACE FUNCTION unit_cost_divisor(mode text)
    RETURNS numeric
    LANGUAGE sql
    IMMUTABLE
    AS $$
      SELECT CASE WHEN mode IN ('weight_g', 'volume_ml') THEN 1000.0 ELSE 1.0 END;
    $$;
  `);

  await db.execute(sql`
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
  `);
}

// Run directly when invoked as a standalone CLI script
const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("/applyConstraints.ts");
if (isMain) {
  applyDatabaseConstraintsAndViews()
    .then(async () => {
      console.log("Applied PostgreSQL constraints, partial indexes, and v_product_live_stock view.");
      await pool.end();
    })
    .catch(async (err) => {
      console.error("Failed to apply constraints/views:", err);
      await pool.end();
      process.exit(1);
    });
}
