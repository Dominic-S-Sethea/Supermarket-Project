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
    CREATE UNIQUE INDEX IF NOT EXISTS uq_targeted_coupons_upper_code
      ON targeted_coupons (upper(code));
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
          ADD CONSTRAINT chk_sales_totals_nonneg CHECK (subtotal_cents >= 0 AND total_cents >= 0);
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
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_promotions_daypart_hours'
      ) THEN
        ALTER TABLE promotions
          ADD CONSTRAINT chk_promotions_daypart_hours CHECK (
            (daypart_start_hour IS NULL AND daypart_end_hour IS NULL)
            OR (daypart_start_hour BETWEEN 0 AND 23 AND daypart_end_hour BETWEEN 1 AND 24)
          );
      END IF;
    END $$;
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
