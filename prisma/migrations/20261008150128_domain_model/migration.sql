-- CreateEnum
CREATE TYPE "exchange_provider" AS ENUM ('MOCK', 'CHANGENOW');

-- CreateEnum
CREATE TYPE "exchange_status" AS ENUM ('DRAFT', 'QUOTED', 'AWAITING_CONFIRMATION', 'CREATING', 'WAITING_DEPOSIT', 'CONFIRMING', 'EXCHANGING', 'SENDING', 'FINISHED', 'FAILED', 'REFUNDED', 'VERIFYING', 'EXPIRED');

-- CreateEnum
CREATE TYPE "rate_type" AS ENUM ('FIXED', 'FLOATING');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "telegram_id" BIGINT NOT NULL,
    "username" TEXT,
    "first_name" TEXT,
    "language_code" TEXT,
    "bot_blocked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchanges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "exchange_provider" NOT NULL,
    "provider_exchange_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "from_currency" TEXT NOT NULL,
    "from_network" TEXT NOT NULL,
    "to_currency" TEXT NOT NULL,
    "to_network" TEXT NOT NULL,
    "expected_from_amount" DECIMAL(50,24) NOT NULL,
    "expected_to_amount" DECIMAL(50,24),
    "actual_from_amount" DECIMAL(50,24),
    "actual_to_amount" DECIMAL(50,24),
    "payin_address" TEXT,
    "payin_extra_id" TEXT,
    "payout_address" TEXT,
    "payout_extra_id" TEXT,
    "refund_address" TEXT,
    "refund_extra_id" TEXT,
    "rate_type" "rate_type" NOT NULL,
    "provider_rate_id" TEXT,
    "quote_expires_at" TIMESTAMPTZ(3),
    "status" "exchange_status" NOT NULL DEFAULT 'DRAFT',
    "provider_status" TEXT,
    "status_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_check_at" TIMESTAMPTZ(3),
    "last_checked_at" TIMESTAMPTZ(3),
    "check_failure_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "exchanges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_status_history" (
    "id" UUID NOT NULL,
    "exchange_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "from_status" "exchange_status",
    "to_status" "exchange_status" NOT NULL,
    "provider_status" TEXT,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "exchange_id" UUID,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "status" "notification_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_id_key" ON "users"("telegram_id");

-- CreateIndex
CREATE UNIQUE INDEX "exchanges_idempotency_key_key" ON "exchanges"("idempotency_key");

-- CreateIndex
CREATE INDEX "exchanges_user_id_created_at_idx" ON "exchanges"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "exchanges_user_id_status_idx" ON "exchanges"("user_id", "status");

-- CreateIndex
CREATE INDEX "exchanges_status_next_check_at_idx" ON "exchanges"("status", "next_check_at");

-- CreateIndex
CREATE UNIQUE INDEX "exchanges_provider_provider_exchange_id_key" ON "exchanges"("provider", "provider_exchange_id");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_status_history_exchange_id_sequence_key" ON "exchange_status_history"("exchange_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "notification_outbox_dedupe_key_key" ON "notification_outbox"("dedupe_key");

-- CreateIndex
CREATE INDEX "notification_outbox_status_next_attempt_at_idx" ON "notification_outbox"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "notification_outbox_status_locked_at_idx" ON "notification_outbox"("status", "locked_at");

-- CreateIndex
CREATE INDEX "notification_outbox_user_id_idx" ON "notification_outbox"("user_id");

-- CreateIndex
CREATE INDEX "notification_outbox_exchange_id_idx" ON "notification_outbox"("exchange_id");

-- AddForeignKey
ALTER TABLE "exchanges" ADD CONSTRAINT "exchanges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_status_history" ADD CONSTRAINT "exchange_status_history_exchange_id_fkey" FOREIGN KEY ("exchange_id") REFERENCES "exchanges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_exchange_id_fkey" FOREIGN KEY ("exchange_id") REFERENCES "exchanges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- РУЧНОЙ SQL (не генерируется Prisma, Prisma о нём не знает).
-- CHECK-ограничения и триггеры ниже нужно сохранять при любом пересоздании
-- миграций. Покрыты тестами tests/db/schema-constraints.test.ts.
-- Терминальные статусы: FINISHED, FAILED, REFUNDED, EXPIRED.
-- ===========================================================================

-- users ----------------------------------------------------------------------
ALTER TABLE "users"
  ADD CONSTRAINT "users_telegram_id_positive_check" CHECK ("telegram_id" > 0);

-- exchanges: суммы и непустые строки -----------------------------------------
ALTER TABLE "exchanges"
  ADD CONSTRAINT "exchanges_amounts_check" CHECK (
    "expected_from_amount" > 0
    AND ("expected_to_amount" IS NULL OR "expected_to_amount" > 0)
    AND ("actual_from_amount" IS NULL OR "actual_from_amount" > 0)
    AND ("actual_to_amount" IS NULL OR "actual_to_amount" > 0)
  ),
  ADD CONSTRAINT "exchanges_required_text_check" CHECK (
    "idempotency_key" <> ''
    AND "from_currency" <> ''
    AND "from_network" <> ''
    AND "to_currency" <> ''
    AND "to_network" <> ''
  ),
  -- NULL означает «значения нет», пустая строка запрещена.
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
  ),
  ADD CONSTRAINT "exchanges_check_failure_count_check" CHECK ("check_failure_count" >= 0);

