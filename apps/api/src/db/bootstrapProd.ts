import { validateCredentialStrength } from "@supermarket/shared";
import { eq } from "drizzle-orm";
import { hashPin } from "../plugins/auth.js";
import { getOrCreateStoreSettings } from "../services/payments.js";
import { db, pool, taxRates, users } from "./index.js";

/**
 * Minimal non-destructive production bootstrap:
 * ensures baseline tax rates, Flagship store settings row, and an initial strong-PIN owner.
 */
async function bootstrapProd() {
  const ownerUsername = (process.env.BOOTSTRAP_OWNER_USERNAME ?? "").trim().toLowerCase();
  const ownerFullName = (process.env.BOOTSTRAP_OWNER_FULL_NAME ?? "Store Owner").trim();
  const ownerPin = (process.env.BOOTSTRAP_OWNER_PIN ?? "").trim();

  if (!ownerUsername || ownerUsername.length < 3) {
    throw new Error("BOOTSTRAP_OWNER_USERNAME (>= 3 chars) is required.");
  }
  const strengthErr = validateCredentialStrength(ownerPin, "owner");
  if (strengthErr) {
    throw new Error(`Invalid BOOTSTRAP_OWNER_PIN: ${strengthErr}`);
  }

  const defaultTaxes = [
    { code: "VAT10", name: "Standard VAT 10%", rateBp: 1000, isInclusive: true },
    { code: "FRESH0", name: "Fresh Produce / Zero-Rated 0%", rateBp: 0, isInclusive: true },
    { code: "ALC", name: "Alcohol Excise & VAT 15%", rateBp: 1500, isInclusive: true },
  ];
  for (const t of defaultTaxes) {
    await db
      .insert(taxRates)
      .values(t)
      .onConflictDoNothing({ target: taxRates.code });
  }

  await getOrCreateStoreSettings();

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, ownerUsername))
    .limit(1);

  if (!existing) {
    const pinHash = await hashPin(ownerPin);
    await db.insert(users).values({
      username: ownerUsername,
      fullName: ownerFullName || "Store Owner",
      role: "owner",
      pinHash,
      active: true,
    });
    console.log(`Bootstrapped production owner user "${ownerUsername}".`);
  } else {
    console.log(`Owner user "${ownerUsername}" already exists; left unchanged.`);
  }
}

const normalizedArgv1 = process.argv[1]?.replace(/\\/g, "/");
const isMain =
  normalizedArgv1?.endsWith("/bootstrapProd.js") ||
  normalizedArgv1?.endsWith("/bootstrapProd.ts");
if (isMain) {
  bootstrapProd()
    .then(async () => {
      await pool.end();
    })
    .catch(async (err) => {
      console.error("Production bootstrap failed:", err);
      await pool.end();
      process.exit(1);
    });
}
