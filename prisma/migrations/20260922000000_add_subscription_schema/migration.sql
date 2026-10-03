-- CreateEnum
CREATE TYPE "SubscriptionInterval" AS ENUM (
    'DAY',
    'WEEK',
    'MONTH',
    'YEAR'
);

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM (
    'ACTIVE',
    'PAST_DUE',
    'CANCELLED'
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "merchantId" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ZAR',
    "interval" "SubscriptionInterval" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "nextBillingAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Subscription_merchantId_idx"
ON "Subscription"("merchantId");

CREATE INDEX "Subscription_status_idx"
ON "Subscription"("status");

-- AddForeignKey
ALTER TABLE "Subscription"
ADD CONSTRAINT "Subscription_merchantId_fkey"
FOREIGN KEY ("merchantId")
REFERENCES "Merchant"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