-- exchanges: инвариант nextCheckAt -------------------------------------------
-- nextCheckAt IS NULL тогда и только тогда, когда статус терминальный.
ALTER TABLE "exchanges"
  ADD CONSTRAINT "exchanges_next_check_at_check" CHECK (
    ("status" IN ('FINISHED', 'FAILED', 'REFUNDED', 'EXPIRED')) = ("next_check_at" IS NULL)
  );

-- exchanges: обязательные поля по стадиям ------------------------------------
-- providerExchangeId: появляется вместе с WAITING_DEPOSIT; у обмена, который
-- не дошёл до провайдера (DRAFT..CREATING, EXPIRED), его быть не может.
-- FAILED допускает оба варианта (сбой на создании или позднее).
ALTER TABLE "exchanges"
  ADD CONSTRAINT "exchanges_provider_exchange_id_stage_check" CHECK (
    CASE
      WHEN "status" IN ('DRAFT', 'QUOTED', 'AWAITING_CONFIRMATION', 'CREATING', 'EXPIRED')
        THEN "provider_exchange_id" IS NULL
      WHEN "status" IN ('WAITING_DEPOSIT', 'CONFIRMING', 'EXCHANGING', 'SENDING', 'VERIFYING', 'FINISHED', 'REFUNDED')
        THEN "provider_exchange_id" IS NOT NULL
      ELSE TRUE
    END
  ),
  -- Котировка обязательна после QUOTED (EXPIRED возможен и до котировки).
  ADD CONSTRAINT "exchanges_quote_stage_check" CHECK (
    "status" IN ('DRAFT', 'EXPIRED')
    OR (
      "expected_to_amount" IS NOT NULL
      AND "quote_expires_at" IS NOT NULL
      AND ("rate_type" <> 'FIXED' OR "provider_rate_id" IS NOT NULL)
    )
  ),
  -- providerRateId имеет смысл только для FIXED.
  ADD CONSTRAINT "exchanges_provider_rate_id_fixed_check" CHECK (
    "provider_rate_id" IS NULL OR "rate_type" = 'FIXED'
  ),
  -- Адрес получения обязателен с AWAITING_CONFIRMATION.
  ADD CONSTRAINT "exchanges_payout_stage_check" CHECK (
    "status" IN ('DRAFT', 'QUOTED', 'EXPIRED') OR "payout_address" IS NOT NULL
  ),
  -- Адрес депозита и статус провайдера выдаёт провайдер с WAITING_DEPOSIT.
  ADD CONSTRAINT "exchanges_deposit_stage_check" CHECK (
    "status" NOT IN ('WAITING_DEPOSIT', 'CONFIRMING', 'EXCHANGING', 'SENDING', 'VERIFYING', 'FINISHED', 'REFUNDED')
    OR ("payin_address" IS NOT NULL AND "provider_status" IS NOT NULL)
  ),
  -- Итоговые суммы обязательны для успешно завершённого обмена.
  ADD CONSTRAINT "exchanges_finished_stage_check" CHECK (
    "status" <> 'FINISHED'
    OR ("actual_from_amount" IS NOT NULL AND "actual_to_amount" IS NOT NULL)
  );

-- exchange_status_history ----------------------------------------------------
ALTER TABLE "exchange_status_history"
  ADD CONSTRAINT "exchange_status_history_sequence_check" CHECK ("sequence" >= 1),
  -- fromStatus IS NULL только у первой записи (создание обмена).
  ADD CONSTRAINT "exchange_status_history_first_row_check" CHECK (
    ("from_status" IS NULL) = ("sequence" = 1)
  ),
  ADD CONSTRAINT "exchange_status_history_no_self_transition_check" CHECK (
    "from_status" IS NULL OR "from_status" <> "to_status"
  ),
  ADD CONSTRAINT "exchange_status_history_text_check" CHECK (
    "reason" <> '' AND ("provider_status" IS NULL OR "provider_status" <> '')
  );

-- История неизменяема: запрещены UPDATE, DELETE и TRUNCATE.
CREATE FUNCTION "exchange_status_history_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'exchange_status_history is append-only: % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER "exchange_status_history_no_update_delete"
  BEFORE UPDATE OR DELETE ON "exchange_status_history"
  FOR EACH ROW EXECUTE FUNCTION "exchange_status_history_immutable"();

CREATE TRIGGER "exchange_status_history_no_truncate"
  BEFORE TRUNCATE ON "exchange_status_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "exchange_status_history_immutable"();

-- notification_outbox --------------------------------------------------------
ALTER TABLE "notification_outbox"
  ADD CONSTRAINT "notification_outbox_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "notification_outbox_text_check" CHECK (
    "type" <> '' AND "dedupe_key" <> '' AND ("last_error" IS NULL OR "last_error" <> '')
  ),
  ADD CONSTRAINT "notification_outbox_sent_check" CHECK (
    "status" <> 'SENT' OR "sent_at" IS NOT NULL
  ),
  ADD CONSTRAINT "notification_outbox_processing_check" CHECK (
    "status" <> 'PROCESSING' OR "locked_at" IS NOT NULL
  );
