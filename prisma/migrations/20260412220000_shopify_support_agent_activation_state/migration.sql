ALTER TABLE "ShopifySupportAgentConfig"
ADD COLUMN "storefrontWidgetActivatedAt" TIMESTAMP(3),
ADD COLUMN "storefrontWidgetLastSeenAt" TIMESTAMP(3),
ADD COLUMN "storefrontWidgetActivationSource" TEXT,
ADD COLUMN "storefrontWidgetLastPageUrl" TEXT;
