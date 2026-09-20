import { useCallback, useEffect, useState, type FormEvent } from 'react';
import './App.css';
import {
  fetchUsers,
  fetchUser,
  createUser,
  fetchCatalog,
  placeOrder,
  type UserSummary,
  type UserDetail,
  type CatalogItem,
  type OrderResult,
  type Benefit,
} from './api';

// Mirrors backend/src/constants.ts DELIVERY_FEE — no shared package between
// the two apps in this demo, so kept in sync by hand.
const DELIVERY_FEE = 10;

function App() {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedUser, setSelectedUser] = useState<UserDetail | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [paymentOutcome, setPaymentOutcome] = useState<'success' | 'failure'>('success');
  const [orderResult, setOrderResult] = useState<OrderResult | null>(null);
  const [placing, setPlacing] = useState(false);
  const [appliedBenefitId, setAppliedBenefitId] = useState<string | null>(null);
  const [autoApplyBenefit, setAutoApplyBenefit] = useState(true);
  const [newUserName, setNewUserName] = useState('');
  const [newUserEmail, setNewUserEmail] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const [loginError, setLoginError] = useState('');

  const loadUsers = useCallback(() => fetchUsers().then(setUsers), []);

  useEffect(() => {
    loadUsers();
    fetchCatalog().then(setCatalog);
  }, [loadUsers]);

  const refreshSelectedUser = useCallback((id: string) => {
    if (!id) return;
    fetchUser(id).then(setSelectedUser);
  }, []);

  useEffect(() => {
    setAppliedBenefitId(null);
    if (!selectedUserId) {
      setSelectedUser(null);
      return;
    }
    refreshSelectedUser(selectedUserId);
    // Points/tier are credited asynchronously off the queue — poll so the
    // update becomes visible without a manual refresh.
    const interval = setInterval(() => refreshSelectedUser(selectedUserId), 1500);
    return () => clearInterval(interval);
  }, [selectedUserId, refreshSelectedUser]);

  const handleCreateUser = async (e: FormEvent) => {
    e.preventDefault();
    if (!newUserName || !newUserEmail) return;
    const user = await createUser(newUserEmail, newUserName);
    setNewUserName('');
    setNewUserEmail('');
    await loadUsers();
    setSelectedUserId(user._id);
  };

  const handleLogin = () => {
    if (!selectedUserId) {
      setLoginError('Select a user first.');
      return;
    }
    setLoginError('');
    setLoggedIn(true);
  };

  const handleSwitchUser = () => {
    setLoggedIn(false);
    setLoginError('');
    setOrderResult(null);
    setCart({});
    setAppliedBenefitId(null);
  };

  const setQty = (catalogId: string, qty: number) => {
    setCart((prev) => {
      const next = { ...prev };
      if (qty <= 0) delete next[catalogId];
      else next[catalogId] = qty;
      return next;
    });
  };

  const cartItemCount = Object.values(cart).reduce((sum, qty) => sum + qty, 0);
  const cartTotal = catalog.reduce((sum, item) => sum + (cart[item.catalogId] ?? 0) * item.price, 0);

  const manuallyAppliedBenefit = selectedUser?.benefits.find((b) => b._id === appliedBenefitId);
  // What will actually be used if nothing's manually selected: the oldest
  // available benefit, same tie-break the backend uses — but note this is
  // only ever a preview of *currently known* benefits. In the race-condition
  // case (a prior order's benefit unlocks mid-request), the server may
  // auto-apply something this preview can't know about yet — that's expected.
  const autoPickedBenefit = autoApplyBenefit ? selectedUser?.benefits.find((b) => b.status === 'available') : undefined;
  const effectiveBenefit = manuallyAppliedBenefit ?? autoPickedBenefit;

  // Mirrors the backend's pricing formula in routes/orders.ts, so the
  // preview matches what the order will actually charge — recomputed on
  // every render, so it updates live as cart quantities change.
  let previewSubtotal = cartTotal;
  let previewDeliveryFee = DELIVERY_FEE;
  if (effectiveBenefit) {
    if (effectiveBenefit.type === 'discount' && typeof effectiveBenefit.value === 'number') {
      previewSubtotal = cartTotal * (1 - effectiveBenefit.value / 100);
    } else if (effectiveBenefit.type === 'free_item' && effectiveBenefit.catalogId && typeof effectiveBenefit.value === 'number') {
      const unitPrice = catalog.find((c) => c.catalogId === effectiveBenefit.catalogId)?.price ?? 0;
      previewSubtotal = Math.max(0, cartTotal - unitPrice * effectiveBenefit.value);
    } else if (effectiveBenefit.type === 'free_delivery') {
      previewDeliveryFee = 0;
    }
  }
  const previewTotal = previewSubtotal + previewDeliveryFee;

  const handleToggleBenefit = (b: Benefit) => {
    const applying = appliedBenefitId !== b._id;
    setAppliedBenefitId(applying ? b._id : null);
    // Applying a "free N of this item" benefit sets the cart to match, so
    // the free items are actually visible in what's being ordered rather
    // than an abstract discount unrelated to the cart's contents.
    if (applying && b.type === 'free_item' && b.catalogId && typeof b.value === 'number') {
      setQty(b.catalogId, b.value);
    }
  };

  const handlePlaceOrder = async () => {
    if (!selectedUserId || cartItemCount === 0) return;
    setPlacing(true);
    setOrderResult(null);
    try {
      const items = catalog
        .filter((item) => (cart[item.catalogId] ?? 0) > 0)
        .map((item) => ({ ...item, qty: cart[item.catalogId] }));
      const result = await placeOrder(
        selectedUserId,
        items,
        paymentOutcome,
        appliedBenefitId ?? undefined,
        autoApplyBenefit
      );
      setOrderResult(result);
      setCart({});
      // Only clear the selection on a successful payment — a failed payment
      // leaves the benefit available, so keep it selected for a retry.
      if (result.order?.status === 'paid') {
        setAppliedBenefitId(null);
      }
      refreshSelectedUser(selectedUserId);
    } catch (err) {
      setOrderResult({ error: (err as Error).message });
    } finally {
      setPlacing(false);
    }
  };

  return (
    <div className="app">
      <h1>Loyalty Demo</h1>

      <section className="panel">
        <h2>User</h2>
        {!loggedIn ? (
          <>
            <select value={selectedUserId} onChange={(e) => { setSelectedUserId(e.target.value); setLoginError(''); }}>
              <option value="">Select a user…</option>
              {users.map((u) => (
                <option key={u._id} value={u._id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </select>

            <form className="new-user-form" onSubmit={handleCreateUser}>
              <input placeholder="name" value={newUserName} onChange={(e) => setNewUserName(e.target.value)} />
              <input placeholder="email" value={newUserEmail} onChange={(e) => setNewUserEmail(e.target.value)} />
              <button type="submit">+ New user</button>
            </form>

            <div className="login-row">
              <button className="place-order" onClick={handleLogin}>
                Login
              </button>
              {loginError && <span className="login-error">{loginError}</span>}
            </div>
          </>
        ) : (
          <div className="logged-in-as">
            Logged in as <strong>{selectedUser?.name}</strong> ({selectedUser?.email}){' '}
            <button className="link-button" onClick={handleSwitchUser}>
              switch user
            </button>
          </div>
        )}

        {loggedIn && selectedUser && (
          <div className="loyalty-status">
            <div className="stat-row">
              <span className="stat">
                <strong>{selectedUser.loyalty.points}</strong> points
              </span>
              <span className="stat tier">{selectedUser.loyalty.tier ?? 'no tier yet'}</span>
            </div>
            <div className="benefits">
              <strong>Benefits</strong>
              {selectedUser.benefits.length === 0 ? (
                <p className="muted">none yet</p>
              ) : (
                <ul>
                  {selectedUser.benefits.map((b) => (
                    <li key={b._id} className={b.status}>
                      {b.description ?? `${b.type} (${b.value})`} — earned from {b.earnedFromTier} — {b.status}
                      {b.status === 'available' && (
                        <button className="apply-benefit" onClick={() => handleToggleBenefit(b)}>
                          {appliedBenefitId === b._id ? 'Remove' : 'Apply'}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </section>

      {loggedIn && selectedUser && (
        <>
          <section className="panel">
            <h2>Catalog</h2>
            <table>
              <tbody>
                {catalog.map((item) => (
                  <tr key={item.catalogId}>
                    <td>{item.name}</td>
                    <td>${item.price.toFixed(2)}</td>
                    <td className="qty-control">
                      <button onClick={() => setQty(item.catalogId, (cart[item.catalogId] ?? 0) - 1)}>-</button>
                      <span>{cart[item.catalogId] ?? 0}</span>
                      <button onClick={() => setQty(item.catalogId, (cart[item.catalogId] ?? 0) + 1)}>+</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="cart-total">
              Items: ${cartTotal.toFixed(2)} + ${DELIVERY_FEE.toFixed(2)} delivery = $
              {(cartTotal + DELIVERY_FEE).toFixed(2)}{' '}
              <span className="muted">{effectiveBenefit ? '(before benefit)' : '(before any benefit)'}</span>
            </div>
            {effectiveBenefit && <div className="cart-total after-benefit">After benefit: ${previewTotal.toFixed(2)}</div>}
          </section>

          <section className="panel">
            <h2>Checkout</h2>
            <label className="auto-apply-toggle">
              <input
                type="checkbox"
                checked={autoApplyBenefit}
                onChange={(e) => setAutoApplyBenefit(e.target.checked)}
              />
              Auto-apply best available offer
            </label>
            {manuallyAppliedBenefit ? (
              <div className="applied-benefit-note">
                Benefit applied ✓ ({manuallyAppliedBenefit.description ?? manuallyAppliedBenefit.type}){' '}
                <button className="link-button" onClick={() => setAppliedBenefitId(null)}>
                  remove
                </button>
              </div>
            ) : autoApplyBenefit ? (
              <div className="muted">
                Auto-apply is on — the best available offer will be used, including one still being credited from an
                earlier order.
              </div>
            ) : (
              <div className="muted">No benefit will be applied — click "Apply" above, or turn auto-apply back on.</div>
            )}
            <label className="payment-outcome">
              Mock payment outcome:
              <select value={paymentOutcome} onChange={(e) => setPaymentOutcome(e.target.value as 'success' | 'failure')}>
                <option value="success">Success</option>
                <option value="failure">Failure</option>
              </select>
            </label>
            <button
              className="place-order"
              disabled={!selectedUserId || cartItemCount === 0 || placing}
              onClick={handlePlaceOrder}
            >
              {placing ? 'Placing…' : 'Place order'}
            </button>

            {orderResult && (
              <div className={`order-result ${orderResult.error ? 'error' : orderResult.order?.status}`}>
                {orderResult.error && <div>Error: {orderResult.error}</div>}
                {orderResult.order && (
                  <>
                    <div>Status: {orderResult.order.status}</div>
                    <div>Delivery fee: ${orderResult.order.deliveryFee.toFixed(2)}</div>
                    <div>Total: ${orderResult.order.totalAmount.toFixed(2)}</div>
                    {orderResult.order.benefitApplied && (
                      <div>
                        Benefit applied: {orderResult.order.benefitApplied.type} ({orderResult.order.benefitApplied.value})
                      </div>
                    )}
                    {orderResult.message && <div className="muted">{orderResult.message}</div>}
                  </>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

export default App;
