/**
 * Форма адреса выплаты для известных сетей ChangeNOW.
 *
 * Отсекает очевидный мусор вроде короткой строки вместо SOL. Не проверяет
 * контрольную сумму и не доказывает, что адрес существует или принадлежит
 * получателю: похожий по длине адрес чужой сети всё ещё может пройти.
 * Неизвестная сеть не ограничивается — иначе новый код каталога блокировал бы выплату.
 */

const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
const BECH32 = '[02-9ac-hj-np-z]';
const BECH32_UPPER = '[02-9AC-HJ-NP-Z]';

/** Сети, где адрес кошелька — 0x и 40 hex. Тикер монеты здесь не важен. */
const EVM_NETWORKS = new Set([
  'eth',
  'bsc',
  'bnb',
  'matic',
  'polygon',
  'arb',
  'op',
  'base',
  'avaxc',
  'cchain',
]);

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const NETWORK_SHAPES: Readonly<Record<string, RegExp>> = {
  sol: new RegExp(`^${BASE58}{32,44}$`),
  trx: new RegExp(`^T${BASE58}{33}$`),
  btc: new RegExp(`^(?:[13]${BASE58}{25,34}|bc1${BECH32}{11,71}|BC1${BECH32_UPPER}{11,71})$`),
  ltc: new RegExp(`^(?:[LM3]${BASE58}{25,34}|ltc1${BECH32}{11,71}|LTC1${BECH32_UPPER}{11,71})$`),
  doge: new RegExp(`^D${BASE58}{25,34}$`),
  xrp: new RegExp(`^(?:r${BASE58}{24,34}|X${BASE58}{46})$`),
  xlm: /^[GM][A-Z2-7]{55}$/,
  ton: /^(?:[EU]Q[A-Za-z0-9_-]{46}|-?[0-9]+:[0-9a-fA-F]{64})$/,
  ada: new RegExp(`^addr1${BECH32}{20,120}$`),
  dot: new RegExp(`^1${BASE58}{46,49}$`),
  atom: new RegExp(`^cosmos1${BECH32}{20,90}$`),
  near: /^(?:[0-9a-f]{64}|[a-z0-9._-]{2,64}\.near)$/,
  algo: /^[A-Z2-7]{58}$/,
  bch: new RegExp(`^(?:(?:bitcoincash:)?[qp]${BECH32}{41}|[13]${BASE58}{25,34})$`),
  xmr: new RegExp(`^(?:[48]${BASE58}{94}|4${BASE58}{105})$`),
};

/**
 * true — адрес похож на сеть либо сеть нам неизвестна.
 * Адрес уже обрезан и прошёл общую проверку символов.
 */
export function matchesPayoutAddressShape(network: string, address: string): boolean {
  const key = network.trim().toLowerCase();
  if (EVM_NETWORKS.has(key)) return EVM_ADDRESS.test(address);
  const pattern = NETWORK_SHAPES[key];
  return pattern ? pattern.test(address) : true;
}
