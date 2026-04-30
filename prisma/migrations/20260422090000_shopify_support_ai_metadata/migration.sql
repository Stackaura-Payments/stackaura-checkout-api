ALTER TABLE "ShopifySupportAgentConfig"
ADD COLUMN "shippingInfo" TEXT,
ADD COLUMN "returnsPolicy" TEXT,
ADD COLUMN "paymentMethodsEnabled" TEXT,
ADD COLUMN "storeHelpSummary" TEXT;

ALTER TABLE "ShopifySupportConversationMessage"
ADD COLUMN "metadata" JSONB;
