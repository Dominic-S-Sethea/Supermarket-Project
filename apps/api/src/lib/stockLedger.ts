import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { db as dbClient } from "../db/index.js";
import { inventoryBatches } from "../db/index.js";

type DbOrTx = Pick<typeof dbClient, "execute" | "select" | "update" | "insert">;

export const FOLD_LEDGER_ADVISORY_LOCK_KEY = 72839104;

/**
 * Compute live on-hand inventory for one or more products in a single SQL statement
 * (single READ COMMITTED MVCC snapshot over stock_baselines + unfolded stock_movements).
 */
export async function getLiveStockForProductsTx(
  tx: Pick<typeof dbClient, "execute">,
  productIds: string[]
): Promise<Map<string, number>> {
  const uniqueIds = Array.from(new Set(productIds));
  const result = new Map<string, number>();
  if (uniqueIds.length === 0) return result;

  const res = await tx.execute(sql`
    WITH target_pids AS (
      SELECT unnest(${uniqueIds}::uuid[]) AS id
    ),
    unfolded AS (
      SELECT product_id, COALESCE(SUM(qty_delta), 0)::int AS delta
      FROM stock_movements
      WHERE folded = false
        AND product_id = ANY(${uniqueIds}::uuid[])
      GROUP BY product_id
    )
    SELECT
      tp.id::text AS product_id,
      (COALESCE(sb.quantity, 0) + COALESCE(u.delta, 0))::int AS on_hand
    FROM target_pids tp
    LEFT JOIN stock_baselines sb ON sb.product_id = tp.id
    LEFT JOIN unfolded u ON u.product_id = tp.id
  `);

  for (const row of res.rows as { product_id: string; on_hand: number }[]) {
    result.set(String(row.product_id), Number(row.on_hand ?? 0));
  }
  return result;
}

/**
 * Atomically fold unfolded stock_movements into stock_baselines using an advisory lock
 * and deterministic product_id lock ordering to prevent 40P01 deadlocks.
 */
export async function foldStockLedger(
  dbInstance: typeof dbClient
): Promise<{ movements_folded: number; products_updated: number; skipped?: boolean }> {
  return dbInstance.transaction(async (tx) => {
    const lockRes = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${FOLD_LEDGER_ADVISORY_LOCK_KEY}) AS acquired`
    );
    const acquired = Boolean((lockRes.rows[0] as { acquired?: boolean } | undefined)?.acquired);
    if (!acquired) {
      return { movements_folded: 0, products_updated: 0, skipped: true };
    }

    const res = await tx.execute(sql`
      WITH batch AS (
        UPDATE stock_movements
        SET folded = true
        WHERE folded = false
        RETURNING product_id, qty_delta
      ),
      agg AS (
        SELECT product_id, SUM(qty_delta)::int AS total_delta
        FROM batch
        GROUP BY product_id
        ORDER BY product_id ASC
      ),
      upserted AS (
        INSERT INTO stock_baselines (product_id, quantity, updated_at)
        SELECT product_id, total_delta, now() FROM agg
        ON CONFLICT (product_id)
        DO UPDATE SET
          quantity = stock_baselines.quantity + EXCLUDED.quantity,
          updated_at = now()
        RETURNING product_id
      )
      SELECT
        (SELECT count(*)::int FROM batch) AS movements_folded,
        (SELECT count(*)::int FROM upserted) AS products_updated;
    `);
    const row = (res.rows[0] ?? {}) as { movements_folded?: number; products_updated?: number };
    return {
      movements_folded: Number(row.movements_folded ?? 0),
      products_updated: Number(row.products_updated ?? 0),
    };
  });
}

export interface FefoAllocationResult {
  allocations: { batchId: string; qty: number; depletedClearance: boolean }[];
  unbatchedRemainder: number;
}

/**
 * Lock and deplete active/clearance FEFO inventory_batches in ascending bestBeforeDate + id order.
 */
export async function depleteFefoBatchesTx(
  tx: DbOrTx,
  productId: string,
  qtyToDeplete: number
): Promise<FefoAllocationResult> {
  let remaining = Math.max(0, Math.round(qtyToDeplete));
  const allocations: FefoAllocationResult["allocations"] = [];
  if (remaining === 0) return { allocations, unbatchedRemainder: 0 };

  const fefoBatches = await tx
    .select()
    .from(inventoryBatches)
    .where(
      and(
        eq(inventoryBatches.productId, productId),
        gt(inventoryBatches.qtyRemaining, 0),
        sql`${inventoryBatches.status} IN ('active', 'clearance')`
      )
    )
    .orderBy(asc(inventoryBatches.bestBeforeDate), asc(inventoryBatches.id))
    .for("update");

  for (const batch of fefoBatches) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, batch.qtyRemaining);
    const nextQty = batch.qtyRemaining - take;
    await tx
      .update(inventoryBatches)
      .set({
        qtyRemaining: nextQty,
        status: nextQty === 0 ? "depleted" : batch.status,
      })
      .where(eq(inventoryBatches.id, batch.id));

    allocations.push({
      batchId: batch.id,
      qty: take,
      depletedClearance: batch.status === "clearance" && nextQty === 0,
    });
    remaining -= take;
  }

  return { allocations, unbatchedRemainder: remaining };
}
