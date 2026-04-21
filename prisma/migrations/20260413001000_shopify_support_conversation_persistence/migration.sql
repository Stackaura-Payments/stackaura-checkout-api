CREATE TYPE "ShopifySupportMessageRole" AS ENUM ('USER', 'ASSISTANT');

CREATE TABLE "ShopifySupportConversation" (
  "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
  "shopDomain" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUserMessage" TEXT,
  "lastAssistantMessage" TEXT,
  "escalationOffered" BOOLEAN NOT NULL DEFAULT false,
  "supportEmailShown" BOOLEAN NOT NULL DEFAULT false,

  CONSTRAINT "ShopifySupportConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShopifySupportConversationMessage" (
  "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
  "conversationId" TEXT NOT NULL,
  "role" "ShopifySupportMessageRole" NOT NULL,
  "message" TEXT NOT NULL,
  "pageUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ShopifySupportConversationMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopifySupportConversation_shopDomain_sessionId_key"
ON "ShopifySupportConversation"("shopDomain", "sessionId");

CREATE INDEX "ShopifySupportConversation_shopDomain_lastMessageAt_idx"
ON "ShopifySupportConversation"("shopDomain", "lastMessageAt" DESC);

CREATE INDEX "ShopifySupportConversationMessage_conversationId_createdAt_idx"
ON "ShopifySupportConversationMessage"("conversationId", "createdAt");

ALTER TABLE "ShopifySupportConversation"
ADD CONSTRAINT "ShopifySupportConversation_shopDomain_fkey"
FOREIGN KEY ("shopDomain") REFERENCES "ShopifyInstall"("shopDomain") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShopifySupportConversationMessage"
ADD CONSTRAINT "ShopifySupportConversationMessage_conversationId_fkey"
FOREIGN KEY ("conversationId") REFERENCES "ShopifySupportConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
