CREATE TYPE "JarvisOwnerOperationStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED', 'DENIED');

CREATE TABLE "JarvisOwnerOperation" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "ownerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "status" "JarvisOwnerOperationStatus" NOT NULL DEFAULT 'STARTED',
    "request" JSONB,
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JarvisOwnerOperation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "JarvisOwnerOperation_ownerId_idx" ON "JarvisOwnerOperation"("ownerId");
CREATE INDEX "JarvisOwnerOperation_userId_idx" ON "JarvisOwnerOperation"("userId");
CREATE INDEX "JarvisOwnerOperation_toolId_idx" ON "JarvisOwnerOperation"("toolId");
CREATE INDEX "JarvisOwnerOperation_agent_idx" ON "JarvisOwnerOperation"("agent");
CREATE INDEX "JarvisOwnerOperation_status_idx" ON "JarvisOwnerOperation"("status");
CREATE INDEX "JarvisOwnerOperation_createdAt_idx" ON "JarvisOwnerOperation"("createdAt");

ALTER TABLE "JarvisOwnerOperation"
ADD CONSTRAINT "JarvisOwnerOperation_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
