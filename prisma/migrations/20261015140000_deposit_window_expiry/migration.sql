-- EXPIRED после выдачи кошелька хранит id провайдера.
-- До провайдера (черновик, котировка) id по-прежнему пуст.
-- Если id есть, вместе с ним обязательны адрес депозита и статус провайдера.
ALTER TABLE "exchanges" DROP CONSTRAINT "exchanges_provider_exchange_id_stage_check";

ALTER TABLE "exchanges"
  ADD CONSTRAINT "exchanges_provider_exchange_id_stage_check" CHECK (
    CASE
      WHEN "status" IN ('DRAFT', 'QUOTED', 'AWAITING_CONFIRMATION', 'CREATING')
        THEN "provider_exchange_id" IS NULL
      WHEN "status" IN (
        'WAITING_DEPOSIT',
        'CONFIRMING',
        'EXCHANGING',
        'SENDING',
        'VERIFYING',
        'FINISHED',
        'REFUNDED'
      )
        THEN "provider_exchange_id" IS NOT NULL
      WHEN "status" = 'EXPIRED'
        THEN "provider_exchange_id" IS NULL
          OR ("payin_address" IS NOT NULL AND "provider_status" IS NOT NULL)
      ELSE TRUE
    END
  );

-- Матрица переходов. Должна совпадать с ALLOWED_TRANSITIONS
-- в src/domain/exchanges/status-transitions.ts.
CREATE FUNCTION "exchanges_status_transition_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IS NOT DISTINCT FROM NEW."status" THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" IN ('QUOTED', 'EXPIRED'))
    OR (OLD."status" = 'QUOTED' AND NEW."status" IN ('AWAITING_CONFIRMATION', 'EXPIRED'))
    OR (OLD."status" = 'AWAITING_CONFIRMATION' AND NEW."status" IN ('CREATING', 'EXPIRED'))
    OR (OLD."status" = 'CREATING' AND NEW."status" IN ('WAITING_DEPOSIT', 'FAILED'))
    OR (
      OLD."status" = 'WAITING_DEPOSIT'
      AND NEW."status" IN (
        'CONFIRMING',
        'EXCHANGING',
        'SENDING',
        'FINISHED',
        'VERIFYING',
        'FAILED',
        'REFUNDED',
        'EXPIRED'
      )
    )
    OR (
      OLD."status" = 'CONFIRMING'
      AND NEW."status" IN (
        'EXCHANGING',
        'SENDING',
        'FINISHED',
        'VERIFYING',
        'FAILED',
        'REFUNDED',
        'EXPIRED'
      )
    )
    OR (
      OLD."status" = 'EXCHANGING'
      AND NEW."status" IN ('SENDING', 'FINISHED', 'VERIFYING', 'FAILED', 'REFUNDED', 'EXPIRED')
    )
    OR (
      OLD."status" = 'VERIFYING'
      AND NEW."status" IN (
        'CONFIRMING',
        'EXCHANGING',
        'SENDING',
        'FINISHED',
        'FAILED',
        'REFUNDED',
        'EXPIRED'
      )
    )
    OR (OLD."status" = 'SENDING' AND NEW."status" IN ('FINISHED', 'FAILED', 'EXPIRED'))
  ) THEN
    RAISE EXCEPTION 'invalid exchange status transition: % -> %', OLD."status", NEW."status";
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "exchanges_status_transition"
  BEFORE UPDATE OF "status" ON "exchanges"
  FOR EACH ROW EXECUTE FUNCTION "exchanges_status_transition_guard"();
