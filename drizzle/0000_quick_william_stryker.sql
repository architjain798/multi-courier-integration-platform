CREATE TYPE "public"."batch_item_status" AS ENUM('PENDING', 'SUCCEEDED', 'FAILED', 'DUPLICATE');--> statement-breakpoint
CREATE TYPE "public"."batch_status" AS ENUM('PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS');--> statement-breakpoint
CREATE TYPE "public"."payment_mode" AS ENUM('PREPAID', 'COD');--> statement-breakpoint
CREATE TYPE "public"."service_level" AS ENUM('SAME_DAY', 'NEXT_DAY', 'STANDARD');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('PENDING', 'CREATED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'UNDELIVERED', 'RTO', 'CANCELLED', 'FAILED', 'RECONCILIATION_REQUIRED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."courier_operation" AS ENUM('AUTHENTICATE', 'CREATE_SHIPMENT', 'TRACK_SHIPMENT', 'CANCEL_SHIPMENT', 'CHECK_SERVICEABILITY');--> statement-breakpoint
CREATE TABLE "bulk_batch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"order_id" text NOT NULL,
	"courier_partner" text NOT NULL,
	"status" "batch_item_status" DEFAULT 'PENDING' NOT NULL,
	"awb" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bulk_batch_items_unique_order" UNIQUE("batch_id","order_id")
);
--> statement-breakpoint
CREATE TABLE "bulk_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "batch_status" DEFAULT 'PROCESSING' NOT NULL,
	"total_count" integer NOT NULL,
	"accepted_count" integer NOT NULL,
	"rejected_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" text NOT NULL,
	"courier_partner" text NOT NULL,
	"courier_order_id" text,
	"awb" text,
	"status" "shipment_status" NOT NULL,
	"payment_mode" "payment_mode" NOT NULL,
	"service_level" "service_level" NOT NULL,
	"collectable_amount" numeric(12, 2) NOT NULL,
	"declared_value" numeric(12, 2) NOT NULL,
	"label_url" text,
	"normalized_payload" jsonb NOT NULL,
	"request_payload" jsonb,
	"response_payload" jsonb,
	"metadata" jsonb,
	"failure_code" text,
	"failure_message" text,
	"last_tracked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "tracking_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"status" "shipment_status" NOT NULL,
	"courier_status_code" text NOT NULL,
	"courier_status_description" text,
	"reason_code" text,
	"reason_description" text,
	"location" text,
	"event_time" timestamp with time zone NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracking_events_unique_scan" UNIQUE("order_id","courier_status_code","event_time")
);
--> statement-breakpoint
CREATE TABLE "courier_api_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"courier_partner" text NOT NULL,
	"operation" "courier_operation" NOT NULL,
	"reference" text,
	"request_id" text,
	"url" text NOT NULL,
	"request_body" jsonb,
	"response_status" integer NOT NULL,
	"response_body" jsonb,
	"duration_ms" integer NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bulk_batch_items" ADD CONSTRAINT "bulk_batch_items_batch_id_bulk_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."bulk_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bulk_batch_items_batch_idx" ON "bulk_batch_items" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_courier_partner_idx" ON "orders" USING btree ("courier_partner");--> statement-breakpoint
CREATE INDEX "orders_awb_idx" ON "orders" USING btree ("awb");--> statement-breakpoint
CREATE INDEX "tracking_events_order_idx" ON "tracking_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "courier_api_logs_reference_idx" ON "courier_api_logs" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "courier_api_logs_request_id_idx" ON "courier_api_logs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "courier_api_logs_created_at_idx" ON "courier_api_logs" USING btree ("created_at");