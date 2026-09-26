CREATE TYPE "JarvisRepairStatus" AS ENUM (
  'PENDING_APPROVAL',
  'APPROVED',
  'BRANCHING',
  'APPLYING_FIX',
  'VERIFYING_CI',
  'READY_TO_DEPLOY',
  'DEPLOYING',
  'VERIFYING_DEPLOYMENT',
  'SUCCEEDED',
  'FAILED',
  'RECOVERY_REQUIRED',
  'DENIED'
);

CREATE TABLE "JarvisEngineeringRepair" (
  "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
  "ownerId" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "actionId" TEXT,
  "repository" TEXT NOT NULL,
  "baseCommit" TEXT NOT NULL,
  "previousKnownGoodCommit" TEXT,
  "branchName" TEXT NOT NULL,
  "currentCommitSha" TEXT,
  "status" "JarvisRepairStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
  "diagnosis" JSONB,
  "plan" JSONB NOT NULL,
  "ciVerification" JSONB,
  "deployment" JSONB,
  "verification" JSONB,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "JarvisEngineeringRepair_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JarvisEngineeringRepair_actionId_key"
ON "JarvisEngineeringRepair"("actionId");

CREATE INDEX "JarvisEngineeringRepair_ownerId_status_idx"
ON "JarvisEngineeringRepair"("ownerId", "status");

CREATE INDEX "JarvisEngineeringRepair_ownerId_createdAt_idx"
ON "JarvisEngineeringRepair"("ownerId", "createdAt");

CREATE INDEX "JarvisEngineeringRepair_repository_idx"
ON "JarvisEngineeringRepair"("repository");

CREATE INDEX "JarvisEngineeringRepair_baseCommit_idx"
ON "JarvisEngineeringRepair"("baseCommit");

ALTER TABLE "JarvisEngineeringRepair"
ADD CONSTRAINT "JarvisEngineeringRepair_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
