/**
 * MockPrivateTransferProvider: перевод одной монеты в памяти для тестов.
 *
 * Сети нет, ключей нет. Пользователь задаёт сумму получения, мок возвращает
 * сумму отправки десятичной строкой. Неизвестная валюта не поддерживается.
 * Статусами управляют тесты через advanceStatus и setProviderStatus.
 */
import { randomUUID } from 'node:crypto';
import {
  compareDecimal,
  formatDecimal,
  multiplyDecimal,
  parseDecimal,
} from '../../domain/shared/decimal-string.js';
import {
  ExchangeProviderError,
  type ProviderCallOptions,
  type ProviderCurrency,
  type ProviderExchangeStatus,
  type ProviderExchangeStatusName,
} from '../../domain/exchanges/exchange-provider.js';
import type {
  CreatePrivateTransferRequest,
  PrivateTransfer,
  PrivateTransferEstimate,
  PrivateTransferEstimateRequest,
  PrivateTransferProvider,
} from '../../domain/exchanges/private-transfer-provider.js';
import { DEFAULT_MOCK_CURRENCIES } from './mock-exchange-provider.js';

const RAW_STATUS_TO_INTERNAL: Readonly<Record<string, ProviderExchangeStatusName>> = {
  waiting: 'WAITING_DEPOSIT',
  confirming: 'CONFIRMING',
  exchanging: 'EXCHANGING',
  sending: 'SENDING',
  verifying: 'VERIFYING',
  finished: 'FINISHED',
  failed: 'FAILED',
  refunded: 'REFUNDED',
};

const HAPPY_PATH = ['waiting', 'confirming', 'exchanging', 'sending', 'finished'] as const;

export interface MockPrivateTransferProviderOptions {
  readonly currencies?: readonly ProviderCurrency[];
  /** Множитель суммы отправки относительно суммы получения. Десятичная строка. */
  readonly feeFactor?: string;
  readonly minToAmount?: string;
  readonly maxToAmount?: string;
  /** Срок жизни rateId, мс. */
  readonly quoteTtlMs?: number;
  readonly now?: () => Date;
}

interface StoredQuote {
  readonly currency: string;
  readonly network: string;
  readonly toAmount: string;
  readonly fromAmount: string;
  readonly expiresAt: Date;
}

interface StoredTransfer {
  readonly fromAmount: string;
  readonly toAmount: string;
  readonly payinAddress: string;
  readonly payoutAddress: string;
  readonly payinExtraId: string | null;
  readonly payoutExtraId: string | null;
  providerStatus: string;
  actualFromAmount: string | null;
  actualToAmount: string | null;
}

function throwIfAborted(options?: ProviderCallOptions): void {
  if (options?.signal?.aborted) {
    throw new ExchangeProviderError('UNAVAILABLE', 'Provider call was aborted');
  }
}

export class MockPrivateTransferProvider implements PrivateTransferProvider {
  private readonly currencies: readonly ProviderCurrency[];
  private readonly feeFactor: string;
  private readonly minToAmount: string;
  private readonly maxToAmount: string;
  private readonly quoteTtlMs: number;
  private readonly now: () => Date;

  private readonly quotes = new Map<string, StoredQuote>();
  private readonly transfers = new Map<string, StoredTransfer>();
  private sequence = 0;

  constructor(options: MockPrivateTransferProviderOptions = {}) {
    this.currencies = options.currencies ?? DEFAULT_MOCK_CURRENCIES;
    this.feeFactor = options.feeFactor ?? '1.01';
    this.minToAmount = options.minToAmount ?? '0.0001';
    this.maxToAmount = options.maxToAmount ?? '1000000';
    this.quoteTtlMs = options.quoteTtlMs ?? 120_000;
    this.now = options.now ?? (() => new Date());
  }

  estimate(
    request: PrivateTransferEstimateRequest,
    options?: ProviderCallOptions,
  ): Promise<PrivateTransferEstimate> {
    return Promise.resolve().then(() => {
      throwIfAborted(options);
      return this.buildEstimate(request);
    });
  }

  create(
    request: CreatePrivateTransferRequest,
    options?: ProviderCallOptions,
  ): Promise<PrivateTransfer> {
    return Promise.resolve().then(() => {
      throwIfAborted(options);
      return this.openTransfer(request);
    });
  }

  getStatus(
    providerTransferId: string,
    options?: ProviderCallOptions,
  ): Promise<ProviderExchangeStatus> {
    return Promise.resolve().then(() => {
      throwIfAborted(options);
      return this.toStatus(providerTransferId, this.requireTransfer(providerTransferId));
    });
  }

  /** Двигает перевод на следующий шаг цепочки waiting → … → finished. */
  advanceStatus(providerTransferId: string): void {
    const transfer = this.requireTransfer(providerTransferId);
    const index = HAPPY_PATH.findIndex((status) => status === transfer.providerStatus);
    const next = index === -1 ? undefined : HAPPY_PATH[index + 1];
    if (next === undefined) {
      throw new Error(`Cannot advance mock transfer from status "${transfer.providerStatus}"`);
    }
    this.applyStatus(transfer, next);
  }

  /** Задаёт сырой статус напрямую (в том числе нестандартный). */
  setProviderStatus(providerTransferId: string, providerStatus: string): void {
    this.applyStatus(this.requireTransfer(providerTransferId), providerStatus);
  }

