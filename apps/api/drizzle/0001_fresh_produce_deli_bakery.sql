CREATE TABLE "production_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"output_product_id" uuid NOT NULL,
	"output_batch_id" uuid,
	"lot_code" text NOT NULL,
	"batch_multiplier" integer DEFAULT 1 NOT NULL,
	"expected_output_units" integer NOT NULL,
	"actual_output_units" integer NOT NULL,
	"trim_waste_units" integer DEFAULT 0 NOT NULL,
	"yield_bp" integer NOT NULL,
	"total_ingredient_cost_cents" bigint NOT NULL,
	"effective_unit_cost_cents" bigint NOT NULL,
	"produced_by" text NOT NULL,
	"notes" text,
	"produced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_ingredients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"ingredient_product_id" uuid NOT NULL,
	"qty_base_units" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"output_product_id" uuid NOT NULL,
	"expected_yield_base_units" integer NOT NULL,
	"shelf_life_days" integer DEFAULT 3 NOT NULL,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "unit_mode" text DEFAULT 'each' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "plu_code" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "default_tare_grams" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "net_content_amount" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "net_content_unit" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "allergens_json" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "ingredients_text" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "recalled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "recall_reason" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "recalled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "weight_grams" integer;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "tare_grams" integer;--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_output_product_id_products_id_fk" FOREIGN KEY ("output_product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_output_batch_id_inventory_batches_id_fk" FOREIGN KEY ("output_batch_id") REFERENCES "public"."inventory_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_ingredient_product_id_products_id_fk" FOREIGN KEY ("ingredient_product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_output_product_id_products_id_fk" FOREIGN KEY ("output_product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_production_batches_recipe" ON "production_batches" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "idx_production_batches_produced" ON "production_batches" USING btree ("produced_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_recipe_ingredient" ON "recipe_ingredients" USING btree ("recipe_id","ingredient_product_id");--> statement-breakpoint
CREATE INDEX "idx_recipe_ingredients_recipe" ON "recipe_ingredients" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "idx_recipes_output_product" ON "recipes" USING btree ("output_product_id");--> statement-breakpoint
CREATE INDEX "idx_products_unit_mode" ON "products" USING btree ("unit_mode");--> statement-breakpoint
CREATE INDEX "idx_products_recalled" ON "products" USING btree ("recalled");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_plu_code_unique" UNIQUE("plu_code");