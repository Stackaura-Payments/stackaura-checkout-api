-- CreateEnum
CREATE TYPE "JarvisExecutionStatus" AS ENUM (
    'STARTED',
    'SUCCEEDED',
    'FAILED',
    'DENIED'
);

-- CreateTable
CREATE TABLE "JarvisExecution" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "merchantId" TEXT NOT NULL,
    "userId" TEXT,
    "agent" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "status" "JarvisExecutionStatus" NOT NULL DEFAULT 'STARTED',
    "request" JSONB,
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JarvisExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JarvisExecution_merchantId_idx"
ON "JarvisExecution"("merchantId");

-- CreateIndex
CREATE INDEX "JarvisExecution_userId_idx"
ON "JarvisExecution"("userId");

-- CreateIndex
CREATE INDEX "JarvisExecution_toolId_idx"
ON "JarvisExecution"("toolId");

-- CreateIndex
CREATE INDEX "JarvisExecution_agent_idx"
ON "JarvisExecution"("agent");

-- CreateIndex
CREATE INDEX "JarvisExecution_status_idx"
ON "JarvisExecution"("status");

-- CreateIndex
CREATE INDEX "JarvisExecution_createdAt_idx"
ON "JarvisExecution"("createdAt");

-- AddForeignKey
ALTER TABLE "JarvisExecution"
ADD CONSTRAINT "JarvisExecution_merchantId_fkey"
FOREIGN KEY ("merchantId")
REFERENCES "Merchant"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JarvisExecution"
ADD CONSTRAINT "JarvisExecution_userId_fkey"
FOREIGN KEY ("userId")
REFERENCES "User"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
