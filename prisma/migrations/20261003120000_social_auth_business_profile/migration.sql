ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

CREATE TABLE "ExternalIdentity" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExternalIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExternalIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ExternalIdentity_provider_subject_key" ON "ExternalIdentity"("provider", "subject");
CREATE UNIQUE INDEX "ExternalIdentity_provider_userId_key" ON "ExternalIdentity"("provider", "userId");

CREATE TABLE "OAuthAttempt" (
  "stateHash" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "bindingHash" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "verifier" TEXT NOT NULL,
  "nextPath" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OAuthAttempt_pkey" PRIMARY KEY ("stateHash")
);
CREATE INDEX "OAuthAttempt_expiresAt_idx" ON "OAuthAttempt"("expiresAt");

CREATE TABLE "BusinessVerification" (
  "merchantId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "legalName" TEXT NOT NULL,
  "registrationNumber" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "businessAddress" TEXT NOT NULL,
  "businessActivity" TEXT NOT NULL,
  "representativeName" TEXT NOT NULL,
  "submittedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BusinessVerification_pkey" PRIMARY KEY ("merchantId"),
  CONSTRAINT "BusinessVerification_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BusinessVerification_status_check" CHECK ("status" IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'VERIFIED', 'ACTION_REQUIRED'))
);
