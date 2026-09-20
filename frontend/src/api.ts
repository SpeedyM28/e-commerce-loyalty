const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

export interface CatalogItem {
  catalogId: string;
  name: string;
  price: number;
}

export interface Benefit {
  _id: string;
  type: 'discount' | 'free_item' | 'free_delivery';
  value: number | string;
  catalogId?: string;
  description?: string;
  earnedFromTier: string;
  status: 'available' | 'used';
  grantedAt: string;
  usedOnOrderId?: string;
}

export interface UserSummary {
  _id: string;
  email: string;
  name: string;
  loyalty: { points: number; tier?: string; tierUpdatedAt?: string };
}

export interface UserDetail extends UserSummary {
  benefits: Benefit[];
}

export interface OrderItemInput {
  catalogId: string;
  name: string;
  price: number;
  qty: number;
}

export interface OrderResult {
  order?: {
    _id: string;
    deliveryFee: number;
    totalAmount: number;
    benefitApplied?: { type: string; value: number | string };
    status: 'pending' | 'paid' | 'failed';
  };
  message?: string;
  error?: string;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data as T;
}

export const fetchUsers = () => request<UserSummary[]>('/users');
export const fetchUser = (id: string) => request<UserDetail>(`/users/${id}`);
export const createUser = (email: string, name: string) =>
  request<UserDetail>('/users', { method: 'POST', body: JSON.stringify({ email, name }) });
export const fetchCatalog = () => request<CatalogItem[]>('/catalog');

// Not using the shared `request` helper here: a failed mock payment comes
// back as HTTP 402 with a real body ({ error, order }) that the UI wants to
// render, not throw away as a generic error.
export async function placeOrder(
  userId: string,
  items: OrderItemInput[],
  paymentOutcome: 'success' | 'failure',
  benefitId?: string,
  autoApplyBenefit?: boolean
): Promise<OrderResult> {
  const res = await fetch(`${API_BASE}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, items, paymentOutcome, benefitId, autoApplyBenefit }),
  });
  const data = (await res.json()) as OrderResult;
  if (!res.ok && res.status !== 402) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}
