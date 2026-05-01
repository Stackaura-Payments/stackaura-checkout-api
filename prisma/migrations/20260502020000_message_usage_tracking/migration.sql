CREATE TABLE IF NOT EXISTS "MessageUsage" (
  "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
  "merchantId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "messageId" TEXT,
  "waId" TEXT,
  "replySource" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MessageUsage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MessageUsage_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "MessageUsage_merchantId_idx" ON "MessageUsage"("merchantId");
CREATE INDEX IF NOT EXISTS "MessageUsage_channel_idx" ON "MessageUsage"("channel");
CREATE INDEX IF NOT EXISTS "MessageUsage_direction_idx" ON "MessageUsage"("direction");
CREATE INDEX IF NOT EXISTS "MessageUsage_createdAt_idx" ON "MessageUsage"("createdAt");
