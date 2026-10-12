-- Хэши транзакций провайдера. NULL, пока провайдер их не прислал.
ALTER TABLE "exchanges"
  ADD COLUMN "payin_hash" TEXT,
  ADD COLUMN "payout_hash" TEXT,
  ADD COLUMN "refund_hash" TEXT;

-- Пустая строка по-прежнему запрещена. CHECK пересоздаётся целиком:
-- в уже существующее ограничение столбец не добавляется.
ALTER TABLE "exchanges" DROP CONSTRAINT "exchanges_optional_text_check";

ALTER TABLE "exchanges"
  ADD CONSTRAINT "exchanges_optional_text_check" CHECK (
    ("provider_exchange_id" IS NULL OR "provider_exchange_id" <> '')
    AND ("provider_rate_id" IS NULL OR "provider_rate_id" <> '')
    AND ("provider_status" IS NULL OR "provider_status" <> '')
    AND ("payin_address" IS NULL OR "payin_address" <> '')
    AND ("payin_extra_id" IS NULL OR "payin_extra_id" <> '')
    AND ("payout_address" IS NULL OR "payout_address" <> '')
    AND ("payout_extra_id" IS NULL OR "payout_extra_id" <> '')
    AND ("refund_address" IS NULL OR "refund_address" <> '')
    AND ("refund_extra_id" IS NULL OR "refund_extra_id" <> '')
    AND ("payin_hash" IS NULL OR "payin_hash" <> '')
    AND ("payout_hash" IS NULL OR "payout_hash" <> '')
    AND ("refund_hash" IS NULL OR "refund_hash" <> '')
  );
