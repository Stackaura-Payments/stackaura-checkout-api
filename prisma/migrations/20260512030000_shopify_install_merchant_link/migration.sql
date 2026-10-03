-- Add merchant linkage to Shopify installations.
ALTER TABLE "ShopifyInstall"
ADD COLUMN "merchantId" TEXT;

-- Index merchant lookups.
CREATE INDEX "ShopifyInstall_merchantId_idx"
ON "ShopifyInstall"("merchantId");

-- Link Shopify installations to merchants.
ALTER TABLE "ShopifyInstall"
ADD CONSTRAINT "ShopifyInstall_merchantId_fkey"
FOREIGN KEY ("merchantId")
REFERENCES "Merchant"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
