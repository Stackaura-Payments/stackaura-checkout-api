ALTER TYPE "GatewayProvider" ADD VALUE IF NOT EXISTS 'PAYSTACK';

ALTER TABLE "Merchant"
ADD COLUMN "paystackSecretKey" TEXT,
ADD COLUMN "paystackTestMode" BOOLEAN;
