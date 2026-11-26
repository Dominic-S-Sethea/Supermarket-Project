CREATE TABLE "parked_baskets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hold_code" text NOT NULL,
	"register_code" text DEFAULT 'REG-01' NOT NULL,
	"cashier_name" text NOT NULL,
	"customer_label" text,
	"customer_id" uuid,
	"coupon_code" text,
	"lines_json" jsonb NOT NULL,
	"subtotal_cents" bigint NOT NULL,
	"item_count" integer NOT NULL,
	"note" text,
	"status" text DEFAULT 'parked' NOT NULL,
	"parked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recalled_at" timestamp with time zone,
	"recalled_by" text,
	CONSTRAINT "parked_baskets_hold_code_unique" UNIQUE("hold_code")
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"register_code" text DEFAULT 'REG-01' NOT NULL,
	"rail" text NOT NULL,
	"provider" text DEFAULT 'mock_sandbox' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency_code" text DEFAULT 'USD' NOT NULL,
	"display_amount" text NOT NULL,
	"bill_reference" text NOT NULL,
	"qr_payload" text,
	"external_ref" text,
	"sale_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intents_bill_reference_unique" UNIQUE("bill_reference")
);
--> statement-breakpoint
CREATE TABLE "store_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text DEFAULT 'FLAGSHIP' NOT NULL,
	"legal_name" text DEFAULT 'SupermarketOS Flagship Retail Co., Ltd.' NOT NULL,
	"store_name" text DEFAULT 'SupermarketOS Flagship #01' NOT NULL,
	"address" text DEFAULT '128 Monivong Blvd, Phnom Penh' NOT NULL,
	"tax_id" text DEFAULT 'VAT-KH-100294812' NOT NULL,
	"primary_currency" text DEFAULT 'USD' NOT NULL,
	"secondary_currency" text DEFAULT 'KHR',
	"secondary_fx_rate" double precision DEFAULT 4100 NOT NULL,
	"secondary_rounding_step" integer DEFAULT 100 NOT NULL,
	"cash_skim_limit_cents" bigint DEFAULT 200000 NOT NULL,
	"receipt_header" text DEFAULT 'Fresh Produce · Butcher · Bakery · Everyday Essentials' NOT NULL,
	"receipt_footer" text DEFAULT 'Thank you for shopping at SupermarketOS Flagship!' NOT NULL,
	"default_qr_rail" text DEFAULT 'khqr' NOT NULL,
	"payment_provider" text DEFAULT 'mock_sandbox' NOT NULL,
	"khqr_account_id" text DEFAULT 'flagship_market@aba' NOT NULL,
	"khqr_merchant_id" text DEFAULT 'MERCH-88412',
	"khqr_acquiring_bank" text DEFAULT 'ABA Bank' NOT NULL,
	"khqr_city" text DEFAULT 'Phnom Penh' NOT NULL,
	"promptpay_proxy" text DEFAULT '0812345678' NOT NULL,
	"paynow_uen" text DEFAULT '202612345K' NOT NULL,
	"fiscal_provider" text DEFAULT 'local_hash_chain' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_settings_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "payment_intent_id" uuid;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "currency_code" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "foreign_amount" bigint;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "fx_rate_used" double precision;--> statement-breakpoint
ALTER TABLE "parked_baskets" ADD CONSTRAINT "parked_baskets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_parked_baskets_status_parked" ON "parked_baskets" USING btree ("status","parked_at");--> statement-breakpoint
CREATE INDEX "idx_parked_baskets_register" ON "parked_baskets" USING btree ("register_code");--> statement-breakpoint
CREATE INDEX "idx_payment_intents_status_created" ON "payment_intents" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_payment_intents_sale" ON "payment_intents" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "idx_sale_payments_intent" ON "sale_payments" USING btree ("payment_intent_id");