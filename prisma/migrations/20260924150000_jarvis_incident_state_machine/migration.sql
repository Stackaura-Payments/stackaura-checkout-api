ALTER TYPE "JarvisRepairStatus" ADD VALUE 'INCIDENT_DETECTED' BEFORE 'PENDING_APPROVAL';
ALTER TYPE "JarvisRepairStatus" ADD VALUE 'DIAGNOSING' AFTER 'INCIDENT_DETECTED';
ALTER TYPE "JarvisRepairStatus" ADD VALUE 'DIAGNOSED' AFTER 'DIAGNOSING';

ALTER TABLE "JarvisEngineeringRepair"
  ADD COLUMN "stateHistory" JSONB,
  ADD COLUMN "failureSignature" TEXT,
  ADD COLUMN "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "JarvisEngineeringRepair_failureSignature_idx" ON "JarvisEngineeringRepair"("failureSignature");
