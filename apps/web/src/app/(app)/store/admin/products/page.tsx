'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Modal, PageHeader, useToast } from '@/components/ui';
import { formatCurrency, stockBadge } from '@/lib/store-format';
import { useCreateProduct, useProducts, useStores, useUpdateProduct } from '@/hooks/use-store';
import type { StrCreateProductPayload, StrProductDto } from '@/lib/types';

export default function AdminProductsPage() {
  const { toast } = useToast();
  const stores = useStores();
  const [storeId, setStoreId] = useState<string>('');
  const products = useProducts(storeId || null, { includeInactive: true });
  const create = useCreateProduct();
  const update = useUpdateProduct();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<StrProductDto | null>(null);
  const [form, setForm] = useState<StrCreateProductPayload>(blankForm());

  function blankForm(): StrCreateProductPayload {
    return {
      storeId: '',
      name: '',
      sku: '',
      category: '',
      price: 0,
      cost: 0,
      backorderAllowed: false,
    };
  }

  const targetStore = useMemo(
    () => stores.data?.find((s) => s.id === storeId),
    [stores.data, storeId],
  );

  const open = (p: StrProductDto | null) => {
    setEditing(p);
    if (p) {
      setForm({
        storeId: p.storeId,
        name: p.name,
        description: p.description ?? undefined,
        sku: p.sku ?? '',
        category: p.category ?? '',
        price: p.price,
        cost: p.cost ?? undefined,
        backorderAllowed: p.backorderAllowed,
      });
    } else {
      setForm({ ...blankForm(), storeId });
    }
    setModalOpen(true);
  };

  const submit = async () => {
    if (!form.name) {
      toast('Name is required', 'error');
      return;
    }
    try {
      if (editing) {
        await update.mutateAsync({
          id: editing.id,
          payload: {
            name: form.name,
            description: form.description,
            sku: form.sku,
            category: form.category,
            price: form.price,
            cost: form.cost,
            backorderAllowed: form.backorderAllowed,
          },
        });
        toast('Product updated', 'success');
      } else {
        await create.mutateAsync(form);
        toast('Product created', 'success');
      }
      setModalOpen(false);
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Save failed', 'error');
    }
  };

  return (
    <div>
      <PageHeader
        title="Manage products"
        description="Add and edit products + SKUs. Inventory adjustments live on the Inventory page."
        actions={
          <Link href="/store" className="text-sm text-campus-600 hover:underline">
            ← Store
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3 rounded-card border border-gray-200 bg-white p-4 shadow-sm">
        <label className="text-sm">
          <div className="mb-1 font-medium text-gray-700">Store</div>
          <select
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">— select —</option>
            {(stores.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.storeType} · {s.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => open(null)}
          disabled={!storeId}
          className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          + New product
        </button>
      </div>

      {storeId && targetStore && products.data && (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>
                <Th>Name</Th>
                <Th>SKU</Th>
                <Th>Category</Th>
                <Th className="text-right">Price</Th>
                <Th className="text-right">Cost</Th>
                <Th className="text-right">In stock</Th>
                <Th>Backorder</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {products.data.map((p) => {
                const badge = stockBadge(p.totalAvailable, p.inventory[0]?.reorderPoint ?? 0);
                return (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <Td>{p.name}</Td>
                    <Td>{p.sku ?? '—'}</Td>
                    <Td>{p.category ?? '—'}</Td>
                    <Td className="text-right">{formatCurrency(p.price)}</Td>
                    <Td className="text-right">{formatCurrency(p.cost)}</Td>
                    <Td className="text-right">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${badge.className}`}
                      >
                        {p.totalAvailable}
                      </span>
                    </Td>
                    <Td>{p.backorderAllowed ? '✓' : '—'}</Td>
                    <Td>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          p.isActive
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-gray-200 text-gray-700'
                        }`}
                      >
                        {p.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </Td>
                    <Td>
                      <button
                        type="button"
                        onClick={() => open(p)}
                        className="text-sm text-campus-700 hover:underline"
                      >
                        Edit
                      </button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Edit product' : 'New product'}
        size="lg"
        footer={
          <>
            <button
              onClick={() => setModalOpen(false)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={create.isPending || update.isPending}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {editing ? 'Save changes' : 'Create'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Name" required>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Description">
            <textarea
              value={form.description ?? ''}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="SKU">
              <input
                value={form.sku ?? ''}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </Field>
            <Field label="Category">
              <input
                value={form.category ?? ''}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </Field>
            <Field label="Price" required>
              <input
                type="number"
                step="0.01"
                min={0}
                value={form.price}
                onChange={(e) => setForm({ ...form, price: Number(e.target.value) })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Cost">
              <input
                type="number"
                step="0.01"
                min={0}
                value={form.cost ?? 0}
                onChange={(e) => setForm({ ...form, cost: Number(e.target.value) })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </Field>
            <label className="flex items-end gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.backorderAllowed ?? false}
                onChange={(e) => setForm({ ...form, backorderAllowed: e.target.checked })}
              />
              <span>Allow backorder when out of stock</span>
            </label>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <div className="mb-1 font-medium text-gray-700">
        {label}
        {required && <span className="ml-1 text-rose-600">*</span>}
      </div>
      {children}
    </label>
  );
}

function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <td className={`whitespace-nowrap px-4 py-2.5 text-sm text-gray-700 ${className}`}>
      {children}
    </td>
  );
}
