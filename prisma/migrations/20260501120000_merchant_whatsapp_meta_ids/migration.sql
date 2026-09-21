ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "whatsappPhoneNumberId" TEXT;
ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "whatsappWabaId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Merchant_whatsappPhoneNumberId_key" ON "Merchant"("whatsappPhoneNumberId");
CREATE INDEX IF NOT EXISTS "Merchant_whatsappWabaId_idx" ON "Merchant"("whatsappWabaId");
