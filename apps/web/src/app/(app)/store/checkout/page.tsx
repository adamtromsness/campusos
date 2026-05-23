'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader, useToast } from '@/components/ui';
import { useAuthStore } from '@/lib/auth-store';
import { formatCurrency } from '@/lib/store-format';
import { useCreateOrder, useProducts, useStores } from '@/hooks/use-store';

interface CartItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
}

export default function CheckoutPage() {
  const router = useRouter();
  const search = useSearchParams();
  const initialStoreId = search?.get('storeId') ?? null;
  const user = useAuthStore((s) => s.user);
  const { toast } = useToast();
  const stores = useStores();
  const [storeId, setStoreId] = useState<string>(initialStoreId ?? '');
  const products = useProducts(storeId || null);
  const create = useCreateOrder();
  const [cart, setCart] = useState<CartItem[]>([]);
  const [studentId, setStudentId] = useState<string>(''); // student picks own (auto) or admin picks for someone

  useEffect(() => {
    if (!storeId && (stores.data ?? []).length > 0) {
      const studentStore = (stores.data ?? []).find((s) => s.storeType === 'STUDENT');
      if (studentStore) setStoreId(studentStore.id);
    }
  }, [stores.data, storeId]);

  const subtotal = useMemo(() => cart.reduce((s, c) => s + c.price * c.quantity, 0), [cart]);

  const addToCart = (productId: string, name: string, price: number) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.productId === productId);
      if (existing) {
        return prev.map((c) =>
          c.productId === productId ? { ...c, quantity: c.quantity + 1 } : c,
        );
      }
      return [...prev, { productId, name, price, quantity: 1 }];
    });
  };

  const setQty = (productId: string, qty: number) => {
    if (qty <= 0) {
      setCart((prev) => prev.filter((c) => c.productId !== productId));
    } else {
      setCart((prev) => prev.map((c) => (c.productId === productId ? { ...c, quantity: qty } : c)));
    }
  };

  const submit = async () => {
    if (cart.length === 0) {
      toast('Add at least one item', 'error');
      return;
    }
    if (user?.activePersona?.type === 'STUDENT' && !studentId) {
      // Student places order on their own behalf — backend resolves student via personId
      // Need the student id — fetch via /students/me
      try {
        const resp = await fetch('/api/v1/students/me', {
          credentials: 'include',
          headers: {
            'X-Tenant-Subdomain': 'demo',
          },
        });
        if (resp.ok) {
          const me = await resp.json();
          setStudentId(me.id);
        }
      } catch (_err) {
        // continue anyway, the backend will surface the error
      }
    }
    try {
      await create.mutateAsync({
        storeId,
        orderType: 'STUDENT',
        studentId: studentId || undefined,
        shippingMethod: 'PICKUP',
        lines: cart.map((c) => ({ productId: c.productId, quantity: c.quantity })),
      });
      toast('Order submitted — pending parent approval', 'success');
      router.push('/store');
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Order failed', 'error');
    }
  };

  return (
    <div>
      <PageHeader
        title="Checkout"
        description="Add items to your order. Student orders require parent approval before payment is charged."
        actions={
          <Link href="/store" className="text-sm text-campus-600 hover:underline">
            ← Back to store
          </Link>
        }
      />

      <div className="mb-5 rounded-card border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
        <strong>Parent approval required.</strong> Your order will be created in PENDING_APPROVAL
        status. Your parent must approve before payment is charged to the family account. Items are
        reserved against inventory once the order is placed.
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h2 className="mb-2 text-sm font-semibold text-gray-700">Catalogue</h2>
          {products.isLoading ? (
            <div className="text-sm text-gray-500">Loading…</div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {(products.data ?? []).map((p) => (
                <div
                  key={p.id}
                  className="rounded-card border border-gray-200 bg-white p-3 shadow-sm"
                >
                  <div className="mb-1 flex items-center justify-between">
                    <div className="font-medium text-gray-900">{p.name}</div>
                    <div className="text-sm font-semibold text-campus-700">
                      {formatCurrency(p.price)}
                    </div>
                  </div>
                  {p.description && (
                    <p className="mb-2 text-xs text-gray-600 line-clamp-2">{p.description}</p>
                  )}
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-gray-500">
                      {p.totalAvailable > 0 ? `${p.totalAvailable} in stock` : 'Out of stock'}
                    </div>
                    <button
                      type="button"
                      onClick={() => addToCart(p.id, p.name, p.price)}
                      disabled={p.totalAvailable === 0 && !p.backorderAllowed}
                      className="rounded-md bg-campus-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Add to order
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h2 className="mb-2 text-sm font-semibold text-gray-700">Your order</h2>
          {cart.length === 0 ? (
            <div className="rounded-md border border-dashed border-gray-200 px-4 py-6 text-center text-sm text-gray-500">
              No items yet — add from the catalogue.
            </div>
          ) : (
            <div className="rounded-card border border-gray-200 bg-white p-3 shadow-sm">
              <ul className="space-y-2">
                {cart.map((c) => (
                  <li key={c.productId} className="text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-gray-900">{c.name}</span>
                      <button
                        type="button"
                        onClick={() => setQty(c.productId, 0)}
                        className="text-xs text-rose-600 hover:underline"
                      >
                        Remove
                      </button>
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <input
                        type="number"
                        min={1}
                        value={c.quantity}
                        onChange={(e) => setQty(c.productId, Math.max(0, Number(e.target.value)))}
                        className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm"
                      />
                      <span className="text-sm font-medium text-gray-700">
                        {formatCurrency(c.price * c.quantity)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-3 border-t border-gray-100 pt-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">Subtotal</span>
                  <span className="font-semibold">{formatCurrency(subtotal)}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={submit}
                disabled={create.isPending || cart.length === 0}
                className="mt-3 w-full rounded-md bg-campus-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {create.isPending ? 'Submitting…' : 'Place order'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
