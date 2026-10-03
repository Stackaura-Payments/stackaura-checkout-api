-- CreateEnum
CREATE TYPE "JarvisApprovalStatus" AS ENUM (
    'PENDING',
    'APPROVED',
    'DENIED',
    'EXPIRED',
    'CANCELLED'
);

-- CreateTable
CREATE TABLE "JarvisApproval" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "merchantId" TEXT NOT NULL,
    "userId" TEXT,
    "decidedByUserId" TEXT,
    "executionId" TEXT,

    "toolId" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "arguments" JSONB,
    "status" "JarvisApprovalStatus" NOT NULL DEFAULT 'PENDING',

    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JarvisApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JarvisApproval_executionId_key"
ON "JarvisApproval"("executionId");

CREATE INDEX "JarvisApproval_merchantId_idx"
ON "JarvisApproval"("merchantId");

CREATE INDEX "JarvisApproval_userId_idx"
ON "JarvisApproval"("userId");

CREATE INDEX "JarvisApproval_decidedByUserId_idx"
ON "JarvisApproval"("decidedByUserId");

CREATE INDEX "JarvisApproval_status_idx"
ON "JarvisApproval"("status");

CREATE INDEX "JarvisApproval_toolId_idx"
ON "JarvisApproval"("toolId");

CREATE INDEX "JarvisApproval_requestedAt_idx"
ON "JarvisApproval"("requestedAt");

CREATE INDEX "JarvisApproval_expiresAt_idx"
ON "JarvisApproval"("expiresAt");

-- AddForeignKey
ALTER TABLE "JarvisApproval"
ADD CONSTRAINT "JarvisApproval_merchantId_fkey"
FOREIGN KEY ("merchantId")
REFERENCES "Merchant"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JarvisApproval"
ADD CONSTRAINT "JarvisApproval_userId_fkey"
FOREIGN KEY ("userId")
REFERENCES "User"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JarvisApproval"
ADD CONSTRAINT "JarvisApproval_decidedByUserId_fkey"
FOREIGN KEY ("decidedByUserId")
REFERENCES "User"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JarvisApproval"
ADD CONSTRAINT "JarvisApproval_executionId_fkey"
FOREIGN KEY ("executionId")
REFERENCES "JarvisExecution"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
