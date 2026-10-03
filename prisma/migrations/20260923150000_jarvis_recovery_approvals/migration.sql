ALTER TABLE "JarvisOwnerApproval" ADD COLUMN "recoveryActionId" TEXT;

CREATE INDEX "JarvisOwnerApproval_recoveryActionId_idx" ON "JarvisOwnerApproval"("recoveryActionId");

ALTER TABLE "JarvisOwnerApproval" ADD CONSTRAINT "JarvisOwnerApproval_recoveryActionId_fkey" FOREIGN KEY ("recoveryActionId") REFERENCES "JarvisOwnerAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