  private buildEstimate(request: PrivateTransferEstimateRequest): PrivateTransferEstimate {
    const toAmount = this.requireAmount(request);
    this.requireCurrency(request.currency, request.network);
    const fromAmount = multiplyDecimal(toAmount, this.feeFactor);
    if (parseDecimal(fromAmount) === 0n) {
      throw new ExchangeProviderError('AMOUNT_OUT_OF_RANGE', 'Amount is too small');
    }

    this.sequence += 1;
    const rateId = `mock-transfer-rate-${String(this.sequence)}`;
    const validUntil = new Date(this.now().getTime() + this.quoteTtlMs);
    this.quotes.set(rateId, {
      currency: request.currency,
      network: request.network,
      toAmount,
      fromAmount,
      expiresAt: validUntil,
    });
    return { fromAmount, toAmount, rateId, validUntil, warningMessage: null };
  }

  private openTransfer(request: CreatePrivateTransferRequest): PrivateTransfer {
    const currency = this.requireCurrency(request.currency, request.network);
    this.checkRecipient(request, currency);
    const storedQuote = this.quotes.get(request.rateId);
    if (storedQuote?.currency !== request.currency || storedQuote.network !== request.network) {
      throw new ExchangeProviderError('INVALID_REQUEST', 'Unknown rate id for this currency');
    }
    const toAmount = this.requireAmount(request);
    if (compareDecimal(storedQuote.toAmount, toAmount) !== 0) {
      throw new ExchangeProviderError('INVALID_REQUEST', 'Amount differs from quoted amount');
    }
    if (storedQuote.expiresAt.getTime() <= this.now().getTime()) {
      throw new ExchangeProviderError('QUOTE_EXPIRED', 'Private transfer quote has expired');
    }

    this.sequence += 1;
    const id = `mock-transfer-${randomUUID()}`;
    const stored: StoredTransfer = {
      fromAmount: storedQuote.fromAmount,
      toAmount: storedQuote.toAmount,
      payinAddress: `mock-payin-address-${String(this.sequence)}`,
      payoutAddress: request.address.trim(),
      payinExtraId: currency.extraId === 'none' ? null : `mock-payin-memo-${String(this.sequence)}`,
      payoutExtraId: request.extraId,
      providerStatus: 'waiting',
      actualFromAmount: null,
      actualToAmount: null,
    };
    this.transfers.set(id, stored);
    return {
      providerTransferId: id,
      fromAmount: stored.fromAmount,
      toAmount: stored.toAmount,
      payinAddress: stored.payinAddress,
      payoutAddress: stored.payoutAddress,
      payinExtraId: stored.payinExtraId,
      payoutExtraId: stored.payoutExtraId,
      providerStatus: stored.providerStatus,
    };
  }

  private requireAmount(request: PrivateTransferEstimateRequest): string {
    let toAmount: string;
    try {
      toAmount = formatDecimal(parseDecimal(request.toAmount));
    } catch {
      throw new ExchangeProviderError('INVALID_REQUEST', 'Amount is not a valid decimal');
    }
    if (
      compareDecimal(toAmount, this.minToAmount) < 0 ||
      compareDecimal(toAmount, this.maxToAmount) > 0
    ) {
      throw new ExchangeProviderError('AMOUNT_OUT_OF_RANGE', 'Amount is out of allowed range');
    }
    return toAmount;
  }

  private requireCurrency(currency: string, network: string): ProviderCurrency {
    const found = this.currencies.find(
      (item) => item.ticker === currency && item.network === network,
    );
    if (!found) {
      throw new ExchangeProviderError('PAIR_NOT_SUPPORTED', 'Currency is not supported');
    }
    return found;
  }

  private checkRecipient(request: CreatePrivateTransferRequest, currency: ProviderCurrency): void {
    if (request.address.trim() === '') {
      throw new ExchangeProviderError('INVALID_REQUEST', 'Recipient address is required');
    }
    if (currency.extraId === 'required' && request.extraId === null) {
      throw new ExchangeProviderError('INVALID_REQUEST', 'Recipient extraId is required');
    }
    if (currency.extraId === 'none' && request.extraId !== null) {
      throw new ExchangeProviderError('INVALID_REQUEST', 'Recipient extraId is not supported');
    }
    if (request.refundAddress === null && request.refundExtraId !== null) {
      throw new ExchangeProviderError('INVALID_REQUEST', 'Refund extraId requires refund address');
    }
  }

  private requireTransfer(providerTransferId: string): StoredTransfer {
    const transfer = this.transfers.get(providerTransferId);
    if (!transfer) {
      throw new ExchangeProviderError('NOT_FOUND', 'Transfer not found');
    }
    return transfer;
  }

  private applyStatus(transfer: StoredTransfer, providerStatus: string): void {
    transfer.providerStatus = providerStatus;
    if (providerStatus === 'finished') {
      transfer.actualFromAmount = transfer.fromAmount;
      transfer.actualToAmount = transfer.toAmount;
    }
  }

  private toStatus(providerTransferId: string, transfer: StoredTransfer): ProviderExchangeStatus {
    return {
      providerExchangeId: providerTransferId,
      providerStatus: transfer.providerStatus,
      status: RAW_STATUS_TO_INTERNAL[transfer.providerStatus] ?? 'VERIFYING',
      actualFromAmount: transfer.actualFromAmount,
      actualToAmount: transfer.actualToAmount,
      payinHash: null,
      payoutHash: null,
      refundHash: null,
    };
  }
}
