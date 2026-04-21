CREATE TABLE "ShopifyInstall" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "shopDomain" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "scope" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyInstall_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopifyInstall_shopDomain_key" ON "ShopifyInstall"("shopDomain");
CREATE INDEX "ShopifyInstall_shopDomain_idx" ON "ShopifyInstall"("shopDomain");
