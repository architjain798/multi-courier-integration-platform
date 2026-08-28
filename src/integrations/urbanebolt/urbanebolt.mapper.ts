import type {
  Address,
  NormalizedOrder,
  PaymentMode,
  ServiceLevel,
} from '../../components/couriers/index.js';
import type { UrbaneBoltConfig } from './urbanebolt.config.js';

// UrbaneBolt exposes SDD, NDD, ATA, PTP, 2HR and IMP. Only the first two map onto anything our
// unified vocabulary promises, so STANDARD is served as next-day rather than inventing a tier.
const SERVICE_TYPE: Readonly<Record<ServiceLevel, string>> = {
  SAME_DAY: 'SDD',
  NEXT_DAY: 'NDD',
  STANDARD: 'NDD',
};

const PAY_MODE: Readonly<Record<PaymentMode, string>> = {
  PREPAID: 'PPD',
  COD: 'COD',
};

const ADDRESS_TYPE: Readonly<Record<Address['type'], string>> = {
  HOME: 'Home',
  OFFICE: 'Office',
  SELLER: 'Seller',
  WAREHOUSE: 'Seller',
};

export type ManifestItem = Record<string, string | number | boolean>;

export function toManifestItem(order: NormalizedOrder, config: UrbaneBoltConfig): ManifestItem {
  const returnAddress = order.returnAddress ?? order.pickup;
  const itemDescription = order.items.map((item) => item.description).join(', ');
  const itemQuantity = order.items.reduce((total, item) => total + item.quantity, 0);

  return {
    customerCode: config.customerCode,
    orderNumber: order.orderId,
    serviceType: SERVICE_TYPE[order.serviceLevel],
    payMode: PAY_MODE[order.paymentMode],

    declaredValue: order.declaredValue,
    collectableValue: order.paymentMode === 'COD' ? order.collectableAmount : 0,
    invoiceNumber: order.invoice.number,
    invoiceDate: order.invoice.date,
    invoiceValue: order.invoice.value,

    itemDescription,
    itemQuantity,
    pieces: order.parcel.pieces,
    weight: order.parcel.weightKg,
    length: order.parcel.lengthCm,
    breadth: order.parcel.breadthCm,
    height: order.parcel.heightCm,

    ...prefixed('shpr', order.pickup),
    ...prefixed('rtn', returnAddress),
    ...prefixed('cons', order.delivery),
  };
}

function prefixed(prefix: 'shpr' | 'rtn' | 'cons', address: Address): ManifestItem {
  return {
    [`${prefix}Name`]: address.name,
    [`${prefix}Address`]: [address.line1, address.line2].filter(Boolean).join(', '),
    [`${prefix}AddressType`]: ADDRESS_TYPE[address.type],
    [`${prefix}City`]: address.city,
    [`${prefix}State`]: address.state,
    [`${prefix}Country`]: address.country,
    [`${prefix}Pincode`]: Number(address.pincode),
    [`${prefix}Mobile`]: toMobileNumber(address.phone),
    [`${prefix}Email`]: address.email ?? '',
  };
}

// UrbaneBolt's samples send mobile numbers as integers, so anything formatted with a country code
// or separators has to be reduced to the trailing subscriber number.
function toMobileNumber(phone: string): number {
  const digits = phone.replace(/\D/g, '');
  return Number(digits.slice(-10));
}
