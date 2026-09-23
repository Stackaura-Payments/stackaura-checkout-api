ALTER TABLE "JarvisEngineeringRepair"
ADD COLUMN "executionLeaseId" TEXT,
ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "lastHeartbeatAt" TIMESTAMP(3),
ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "JarvisEngineeringRepair_status_leaseExpiresAt_idx"
ON "JarvisEngineeringRepair"("status", "leaseExpiresAt");

CREATE INDEX "JarvisEngineeringRepair_executionLeaseId_idx"
ON "JarvisEngineeringRepair"("executionLeaseId");
