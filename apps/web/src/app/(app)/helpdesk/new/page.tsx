'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useCreateTicket, useTicketCategories } from '@/hooks/use-tickets';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { TICKET_PRIORITIES, TICKET_PRIORITY_LABELS } from '@/lib/tickets-format';
import type { TicketPriority, TicketSubcategoryDto } from '@/lib/types';

export default function NewTicketPage() {
  const router = useRouter();
  const { toast } = useToast();
  const user = useAuthStore((s) => s.user);
  const canSubmit = !!user && hasAnyPermission(user, ['it-001:write']);

  const categoriesQuery = useTicketCategories(canSubmit);
  const create = useCreateTicket();

  const [categoryId, setCategoryId] = useState<string>('');
  const [subcategoryId, setSubcategoryId] = useState<string>('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('MEDIUM');
  const [submitting, setSubmitting] = useState(false);

  const topLevelCategories = useMemo(
    () => (categoriesQuery.data ?? []).filter((c) => c.parentCategoryId === null && c.isActive),
    [categoriesQuery.data],
  );

  const subcategories: TicketSubcategoryDto[] = useMemo(() => {
    const cat = (categoriesQuery.data ?? []).find((c) => c.id === categoryId);
    if (!cat) return [];
    return cat.subcategories.filter((s) => s.isActive);
  }, [categoriesQuery.data, categoryId]);

  // Reset subcategory when the category changes.
  useEffect(() => {
    setSubcategoryId('');
  }, [categoryId]);

  // Auto-select the first category once the list loads so the form renders
  // a valid pair without forcing the user to pick the only option.
  useEffect(() => {
    if (!categoryId && topLevelCategories.length === 1) {
      setCategoryId(topLevelCategories[0]!.id);
    }
  }, [categoryId, topLevelCategories]);

  if (!user) return null;
  if (!canSubmit) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="New ticket" />
        <EmptyState
          title="Access required"
          description="You need IT-001 write access to submit tickets."
        />
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!categoryId || !title.trim()) return;
    setSubmitting(true);
    try {
      const created = await create.mutateAsync({
        categoryId,
        subcategoryId: subcategoryId || undefined,
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
      });
      toast(
        created.assigneeName
          ? 'Submitted — auto-assigned to ' + created.assigneeName
          : 'Submitted — routed to the helpdesk queue',
        'success',
      );
      router.push('/helpdesk/' + created.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Submission failed';
      toast(msg, 'error');
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="New ticket"
        description="Tell us what's broken or what you need help with."
        actions={
          <Link href="/helpdesk" className="text-sm text-campus-700 hover:underline">
            ← Back to my tickets
          </Link>
        }
      />

      {categoriesQuery.isLoading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading categories…
        </div>
      ) : (
        <form
          onSubmit={onSubmit}
          className="space-y-5 rounded-lg border border-gray-200 bg-white p-6"
        >
          <div>
            <label htmlFor="category" className="mb-1 block text-sm font-medium text-gray-700">
              Category <span className="text-rose-600">*</span>
            </label>
            <select
              id="category"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              required
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:ring-2 focus:ring-campus-200"
            >
              <option value="">Pick a category…</option>
              {topLevelCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {subcategories.length > 0 && (
            <div>
              <label htmlFor="subcategory" className="mb-1 block text-sm font-medium text-gray-700">
                Subcategory
              </label>
              <select
                id="subcategory"
                value={subcategoryId}
                onChange={(e) => setSubcategoryId(e.target.value)}
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:ring-2 focus:ring-campus-200"
              >
                <option value="">(Optional)</option>
                {subcategories.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500">
                Picking a subcategory may auto-route the ticket to the right responder.
              </p>
            </div>
          )}

          <div>
            <label htmlFor="title" className="mb-1 block text-sm font-medium text-gray-700">
              Title <span className="text-rose-600">*</span>
            </label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              placeholder="Projector not working in Room 101"
              required
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:ring-2 focus:ring-campus-200"
            />
          </div>

          <div>
            <label htmlFor="description" className="mb-1 block text-sm font-medium text-gray-700">
              Description
            </label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={4000}
              rows={5}
              placeholder="What were you trying to do? When did it start? Anything you’ve already tried?"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:ring-2 focus:ring-campus-200"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Priority</label>
            <div className="flex flex-wrap gap-2">
              {TICKET_PRIORITIES.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={
                    'rounded-full px-3 py-1 text-sm transition ' +
                    (priority === p
                      ? 'bg-campus-700 text-white'
                      : 'bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50')
                  }
                >
                  {TICKET_PRIORITY_LABELS[p]}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Higher priorities get tighter SLAs. CRITICAL = response within 1h.
            </p>
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-gray-100 pt-4">
            <Link
              href="/helpdesk"
              className="rounded-md px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={!categoryId || !title.trim() || submitting}
              className="inline-flex items-center gap-2 rounded-md bg-campus-700 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-campus-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting && <LoadingSpinner size="sm" />}
              Submit ticket
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
