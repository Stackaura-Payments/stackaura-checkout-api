-- JARVIS owner-only approval boundary.
CREATE TABLE "JarvisOwnerApproval" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "ownerId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "decidedByUserId" TEXT,
    "executionId" TEXT,

    "toolId" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "arguments" JSONB,
    "riskLevel" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" "JarvisApprovalStatus" NOT NULL DEFAULT 'PENDING',

    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JarvisOwnerApproval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JarvisOwnerApproval_executionId_key"
ON "JarvisOwnerApproval"("executionId");

CREATE INDEX "JarvisOwnerApproval_ownerId_idx"
ON "JarvisOwnerApproval"("ownerId");

CREATE INDEX "JarvisOwnerApproval_requestedByUserId_idx"
ON "JarvisOwnerApproval"("requestedByUserId");

CREATE INDEX "JarvisOwnerApproval_decidedByUserId_idx"
ON "JarvisOwnerApproval"("decidedByUserId");

CREATE INDEX "JarvisOwnerApproval_status_idx"
ON "JarvisOwnerApproval"("status");

CREATE INDEX "JarvisOwnerApproval_requestedAt_idx"
ON "JarvisOwnerApproval"("requestedAt");

CREATE INDEX "JarvisOwnerApproval_expiresAt_idx"
ON "JarvisOwnerApproval"("expiresAt");

ALTER TABLE "JarvisOwnerApproval"
ADD CONSTRAINT "JarvisOwnerApproval_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JarvisOwnerApproval"
ADD CONSTRAINT "JarvisOwnerApproval_requestedByUserId_fkey"
FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JarvisOwnerApproval"
ADD CONSTRAINT "JarvisOwnerApproval_decidedByUserId_fkey"
FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "JarvisOwnerApproval"
ADD CONSTRAINT "JarvisOwnerApproval_executionId_fkey"
FOREIGN KEY ("executionId") REFERENCES "JarvisOwnerOperation"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
