ALTER TABLE "tenants" ADD COLUMN "open_weekdays" integer[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6]::integer[];
