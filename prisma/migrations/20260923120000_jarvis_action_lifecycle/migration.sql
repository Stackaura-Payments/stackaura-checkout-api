-- JARVIS owner action lifecycle: propose -> approval -> execute -> verify -> recover.
CREATE TYPE "JarvisActionStatus" AS ENUM (
  'PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'VERIFYING', 'SUCCEEDED',
  'FAILED', 'RECOVERY_REQUIRED', 'RECOVERING', 'RECOVERED', 'DENIED', 'CANCELLED', 'EXPIRED'
);

CREATE TYPE "JarvisApprovalRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

ALTER TABLE "JarvisOwnerApproval"
ADD COLUMN "actionId" TEXT;

CREATE UNIQUE INDEX "JarvisOwnerApproval_actionId_key"
ON "JarvisOwnerApproval"("actionId");

CREATE TABLE "JarvisOwnerAction" (
  "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
  "ownerId" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "toolId" TEXT NOT NULL,
  "intent" TEXT NOT NULL,
  "arguments" JSONB,
  "riskLevel" "JarvisApprovalRiskLevel" NOT NULL DEFAULT 'MEDIUM',
  "status" "JarvisActionStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
  "executionId" TEXT,
  "verification" JSONB,
  "recovery" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "JarvisOwnerAction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JarvisOwnerAction_executionId_key"
ON "JarvisOwnerAction"("executionId");

CREATE INDEX "JarvisOwnerAction_ownerId_status_idx"
ON "JarvisOwnerAction"("ownerId", "status");

CREATE INDEX "JarvisOwnerAction_ownerId_createdAt_idx"
ON "JarvisOwnerAction"("ownerId", "createdAt");

CREATE INDEX "JarvisOwnerAction_toolId_idx"
ON "JarvisOwnerAction"("toolId");

ALTER TABLE "JarvisOwnerAction"
ADD CONSTRAINT "JarvisOwnerAction_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JarvisOwnerApproval"
ADD CONSTRAINT "JarvisOwnerApproval_actionId_fkey"
FOREIGN KEY ("actionId") REFERENCES "JarvisOwnerAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "JarvisOwnerOperation"
ADD COLUMN "actionId" TEXT;

CREATE UNIQUE INDEX "JarvisOwnerOperation_actionId_key"
ON "JarvisOwnerOperation"("actionId");

ALTER TABLE "JarvisOwnerOperation"
ADD CONSTRAINT "JarvisOwnerOperation_actionId_fkey"
FOREIGN KEY ("actionId") REFERENCES "JarvisOwnerAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

