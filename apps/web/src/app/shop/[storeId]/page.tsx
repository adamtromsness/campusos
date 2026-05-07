'use client';

import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

interface PublicProduct {
  id: string;
  name: string;
  description: string | null;
  price: number;
  imageS3Keys: string[];
  totalAvailable: number;
}

interface PublicStore {
  id: string;
  name: string;
  description: string | null;
}

interface ShippingOption {
  id: string;
  methodName: string;
  estimatedDays: number | null;
  flatRate: number;
}

/**
 * Public storefront — unauthenticated route at /shop/[storeId]. Sits
 * outside the (app) layout so non-CampusOS visitors can browse + buy
 * without an account. The /shop/external-customers POST + the
 * EXTERNAL order creation paths are the only public surfaces.
 *
 * Manual payment recording this cycle (Stripe Checkout deferred per
 * the plan).
 */
export default function PublicStorefront() {
  const params = useParams<{ storeId: string }>();
  const storeId = params?.storeId ?? null;
  const [store, setStore] = useState<PublicStore | null>(null);
  const [products, setProducts] = useState<PublicProduct[]>([]);
  const [shippingOptions, setShippingOptions] = useState<ShippingOption[]>([]);
  const [cart, setCart] = useState<Array<{ id: string; qty: number; name: string; price: number }>>(
    [],
  );
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [shippingAddress, setShippingAddress] = useState('');
  const [shippingOptionId, setShippingOptionId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Public fetch — no auth header; the API enforces /shop/* allowlist.
  // Note: /api/v1/store/* routes are gated; for this cycle we hit the
  // gated routes anonymously to demo the storefront and surface the
  // expected 403 / wiring is documented as Phase 2 polish (see plan).
  useEffect(() => {
    if (!storeId) return;
    fetch(`/api/v1/store/stores/${storeId}`, {
      headers: { 'X-Tenant-Subdomain': 'demo' },
    })
      .then((r) => r.json())
      .then((d) => setStore(d))
      .catch(() => setStore(null));
    fetch(`/api/v1/store/stores/${storeId}/products`, {
      headers: { 'X-Tenant-Subdomain': 'demo' },
    })
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setProducts(d))
      .catch(() => setProducts([]));
    fetch(`/api/v1/store/stores/${storeId}/shipping-options`, {
      headers: { 'X-Tenant-Subdomain': 'demo' },
    })
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setShippingOptions(d))
      .catch(() => setShippingOptions([]));
  }, [storeId]);

  const subtotal = useMemo(() => cart.reduce((s, c) => s + c.qty * c.price, 0), [cart]);
  const shipping = useMemo(
    () => shippingOptions.find((o) => o.id === shippingOptionId)?.flatRate ?? 0,
    [shippingOptions, shippingOptionId],
  );
  const total = subtotal + shipping;

  const submit = async () => {
    setErrorMsg(null);
    if (!name || !email || !shippingOptionId || cart.length === 0) {
      setErrorMsg('Name, email, shipping option, and at least one item are required.');
      return;
    }
    setSubmitting(true);
    try {
      // Public endpoint to register the customer
      const customerResp = await fetch('/api/v1/shop/external-customers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Subdomain': 'demo',
        },
        body: JSON.stringify({ name, email, phone, shippingAddress }),
      });
      if (!customerResp.ok) {
        throw new Error('Could not register customer');
      }
      const customer = await customerResp.json();
      // Order creation requires authentication today — public Stripe
      // Checkout integration is deferred to Phase 2. For now we surface
      // the customer record as the success state.
      setSuccess(
        `Customer registered (id ${customer.id.slice(0, 8)}). Order placement via the public storefront requires Stripe Checkout — coming in Phase 2.`,
      );
      setCheckoutOpen(false);
    } catch (err: unknown) {
      setErrorMsg((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-campus-600">
              CampusOS Public Store
            </div>
            <h1 className="text-xl font-semibold text-gray-900">{store?.name ?? 'Loading…'}</h1>
          </div>
          {cart.length > 0 && (
            <button
              onClick={() => setCheckoutOpen(true)}
              className="rounded-md bg-campus-600 px-4 py-2 text-sm font-medium text-white"
            >
              Checkout ({cart.length})
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        {store?.description && <p className="mb-6 text-sm text-gray-600">{store.description}</p>}

        {success && (
          <div className="mb-6 rounded-md bg-emerald-50 p-4 text-sm text-emerald-800">
            {success}
          </div>
        )}
        {errorMsg && (
          <div className="mb-6 rounded-md bg-rose-50 p-4 text-sm text-rose-800">{errorMsg}</div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => (
            <div key={p.id} className="rounded-card border border-gray-200 bg-white p-4 shadow-sm">
              <div className="font-semibold text-gray-900">{p.name}</div>
              {p.description && (
                <p className="mt-1 text-xs text-gray-600 line-clamp-2">{p.description}</p>
              )}
              <div className="mt-3 flex items-center justify-between">
                <div className="text-lg font-semibold text-campus-700">${p.price.toFixed(2)}</div>
                <button
                  onClick={() =>
                    setCart((prev) => {
                      const existing = prev.find((c) => c.id === p.id);
                      if (existing) {
                        return prev.map((c) => (c.id === p.id ? { ...c, qty: c.qty + 1 } : c));
                      }
                      return [...prev, { id: p.id, qty: 1, name: p.name, price: p.price }];
                    })
                  }
                  className="rounded-md bg-campus-600 px-3 py-1 text-sm font-medium text-white"
                >
                  Add to cart
                </button>
              </div>
            </div>
          ))}
        </div>

        {checkoutOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg rounded-card bg-white p-6 shadow-xl">
              <h2 className="mb-4 text-lg font-semibold">Checkout</h2>

              <div className="mb-4 space-y-1 rounded-md bg-gray-50 p-3 text-sm">
                {cart.map((c) => (
                  <div key={c.id} className="flex items-center justify-between">
                    <span>
                      {c.qty} × {c.name}
                    </span>
                    <span>${(c.qty * c.price).toFixed(2)}</span>
                  </div>
                ))}
                <div className="mt-2 border-t border-gray-200 pt-2">
                  <div className="flex items-center justify-between text-xs text-gray-600">
                    <span>Subtotal</span>
                    <span>${subtotal.toFixed(2)}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-gray-600">
                    <span>Shipping</span>
                    <span>${shipping.toFixed(2)}</span>
                  </div>
                  <div className="flex items-center justify-between font-semibold">
                    <span>Total</span>
                    <span>${total.toFixed(2)}</span>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <input
                  placeholder="Full name *"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
                <input
                  placeholder="Email *"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
                <input
                  placeholder="Phone (optional)"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
                <textarea
                  placeholder="Shipping address"
                  value={shippingAddress}
                  onChange={(e) => setShippingAddress(e.target.value)}
                  rows={2}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
                <select
                  value={shippingOptionId}
                  onChange={(e) => setShippingOptionId(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="">— Pick a shipping method —</option>
                  {shippingOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.methodName}{' '}
                      {o.estimatedDays !== null && o.estimatedDays !== undefined
                        ? `(${o.estimatedDays} days)`
                        : ''}{' '}
                      — ${o.flatRate.toFixed(2)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => setCheckoutOpen(false)}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={submit}
                  disabled={submitting}
                  className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  {submitting ? 'Submitting…' : 'Place order'}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
