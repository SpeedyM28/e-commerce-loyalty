export const BENEFIT_TYPES = ['discount', 'free_item', 'free_delivery'] as const;
export type BenefitType = (typeof BENEFIT_TYPES)[number];

// Flat delivery fee — deliberately not part of any line item, so it never
// factors into loyalty points (points are computed per Order.items only).
export const DELIVERY_FEE = 10;
