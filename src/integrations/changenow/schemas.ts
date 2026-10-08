/**
 * Схемы ответов ChangeNOW API v2.
 *
 * Суммы к этому моменту уже строки (см. decimal-json.ts), не number.
 * Лишние поля отбрасываются: в домен попадает только то, что описано здесь.
 */
import { z } from 'zod';

export const changeNowCurrencySchema = z.object({
  ticker: z.string(),
  name: z.string(),
  network: z.string(),
  hasExternalId: z.boolean(),
  isExtraIdSupported: z.boolean(),
  isFiat: z.boolean(),
  featured: z.boolean(),
  supportsFixedRate: z.boolean(),
});

export const changeNowQuoteSchema = z.object({
  fromAmount: z.string().min(1),
  toAmount: z.string().min(1),
  rateId: z.string().nullable(),
  validUntil: z.string().nullable(),
});

export const changeNowCreatedExchangeSchema = z.object({
  id: z.string().min(1),
  payinAddress: z.string().min(1),
  payinExtraId: z.string().nullable().optional(),
  fromAmount: z.string().min(1),
  toAmount: z.string().min(1),
});

export const changeNowExchangeStatusSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  amountFrom: z.string().nullable().optional(),
  amountTo: z.string().nullable().optional(),
});

export const changeNowErrorSchema = z.object({
  error: z.string().min(1),
  message: z.string().optional(),
});

export type ChangeNowCurrency = z.infer<typeof changeNowCurrencySchema>;
export type ChangeNowQuote = z.infer<typeof changeNowQuoteSchema>;
export type ChangeNowCreatedExchange = z.infer<typeof changeNowCreatedExchangeSchema>;
export type ChangeNowExchangeStatus = z.infer<typeof changeNowExchangeStatusSchema>;
