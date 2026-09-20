import { Router } from 'express';

// Static demo catalog — no Product model/admin flow for this project, just
// enough for the frontend to build an order out of real-looking items.
export const CATALOG = [
  { catalogId: 'sku-coffee', name: 'Coffee', price: 4.5 },
  { catalogId: 'sku-sandwich', name: 'Sandwich', price: 8.0 },
  { catalogId: 'sku-salad', name: 'Salad', price: 9.5 },
  { catalogId: 'sku-pastry', name: 'Pastry', price: 3.25 },
  { catalogId: 'sku-combo', name: 'Lunch Combo', price: 14.0 },
];

export const CATALOG_PRICE_BY_ID: Record<string, number> = Object.fromEntries(
  CATALOG.map((item) => [item.catalogId, item.price])
);

const router = Router();

router.get('/', (_req, res) => {
  res.json(CATALOG);
});

export default router;
