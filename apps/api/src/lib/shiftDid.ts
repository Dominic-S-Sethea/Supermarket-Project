import { sql } from "drizzle-orm";
import type { db as dbClient } from "../db/index.js";

export interface ShiftExperimentSpec {
  targetShift: string;
  controlShift: string;
  preStartDate: string;
  preEndDate: string;
  postStartDate: string;
  postEndDate: string;
}

export interface DidResult {
  preTargetMeanUsd: number;
  postTargetMeanUsd: number;
  preControlMeanUsd: number;
  postControlMeanUsd: number;
  didLiftUsdPerDay: number;
  didLiftPct: number;
  ciLowUsd: number;
  ciHighUsd: number;
  pValue: number;
  controlChangePct: number;
  cannibalizationFlag: boolean;
  verdict: "significant_positive" | "inconclusive" | "negative_or_cannibalized";
}

function erfcApprox(x: number): number {
  const z = Math.abs(x);
  const t = 1.0 / (1.0 + 0.5 * z);
  const ans =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
    );
  return x >= 0 ? ans : 2.0 - ans;
}

function seededLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function computeDidStats(
  preTarget: number[],
  postTarget: number[],
  preControl: number[],
  postControl: number[]
): DidResult {
  const mPreT = mean(preTarget);
  const mPostT = mean(postTarget);
  const mPreC = mean(preControl);
  const mPostC = mean(postControl);

  const deltaT = mPostT - mPreT;
  const deltaC = mPostC - mPreC;
  const scale = mPreC > 1e-6 ? mPreT / mPreC : 1.0;
  const didLift = deltaT - deltaC * scale;
  const didLiftPct = mPreT > 0 ? (didLift / mPreT) * 100.0 : 0.0;
  const controlChangePct = mPreC > 0 ? (deltaC / mPreC) * 100.0 : 0.0;

  let ciLow = didLift;
  let ciHigh = didLift;
  let pVal = 1.0;

  if (
    preTarget.length >= 2 &&
    postTarget.length >= 2 &&
    preControl.length >= 2 &&
    postControl.length >= 2
  ) {
    const rng = seededLcg(42);
    const nBoot = 400;
    const boots: number[] = [];
    const sampleMean = (arr: number[]) => {
      let s = 0;
      for (let i = 0; i < arr.length; i++) {
        s += arr[Math.floor(rng() * arr.length)];
      }
      return s / arr.length;
    };
    for (let b = 0; b < nBoot; b++) {
      const bPreT = sampleMean(preTarget);
      const bPostT = sampleMean(postTarget);
      const bPreC = sampleMean(preControl);
      const bPostC = sampleMean(postControl);
      const bScale = bPreC > 1e-6 ? bPreT / bPreC : 1.0;
      boots.push(bPostT - bPreT - (bPostC - bPreC) * bScale);
    }
    boots.sort((a, b) => a - b);
    ciLow = boots[Math.floor(nBoot * 0.025)] ?? didLift;
    ciHigh = boots[Math.floor(nBoot * 0.975)] ?? didLift;
    const bMean = mean(boots);
    const variance =
      boots.reduce((acc, v) => acc + (v - bMean) ** 2, 0) / Math.max(1, boots.length - 1);
    const se = Math.sqrt(Math.max(1e-9, variance));
    pVal = erfcApprox(Math.abs(didLift) / se / Math.SQRT2);
  }

  const cannibalizationFlag = controlChangePct < -5.0;
  const verdict: DidResult["verdict"] =
    cannibalizationFlag || didLift < 0
      ? "negative_or_cannibalized"
      : ciLow > 0 && pVal < 0.05
        ? "significant_positive"
        : "inconclusive";

  return {
    preTargetMeanUsd: Number(mPreT.toFixed(2)),
    postTargetMeanUsd: Number(mPostT.toFixed(2)),
    preControlMeanUsd: Number(mPreC.toFixed(2)),
    postControlMeanUsd: Number(mPostC.toFixed(2)),
    didLiftUsdPerDay: Number(didLift.toFixed(2)),
    didLiftPct: Number(didLiftPct.toFixed(2)),
    ciLowUsd: Number(ciLow.toFixed(2)),
    ciHighUsd: Number(ciHigh.toFixed(2)),
    pValue: Number(Math.min(1, Math.max(0, pVal)).toFixed(5)),
    controlChangePct: Number(controlChangePct.toFixed(2)),
    cannibalizationFlag,
    verdict,
  };
}

export async function evaluateShiftExperiment(
  db: typeof dbClient,
  spec: ShiftExperimentSpec
): Promise<DidResult> {
  const minDate = spec.preStartDate < spec.postStartDate ? spec.preStartDate : spec.postStartDate;
  const maxDate = spec.preEndDate > spec.postEndDate ? spec.preEndDate : spec.postEndDate;

  const res = await db.execute(sql`
    SELECT
      to_char(DATE(sold_at), 'YYYY-MM-DD') AS day_str,
      CASE
        WHEN EXTRACT(HOUR FROM sold_at) < 12 THEN 'morning'
        WHEN EXTRACT(HOUR FROM sold_at) < 17 THEN 'afternoon'
        ELSE 'evening'
      END AS shift_key,
      COALESCE(SUM(total_cents) FILTER (WHERE kind = 'sale'), 0)::bigint AS rev_cents
    FROM sales
    WHERE DATE(sold_at) >= ${minDate}::date
      AND DATE(sold_at) <= ${maxDate}::date
    GROUP BY 1, 2
  `);

  const preT: number[] = [];
  const postT: number[] = [];
  const preC: number[] = [];
  const postC: number[] = [];

  for (const r of res.rows as Record<string, unknown>[]) {
    const day = String(r.day_str);
    const shift = String(r.shift_key);
    const revUsd = Number(r.rev_cents ?? 0) / 100.0;
    const inPre = day >= spec.preStartDate && day <= spec.preEndDate;
    const inPost = day >= spec.postStartDate && day <= spec.postEndDate;
    if (shift === spec.targetShift) {
      if (inPre) preT.push(revUsd);
      if (inPost) postT.push(revUsd);
    }
    if (shift === spec.controlShift) {
      if (inPre) preC.push(revUsd);
      if (inPost) postC.push(revUsd);
    }
  }

  return computeDidStats(preT, postT, preC, postC);
}
