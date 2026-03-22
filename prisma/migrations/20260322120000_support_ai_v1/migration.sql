CREATE TYPE "SupportConversationStatus" AS ENUM ('OPEN', 'ESCALATED', 'CLOSED');

CREATE TYPE "SupportMessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

CREATE TYPE "SupportEscalationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE "SupportConversation" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "merchantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "status" "SupportConversationStatus" NOT NULL DEFAULT 'OPEN',
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "escalatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "conversationId" TEXT NOT NULL,
    "role" "SupportMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "citations" JSONB,
    "contextSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SupportEscalation" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "conversationId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "emailTo" TEXT NOT NULL DEFAULT 'wesupport@stackaura.co.za',
    "status" "SupportEscalationStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportEscalation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupportConversation_merchantId_lastMessageAt_idx" ON "SupportConversation"("merchantId", "lastMessageAt" DESC);
CREATE INDEX "SupportConversation_userId_lastMessageAt_idx" ON "SupportConversation"("userId", "lastMessageAt" DESC);
CREATE INDEX "SupportConversation_status_idx" ON "SupportConversation"("status");

CREATE INDEX "SupportMessage_conversationId_createdAt_idx" ON "SupportMessage"("conversationId", "createdAt");

CREATE INDEX "SupportEscalation_conversationId_createdAt_idx" ON "SupportEscalation"("conversationId", "createdAt" DESC);
CREATE INDEX "SupportEscalation_merchantId_createdAt_idx" ON "SupportEscalation"("merchantId", "createdAt" DESC);
CREATE INDEX "SupportEscalation_status_idx" ON "SupportEscalation"("status");

ALTER TABLE "SupportConversation"
ADD CONSTRAINT "SupportConversation_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportConversation"
ADD CONSTRAINT "SupportConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportMessage"
ADD CONSTRAINT "SupportMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SupportConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportEscalation"
ADD CONSTRAINT "SupportEscalation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SupportConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportEscalation"
ADD CONSTRAINT "SupportEscalation_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportEscalation"
ADD CONSTRAINT "SupportEscalation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
