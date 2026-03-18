ALTER TYPE "GatewayProvider" ADD VALUE 'YOCO';

ALTER TABLE "Merchant"
ADD COLUMN "yocoPublicKey" TEXT,
ADD COLUMN "yocoSecretKey" TEXT,
ADD COLUMN "yocoTestMode" BOOLEAN;
