CREATE TABLE "ai_briefings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"briefing_date" text NOT NULL,
	"headline" text NOT NULL,
	"bullets_json" jsonb NOT NULL,
	"model" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_briefings_briefing_date_unique" UNIQUE("briefing_date")
);
--> statement-breakpoint
CREATE TABLE "ai_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"last_interaction_id" text,
	"model" text DEFAULT 'gemini-4-hydrogen' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_calls_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_proposed_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"action_type" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"preview_json" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" text NOT NULL,
	"executed_by" text,
	"execution_result_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "analytics_abc_xyz" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"revenue_60d_cents" bigint NOT NULL,
	"profit_60d_cents" bigint NOT NULL,
	"units_60d" integer NOT NULL,
	"avg_daily_units" double precision NOT NULL,
	"demand_cv" double precision NOT NULL,
	"adi" double precision NOT NULL,
	"abc_class" text NOT NULL,
	"xyz_class" text NOT NULL,
	"segment" text NOT NULL,
	"gmroii" double precision NOT NULL,
	"days_of_stock" double precision NOT NULL,
	"recommended_action" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_basket_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_bucket" text DEFAULT 'all' NOT NULL,
	"antecedent_product_id" uuid NOT NULL,
	"consequent_product_id" uuid NOT NULL,
	"antecedent_name" text NOT NULL,
	"consequent_name" text NOT NULL,
	"co_occurrences" integer NOT NULL,
	"support" double precision NOT NULL,
	"confidence" double precision NOT NULL,
	"lift" double precision NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_demand_forecasts" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"model_used" text NOT NULL,
	"forecast_7d_units" integer NOT NULL,
	"forecast_14d_units" integer NOT NULL,
	"safety_stock_units" integer NOT NULL,
	"reorder_point_units" integer NOT NULL,
	"current_stock_units" integer NOT NULL,
	"suggested_order_cases" integer NOT NULL,
	"case_qty" integer NOT NULL,
	"estimated_order_cost_cents" bigint NOT NULL,
	"supplier_name" text NOT NULL,
	"wmape_pct" double precision NOT NULL,
	"urgency" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_dynamic_markdowns" (
	"batch_id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"days_left" integer NOT NULL,
	"qty_remaining" integer NOT NULL,
	"current_sell_price_cents" bigint NOT NULL,
	"unit_cost_cents" bigint NOT NULL,
	"recommended_discount_bp" integer NOT NULL,
	"recommended_promo_price_cents" bigint NOT NULL,
	"predicted_clearance_units" integer NOT NULL,
	"expected_recovery_cents" bigint NOT NULL,
	"baseline_no_promo_recovery_cents" bigint NOT NULL,
	"status" text DEFAULT 'recommended' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_lp_anomalies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cashier_name" text NOT NULL,
	"total_sales_count" integer NOT NULL,
	"void_count" integer NOT NULL,
	"refund_count" integer NOT NULL,
	"no_sale_drawer_count" integer NOT NULL,
	"void_rate_pct" double precision NOT NULL,
	"z_score" double precision NOT NULL,
	"risk_level" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_phantom_stock" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"book_stock_units" integer NOT NULL,
	"avg_daily_units" double precision NOT NULL,
	"days_since_last_sale" double precision NOT NULL,
	"void_refund_score" double precision DEFAULT 0 NOT NULL,
	"phantom_prob" double precision NOT NULL,
	"estimated_value_at_risk_cents" bigint NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"elapsed_sec" double precision NOT NULL,
	"status" text NOT NULL,
	"stages_json" jsonb NOT NULL,
	"dq_passed" boolean DEFAULT true NOT NULL,
	"dq_checks_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_promo_roi" (
	"promotion_id" uuid PRIMARY KEY NOT NULL,
	"promotion_name" text NOT NULL,
	"promo_type" text NOT NULL,
	"discounted_units_60d" integer NOT NULL,
	"discounted_revenue_cents" bigint NOT NULL,
	"discount_given_cents" bigint NOT NULL,
	"baseline_daily_units" double precision NOT NULL,
	"promo_daily_units" double precision NOT NULL,
	"velocity_lift_pct" double precision NOT NULL,
	"net_margin_bp" integer NOT NULL,
	"estimated_profit_delta_cents" bigint NOT NULL,
	"verdict" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_shift_diagnostics" (
	"id" text PRIMARY KEY NOT NULL,
	"window_days" integer DEFAULT 60 NOT NULL,
	"primary_bottleneck" text NOT NULL,
	"morning_share_pct" double precision NOT NULL,
	"morning_conversion_pct" double precision NOT NULL,
	"afternoon_conversion_pct" double precision NOT NULL,
	"evening_conversion_pct" double precision NOT NULL,
	"morning_est_lost_revenue_cents" bigint NOT NULL,
	"shift_comparison_json" jsonb NOT NULL,
	"hourly_profile_json" jsonb NOT NULL,
	"oos_root_causes_json" jsonb NOT NULL,
	"queue_saturation_json" jsonb NOT NULL,
	"driver_attribution_json" jsonb NOT NULL,
	"shopper_missions_json" jsonb NOT NULL,
	"recommendations_json" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_supplier_scorecards" (
	"supplier_id" uuid PRIMARY KEY NOT NULL,
	"po_count_90d" integer NOT NULL,
	"grn_count_90d" integer NOT NULL,
	"on_time_rate_pct" double precision NOT NULL,
	"in_full_rate_pct" double precision NOT NULL,
	"otif_rate_pct" double precision NOT NULL,
	"cost_variance_rate_pct" double precision NOT NULL,
	"avg_lead_time_days" double precision NOT NULL,
	"lead_time_std_days" double precision NOT NULL,
	"total_variance_cents" bigint DEFAULT 0 NOT NULL,
	"grade" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"details_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"department_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"full_name" text NOT NULL,
	"email" text,
	"points_balance" integer DEFAULT 0 NOT NULL,
	"lifetime_spend_cents" bigint DEFAULT 0 NOT NULL,
	"visits_60d" integer DEFAULT 0 NOT NULL,
	"rfm_segment" text DEFAULT 'New' NOT NULL,
	"last_visit_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"target_margin_bp" integer DEFAULT 2400 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"po_id" uuid,
	"invoice_number" text NOT NULL,
	"received_by" text NOT NULL,
	"total_invoice_cents" bigint NOT NULL,
	"notes" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grn_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grn_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"case_qty" integer NOT NULL,
	"paid_cases" integer NOT NULL,
	"free_bonus_cases" integer DEFAULT 0 NOT NULL,
	"base_units_received" integer NOT NULL,
	"invoice_line_total_cents" bigint NOT NULL,
	"effective_unit_cost_cents" bigint NOT NULL,
	"best_before_date" date
);
--> statement-breakpoint
CREATE TABLE "grn_variances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grn_id" uuid NOT NULL,
	"po_id" uuid,
	"supplier_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variance_type" text NOT NULL,
	"ordered_qty_units" integer NOT NULL,
	"received_qty_units" integer NOT NULL,
	"po_unit_cost_cents" bigint NOT NULL,
	"invoice_unit_cost_cents" bigint NOT NULL,
	"financial_impact_cents" bigint NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hourly_stock_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_date" date NOT NULL,
	"snapshot_hour" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"on_hand_units" integer NOT NULL,
	"is_oos" boolean DEFAULT false NOT NULL,
	"restocked_at_hour" integer
);
--> statement-breakpoint
CREATE TABLE "inventory_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"lot_code" text NOT NULL,
	"best_before_date" date NOT NULL,
	"unit_cost_cents" bigint NOT NULL,
	"qty_received" integer NOT NULL,
	"qty_remaining" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loyalty_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"sale_id" uuid,
	"points_delta" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "margin_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"grn_id" uuid,
	"previous_cost_cents" bigint NOT NULL,
	"new_cost_cents" bigint NOT NULL,
	"current_sell_price_cents" bigint NOT NULL,
	"resulting_margin_bp" integer NOT NULL,
	"min_margin_bp" integer NOT NULL,
	"suggested_sell_price_cents" bigint NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_shifts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"register_code" text NOT NULL,
	"cashier_name" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"opening_float_cents" bigint DEFAULT 0 NOT NULL,
	"cash_drops_cents" bigint DEFAULT 0 NOT NULL,
	"blind_counted_cash_cents" bigint,
	"expected_cash_cents" bigint,
	"variance_cents" bigint,
	"z_report_no" text
);
--> statement-breakpoint
CREATE TABLE "product_barcodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"barcode" text NOT NULL,
	"pack_qty" integer DEFAULT 1 NOT NULL,
	"pack_label" text DEFAULT 'Single' NOT NULL,
	"sell_price_cents" bigint NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_orderable_case" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_barcodes_barcode_unique" UNIQUE("barcode")
);
--> statement-breakpoint
CREATE TABLE "product_embeddings" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"embedding_model" text NOT NULL,
	"text_hash" text NOT NULL,
	"vector_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"brand" text NOT NULL,
	"size_label" text DEFAULT '' NOT NULL,
	"category_id" uuid NOT NULL,
	"tax_rate_id" uuid NOT NULL,
	"base_unit_label" text DEFAULT 'unit' NOT NULL,
	"avg_cost_cents" bigint DEFAULT 0 NOT NULL,
	"min_margin_bp" integer DEFAULT 1500 NOT NULL,
	"requires_age_check" boolean DEFAULT false NOT NULL,
	"track_expiry" boolean DEFAULT true NOT NULL,
	"expiry_alert_days" integer DEFAULT 30 NOT NULL,
	"aisle_location" text DEFAULT 'A1' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"promo_type" text NOT NULL,
	"rules_json" jsonb NOT NULL,
	"priority" integer DEFAULT 10 NOT NULL,
	"combinable" boolean DEFAULT false NOT NULL,
	"min_margin_guard_bp" integer,
	"daypart_start_hour" integer,
	"daypart_end_hour" integer,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"case_qty" integer NOT NULL,
	"ordered_cases" integer NOT NULL,
	"received_cases" integer DEFAULT 0 NOT NULL,
	"unit_cost_cents" bigint NOT NULL,
	"line_total_cents" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_number" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"total_cases" integer DEFAULT 0 NOT NULL,
	"estimated_cost_cents" bigint DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	CONSTRAINT "purchase_orders_po_number_unique" UNIQUE("po_number")
);
--> statement-breakpoint
CREATE TABLE "sale_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sale_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"scanned_barcode" text NOT NULL,
	"pack_label" text NOT NULL,
	"pack_qty" integer NOT NULL,
	"qty_packs" integer NOT NULL,
	"base_units_sold" integer NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"unit_cost_cents" bigint NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"line_total_cents" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sale_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"tendered_cents" bigint,
	"change_cents" bigint
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"register_code" text NOT NULL,
	"shift_id" uuid,
	"customer_id" uuid,
	"receipt_no" text NOT NULL,
	"kind" text DEFAULT 'sale' NOT NULL,
	"original_sale_id" uuid,
	"cashier_name" text NOT NULL,
	"subtotal_cents" bigint NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint NOT NULL,
	"total_cost_cents" bigint DEFAULT 0 NOT NULL,
	"age_verified" boolean DEFAULT false NOT NULL,
	"sold_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_receipt_no_unique" UNIQUE("receipt_no")
);
--> statement-breakpoint
CREATE TABLE "shelf_tag_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"barcode" text NOT NULL,
	"old_price_cents" bigint NOT NULL,
	"new_price_cents" bigint NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"printed_by" text,
	"printed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"hypothesis" text NOT NULL,
	"intervention_type" text NOT NULL,
	"target_shift" text DEFAULT 'morning' NOT NULL,
	"control_shift" text DEFAULT 'afternoon' NOT NULL,
	"pre_start_date" date NOT NULL,
	"pre_end_date" date NOT NULL,
	"post_start_date" date NOT NULL,
	"post_end_date" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"results_json" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_rosters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_date" date NOT NULL,
	"hour" integer NOT NULL,
	"shift_bucket" text NOT NULL,
	"predicted_entries" double precision NOT NULL,
	"predicted_transactions" double precision NOT NULL,
	"recommended_lanes" integer NOT NULL,
	"assigned_staff_id" uuid,
	"assigned_cashier_name" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_baselines_product_id_unique" UNIQUE("product_id")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"batch_id" uuid,
	"qty_delta" integer NOT NULL,
	"unit_cost_cents" bigint DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"ref_id" uuid,
	"folded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_footfall" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"entries" integer NOT NULL,
	"exits" integer NOT NULL,
	"avg_dwell_sec" integer DEFAULT 360 NOT NULL,
	"open_lanes" integer DEFAULT 1 NOT NULL,
	"weather_rain" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'door_sensor' NOT NULL,
	CONSTRAINT "store_footfall_bucket_start_unique" UNIQUE("bucket_start")
);
--> statement-breakpoint
CREATE TABLE "store_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_date" date NOT NULL,
	"shift_bucket" text NOT NULL,
	"task_type" text NOT NULL,
	"priority" integer DEFAULT 2 NOT NULL,
	"title" text NOT NULL,
	"aisle_location" text,
	"product_id" uuid,
	"target_qty" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"completed_by" text,
	"completed_at" timestamp with time zone,
	"completion_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"supplier_sku" text NOT NULL,
	"case_qty" integer DEFAULT 24 NOT NULL,
	"case_cost_cents" bigint NOT NULL,
	"moq_cases" integer DEFAULT 1 NOT NULL,
	"lead_time_days" integer DEFAULT 3 NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"contact_email" text,
	"phone" text,
	"default_lead_time_days" integer DEFAULT 3 NOT NULL,
	"payment_terms_days" integer DEFAULT 14 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "targeted_coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"customer_id" uuid,
	"rfm_segment" text,
	"discount_cents" bigint NOT NULL,
	"min_basket_cents" bigint DEFAULT 0 NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"redeemed_sale_id" uuid,
	"redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "targeted_coupons_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"rate_bp" integer NOT NULL,
	"is_inclusive" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rates_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"jti" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"full_name" text NOT NULL,
	"role" text DEFAULT 'cashier' NOT NULL,
	"pin_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_proposed_actions" ADD CONSTRAINT "ai_proposed_actions_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_abc_xyz" ADD CONSTRAINT "analytics_abc_xyz_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_basket_rules" ADD CONSTRAINT "analytics_basket_rules_antecedent_product_id_products_id_fk" FOREIGN KEY ("antecedent_product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_basket_rules" ADD CONSTRAINT "analytics_basket_rules_consequent_product_id_products_id_fk" FOREIGN KEY ("consequent_product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_demand_forecasts" ADD CONSTRAINT "analytics_demand_forecasts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_dynamic_markdowns" ADD CONSTRAINT "analytics_dynamic_markdowns_batch_id_inventory_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."inventory_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_dynamic_markdowns" ADD CONSTRAINT "analytics_dynamic_markdowns_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_phantom_stock" ADD CONSTRAINT "analytics_phantom_stock_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_promo_roi" ADD CONSTRAINT "analytics_promo_roi_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_supplier_scorecards" ADD CONSTRAINT "analytics_supplier_scorecards_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grn_lines" ADD CONSTRAINT "grn_lines_grn_id_goods_receipts_id_fk" FOREIGN KEY ("grn_id") REFERENCES "public"."goods_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grn_lines" ADD CONSTRAINT "grn_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grn_variances" ADD CONSTRAINT "grn_variances_grn_id_goods_receipts_id_fk" FOREIGN KEY ("grn_id") REFERENCES "public"."goods_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grn_variances" ADD CONSTRAINT "grn_variances_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grn_variances" ADD CONSTRAINT "grn_variances_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grn_variances" ADD CONSTRAINT "grn_variances_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hourly_stock_snapshots" ADD CONSTRAINT "hourly_stock_snapshots_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "margin_alerts" ADD CONSTRAINT "margin_alerts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "margin_alerts" ADD CONSTRAINT "margin_alerts_grn_id_goods_receipts_id_fk" FOREIGN KEY ("grn_id") REFERENCES "public"."goods_receipts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_embeddings" ADD CONSTRAINT "product_embeddings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tax_rate_id_tax_rates_id_fk" FOREIGN KEY ("tax_rate_id") REFERENCES "public"."tax_rates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_shift_id_pos_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."pos_shifts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_original_sale_id_sales_id_fk" FOREIGN KEY ("original_sale_id") REFERENCES "public"."sales"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelf_tag_queue" ADD CONSTRAINT "shelf_tag_queue_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_rosters" ADD CONSTRAINT "shift_rosters_assigned_staff_id_users_id_fk" FOREIGN KEY ("assigned_staff_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_baselines" ADD CONSTRAINT "stock_baselines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batch_id_inventory_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."inventory_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_tasks" ADD CONSTRAINT "store_tasks_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targeted_coupons" ADD CONSTRAINT "targeted_coupons_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targeted_coupons" ADD CONSTRAINT "targeted_coupons_redeemed_sale_id_sales_id_fk" FOREIGN KEY ("redeemed_sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_conversations_user" ON "ai_conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_ai_messages_conv" ON "ai_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_actions_conv" ON "ai_proposed_actions" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_ai_actions_status" ON "ai_proposed_actions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_ai_actions_message" ON "ai_proposed_actions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_abc_xyz_segment" ON "analytics_abc_xyz" USING btree ("segment");--> statement-breakpoint
CREATE INDEX "idx_basket_rules_shift" ON "analytics_basket_rules" USING btree ("shift_bucket");--> statement-breakpoint
CREATE INDEX "idx_basket_rules_shift_lift" ON "analytics_basket_rules" USING btree ("shift_bucket","lift");--> statement-breakpoint
CREATE INDEX "idx_basket_rules_antecedent" ON "analytics_basket_rules" USING btree ("antecedent_product_id");--> statement-breakpoint
CREATE INDEX "idx_basket_rules_consequent" ON "analytics_basket_rules" USING btree ("consequent_product_id");--> statement-breakpoint
CREATE INDEX "idx_forecasts_urgency" ON "analytics_demand_forecasts" USING btree ("urgency");--> statement-breakpoint
CREATE INDEX "idx_dynamic_markdowns_status" ON "analytics_dynamic_markdowns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_dynamic_markdowns_product" ON "analytics_dynamic_markdowns" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "idx_lp_anomalies_risk" ON "analytics_lp_anomalies" USING btree ("risk_level");--> statement-breakpoint
CREATE INDEX "idx_phantom_stock_prob" ON "analytics_phantom_stock" USING btree ("phantom_prob");--> statement-breakpoint
CREATE INDEX "idx_pipeline_runs_finished" ON "analytics_pipeline_runs" USING btree ("finished_at");--> statement-breakpoint
CREATE INDEX "idx_promo_roi_verdict" ON "analytics_promo_roi" USING btree ("verdict");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_actor_action" ON "audit_logs" USING btree ("actor","action");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_created" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_categories_department" ON "categories" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "idx_customers_rfm" ON "customers" USING btree ("rfm_segment");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_goods_receipts_supplier_invoice" ON "goods_receipts" USING btree ("supplier_id","invoice_number");--> statement-breakpoint
CREATE INDEX "idx_goods_receipts_supplier_received" ON "goods_receipts" USING btree ("supplier_id","received_at");--> statement-breakpoint
CREATE INDEX "idx_goods_receipts_po" ON "goods_receipts" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX "idx_grn_lines_grn" ON "grn_lines" USING btree ("grn_id");--> statement-breakpoint
CREATE INDEX "idx_grn_lines_product" ON "grn_lines" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "idx_grn_variances_status_created" ON "grn_variances" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_grn_variances_supplier" ON "grn_variances" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "idx_grn_variances_grn" ON "grn_variances" USING btree ("grn_id");--> statement-breakpoint
CREATE INDEX "idx_grn_variances_po" ON "grn_variances" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX "idx_grn_variances_product" ON "grn_variances" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hourly_stock_snap" ON "hourly_stock_snapshots" USING btree ("snapshot_date","snapshot_hour","product_id");--> statement-breakpoint
CREATE INDEX "idx_hourly_stock_oos" ON "hourly_stock_snapshots" USING btree ("snapshot_date","snapshot_hour","is_oos");--> statement-breakpoint
CREATE INDEX "idx_hourly_stock_product" ON "hourly_stock_snapshots" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "idx_batches_product_expiry" ON "inventory_batches" USING btree ("product_id","best_before_date");--> statement-breakpoint
CREATE INDEX "idx_batches_expiry_status" ON "inventory_batches" USING btree ("best_before_date","status");--> statement-breakpoint
CREATE INDEX "idx_loyalty_ledger_customer" ON "loyalty_ledger" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_loyalty_ledger_sale" ON "loyalty_ledger" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "idx_margin_alerts_resolved" ON "margin_alerts" USING btree ("resolved");--> statement-breakpoint
CREATE INDEX "idx_margin_alerts_product_resolved" ON "margin_alerts" USING btree ("product_id","resolved");--> statement-breakpoint
CREATE INDEX "idx_margin_alerts_grn" ON "margin_alerts" USING btree ("grn_id");--> statement-breakpoint
CREATE INDEX "idx_pos_shifts_cashier_opened" ON "pos_shifts" USING btree ("cashier_name","opened_at");--> statement-breakpoint
CREATE INDEX "idx_pos_shifts_register_closed" ON "pos_shifts" USING btree ("register_code","closed_at");--> statement-breakpoint
CREATE INDEX "idx_product_barcodes_product" ON "product_barcodes" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "idx_products_category" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "idx_products_tax_rate" ON "products" USING btree ("tax_rate_id");--> statement-breakpoint
CREATE INDEX "idx_products_brand" ON "products" USING btree ("brand");--> statement-breakpoint
CREATE INDEX "idx_products_name" ON "products" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_products_active" ON "products" USING btree ("active");--> statement-breakpoint
CREATE INDEX "idx_promotions_active_window" ON "promotions" USING btree ("active","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "idx_po_lines_po" ON "purchase_order_lines" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX "idx_po_lines_product" ON "purchase_order_lines" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "idx_po_supplier" ON "purchase_orders" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "idx_po_status" ON "purchase_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_sale_lines_sale" ON "sale_lines" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "idx_sale_lines_product" ON "sale_lines" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "idx_sale_payments_sale" ON "sale_payments" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "idx_sales_sold_at" ON "sales" USING btree ("sold_at");--> statement-breakpoint
CREATE INDEX "idx_sales_cashier" ON "sales" USING btree ("cashier_name");--> statement-breakpoint
CREATE INDEX "idx_sales_kind" ON "sales" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "idx_sales_sold_at_kind" ON "sales" USING btree ("sold_at","kind");--> statement-breakpoint
CREATE INDEX "idx_sales_register_sold" ON "sales" USING btree ("register_code","sold_at");--> statement-breakpoint
CREATE INDEX "idx_sales_shift" ON "sales" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "idx_sales_customer" ON "sales" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_shelf_tag_status_created" ON "shelf_tag_queue" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_shelf_tag_product" ON "shelf_tag_queue" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_shift_roster_slot" ON "shift_rosters" USING btree ("plan_date","hour");--> statement-breakpoint
CREATE INDEX "idx_shift_rosters_staff" ON "shift_rosters" USING btree ("assigned_staff_id");--> statement-breakpoint
CREATE INDEX "idx_stock_movements_product_folded" ON "stock_movements" USING btree ("product_id","folded");--> statement-breakpoint
CREATE INDEX "idx_stock_movements_batch" ON "stock_movements" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "idx_stock_movements_ref" ON "stock_movements" USING btree ("ref_id");--> statement-breakpoint
CREATE INDEX "idx_stock_movements_created" ON "stock_movements" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_stock_movements_reason" ON "stock_movements" USING btree ("reason");--> statement-breakpoint
CREATE INDEX "idx_store_tasks_date_status" ON "store_tasks" USING btree ("task_date","status");--> statement-breakpoint
CREATE INDEX "idx_store_tasks_type" ON "store_tasks" USING btree ("task_type");--> statement-breakpoint
CREATE INDEX "idx_store_tasks_product" ON "store_tasks" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_supplier_product" ON "supplier_products" USING btree ("supplier_id","product_id");--> statement-breakpoint
CREATE INDEX "idx_supplier_products_product" ON "supplier_products" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "idx_targeted_coupons_customer" ON "targeted_coupons" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_targeted_coupons_rfm" ON "targeted_coupons" USING btree ("rfm_segment");--> statement-breakpoint
CREATE INDEX "idx_targeted_coupons_redeemed_sale" ON "targeted_coupons" USING btree ("redeemed_sale_id");--> statement-breakpoint
CREATE INDEX "idx_user_sessions_user_revoked" ON "user_sessions" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "idx_user_sessions_expires" ON "user_sessions" USING btree ("expires_at");