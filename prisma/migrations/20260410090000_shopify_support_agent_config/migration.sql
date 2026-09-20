CREATE TABLE "ShopifySupportAgentConfig" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "shopDomain" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "greetingMessage" TEXT,
    "supportEmail" TEXT,
    "escalationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "escalationLabel" TEXT,
    "themePreference" TEXT NOT NULL DEFAULT 'auto',
    "positionPreference" TEXT NOT NULL DEFAULT 'bottom-right',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifySupportAgentConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopifySupportAgentConfig_shopDomain_key" ON "ShopifySupportAgentConfig"("shopDomain");
CREATE INDEX "ShopifySupportAgentConfig_shopDomain_idx" ON "ShopifySupportAgentConfig"("shopDomain");

ALTER TABLE "ShopifySupportAgentConfig"
ADD CONSTRAINT "ShopifySupportAgentConfig_shopDomain_fkey"
FOREIGN KEY ("shopDomain") REFERENCES "ShopifyInstall"("shopDomain")
ON DELETE CASCADE ON UPDATE CASCADE;
