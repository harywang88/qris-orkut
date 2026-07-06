ALTER TABLE "QrisAccount" ADD COLUMN "orkutAccountIndex" INTEGER;
ALTER TABLE "QrisAccount" ADD COLUMN "lastMainBalance" INTEGER;
ALTER TABLE "QrisAccount" ADD COLUMN "lastQrisBalance" INTEGER;
ALTER TABLE "QrisAccount" ADD COLUMN "lastMaderaBalance" INTEGER;
ALTER TABLE "QrisAccount" ADD COLUMN "lastBalanceSyncAt" DATETIME;
ALTER TABLE "QrisAccount" ADD COLUMN "lastBalanceSyncStatus" TEXT;
ALTER TABLE "QrisAccount" ADD COLUMN "lastBalanceSyncError" TEXT;
ALTER TABLE "QrisAccount" ADD COLUMN "lastBalanceSyncRawJson" TEXT;

ALTER TABLE "Mutation" ADD COLUMN "walletCategory" TEXT;
