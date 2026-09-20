# E-Commerce Loyalty Demo

A local, working demo of an e-commerce checkout flow with a tiered loyalty/rewards program, built as a take-home technical assessment. See [`progression_history.md`](./progression_history.md) for the design discussion and decisions behind how this came together.

## What it does

A user adds items to a cart and checks out. Payment is mocked (success/failure is chosen by the caller, simulating a gateway callback). On a successful payment:

1. The order is marked `paid` and an `order.payment.succeeded` event is published to RabbitMQ.
2. An idempotent consumer credits loyalty points per order line item.
3. After crediting, the user's tier is re-evaluated against `tier_configs`. Reaching a new tier grants a benefit (a discount, a free item, or free delivery).
4. Available benefits can be applied (auto-applied by default, with an opt-out) at the next checkout, discounting that order's total.

## Stack

- **Backend**: Node.js + Express + TypeScript
- **Database**: MongoDB + Mongoose
- **Messaging**: RabbitMQ (topic exchange, durable queue, idempotent consumer)
- **Frontend**: React + TypeScript + Vite (minimal — a functional demo UI, not a polished product)
- **Local infra**: Docker Compose (MongoDB + RabbitMQ only — no cloud/CI/CD/Terraform, per the brief's scope)

These choices were made deliberately, not defaults — see `progression_history.md` for the reasoning (in short: Express over Nest because Nest was unfamiliar; Mongo chosen specifically to learn it, coming from a Postgres/Supabase background; RabbitMQ chosen specifically to get real message-broker ownership experience).

## Prerequisites

- Node.js 18+
- Docker Desktop (for local MongoDB + RabbitMQ)

## Setup

**1. Start MongoDB + RabbitMQ:**

```bash
docker compose up -d
```

RabbitMQ's management UI is available at `http://localhost:15672` (user/pass: `admin` / `admin123`, set in `docker-compose.yml` — local-only credentials, not meant to be reused anywhere real).

**2. Backend:**

```bash
cd backend
npm install
cp .env.example .env   # defaults already point at the docker-compose services
npm run seed:tiers     # populates the tier_configs collection (bronze/silver/gold/platinum)
npm run dev            # starts the API on http://localhost:4000
```

**3. Frontend:**

```bash
cd frontend
npm install
npm run dev             # starts the UI on http://localhost:5173
```

Open `http://localhost:5173`, select or create a user, log in, and place an order.

## Loyalty tiers

Thresholds and benefits are **data**, not code — stored one document per tier in the `tier_configs` collection (see `backend/src/models/TierConfig.ts`, seeded by `backend/src/scripts/seedTierConfigs.ts`). Current demo ladder:

| Tier | Threshold | Benefit |
|---|---|---|
| Bronze | $100 | 5% discount |
| Silver | $200 | 10% discount |
| Gold | $300 | Free delivery |
| Platinum | $400 | 5 free Lunch Combos |

Loyalty points are earned 1-per-currency-unit on item subtotal only — the $10 delivery fee is excluded from points.

## Health check

`GET http://localhost:4000/health` returns { mongo: true, rabbitmq: true } after round-tripping a write/read/delete against MongoDB and a publish/consume against RabbitMQ.

## Debug-only: reproducing the queue race condition

`CONSUMER_PROCESSING_DELAY_MS` (see `.env.example`, commented out by default) artificially slows down the loyalty consumer, widening the window to manually reproduce the "second order beats the first order's queue processing" race for a demo recording. It's a testing aid, not application behavior — leave it unset for normal use.

## Known limitations (by design, for this demo's scope)

- No dead-letter queue — a poison queue message is dropped, not retried.
- No cross-device/cross-session push notification when a benefit unlocks mid-session (would need WebSockets); instead, the backend does an inline "catch-up" of a user's own unprocessed paid orders at the start of their next checkout, so pricing is always correct even if the UI hasn't caught up yet. See `progression_history.md` for the full reasoning behind this choice.
- Single-instance RabbitMQ/Mongo, no auth/session layer beyond the demo's simple user picker.
