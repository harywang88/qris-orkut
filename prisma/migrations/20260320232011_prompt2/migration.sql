-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "receiptUrl" TEXT;

-- CreateTable
CREATE TABLE "WalletLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletCode" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" TEXT,
    "description" TEXT,
    "balanceAfter" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "WalletLedger_walletCode_createdAt_idx" ON "WalletLedger"("walletCode", "createdAt");
