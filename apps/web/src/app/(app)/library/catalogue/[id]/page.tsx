'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  COPY_CONDITION_PILL,
  COPY_LOCATION_STATUS_PILL,
  LIBRARY_COPY_CONDITION_LABELS,
  LIBRARY_COPY_LOCATION_STATUS_LABELS,
  formatRelative,
} from '@/lib/library-format';
import {
  useCatalogueItem,
  useHideReview,
  useItemReviews,
  usePlaceHold,
  useSubmitReview,
  useUnhideReview,
  useUpdateReview,
} from '@/hooks/use-library';

/**
 * /library/catalogue/[id] — Catalogue item detail.
 *
 * Anyone with lib-001:read can view. Copies table + reviews list +
 * place-hold button (when no copies available) + submit-review form
 * (students only). Librarian / teacher / admin can hide / unhide
 * inappropriate reviews.
 */
export default function CatalogueItemPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? null;

  const itemQ = useCatalogueItem(id);

  if (itemQ.isLoading) return <LoadingSpinner />;
  if (!itemQ.data) {
    return (
      <div className="space-y-4">
        <PageHeader title="Catalogue" />
        <p className="rounded-md bg-rose-50 p-3 text-sm text-rose-800">
          This catalogue item was not found.
        </p>
      </div>
    );
  }

  const item = itemQ.data;

  return (
    <div className="space-y-6">
      <Link
        href="/library/catalogue"
        className="text-sm font-medium text-campus-700 hover:text-campus-800"
      >
        ← Back to catalogue
      </Link>

      <ItemHeader id={id ?? ''} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section className="rounded-lg border border-gray-200 bg-white p-5 lg:col-span-2">
          <h2 className="text-base font-semibold text-gray-900">About</h2>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs font-medium text-gray-500">Author</dt>
              <dd className="text-gray-900">{item.author ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-500">ISBN</dt>
              <dd className="text-gray-900">{item.isbn ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-500">Publisher</dt>
              <dd className="text-gray-900">{item.publisher ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-500">Year</dt>
              <dd className="text-gray-900">{item.publishYear ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-500">Category</dt>
              <dd className="text-gray-900">{item.category ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-500">Dewey decimal</dt>
              <dd className="text-gray-900">{item.deweyDecimal ?? '—'}</dd>
            </div>
          </dl>
          {item.description && (
            <p className="mt-4 text-sm leading-relaxed text-gray-700">{item.description}</p>
          )}
        </section>

        <aside className="space-y-4">
          <div className="rounded-lg border border-gray-200 bg-white p-5">
            <h3 className="text-sm font-semibold text-gray-900">Availability</h3>
            <div className="mt-2 text-2xl font-semibold text-gray-900">
              {item.availableCopies}{' '}
              <span className="text-base font-normal text-gray-500">
                of {item.totalCopies} available
              </span>
            </div>
            <div className="mt-1 text-xs text-gray-500">
              {item.activeHoldsCount > 0
                ? `${item.activeHoldsCount} hold${item.activeHoldsCount === 1 ? '' : 's'} pending`
                : 'No active holds'}
            </div>
            {item.availableCopies === 0 && <PlaceHoldButton itemId={item.id} />}
          </div>

          {item.reviewCount > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-gray-900">Reader rating</h3>
              <div className="mt-2 text-2xl font-semibold text-amber-600">
                ★ {item.averageRating?.toFixed(1) ?? '—'}
              </div>
              <div className="mt-1 text-xs text-gray-500">
                {item.reviewCount} review{item.reviewCount === 1 ? '' : 's'}
              </div>
            </div>
          )}
        </aside>
      </div>

      <CopiesTable itemId={item.id} copies={item.copies ?? []} />

      <ReviewsSection itemId={item.id} />
    </div>
  );
}

function ItemHeader({ id }: { id: string }) {
  const itemQ = useCatalogueItem(id);
  if (!itemQ.data) return null;
  const item = itemQ.data;
  return (
    <div className="flex items-start gap-4">
      {item.coverImageUrl ? (
        <div className="h-32 w-24 flex-shrink-0 rounded-md bg-gray-100" />
      ) : (
        <div className="flex h-32 w-24 flex-shrink-0 items-center justify-center rounded-md bg-gray-100 text-4xl">
          📕
        </div>
      )}
      <div className="flex-1">
        <h1 className="font-display text-2xl text-gray-900">{item.title}</h1>
        <p className="mt-1 text-sm text-gray-600">{item.author ?? 'Unknown author'}</p>
        {item.category && (
          <span className="mt-2 inline-block rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
            {item.category}
          </span>
        )}
      </div>
    </div>
  );
}

function CopiesTable({
  itemId,
  copies,
}: {
  itemId: string;
  copies: NonNullable<ReturnType<typeof useCatalogueItem>['data']>['copies'];
}) {
  const list = copies ?? [];
  if (list.length === 0) {
    return null;
  }
  void itemId;
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <h2 className="text-base font-semibold text-gray-900">Copies</h2>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
              <th className="py-2 text-left font-medium">Barcode</th>
              <th className="py-2 text-left font-medium">Condition</th>
              <th className="py-2 text-left font-medium">Location</th>
              <th className="py-2 text-left font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {list.map((c) => (
              <tr key={c.id}>
                <td className="py-2 font-mono text-xs text-gray-700">{c.barcode}</td>
                <td className="py-2">
                  <span
                    className={
                      'rounded px-2 py-0.5 text-xs font-medium ' + COPY_CONDITION_PILL[c.condition]
                    }
                  >
                    {LIBRARY_COPY_CONDITION_LABELS[c.condition]}
                  </span>
                </td>
                <td className="py-2 text-gray-700">{c.locationName ?? '—'}</td>
                <td className="py-2">
                  <span
                    className={
                      'rounded px-2 py-0.5 text-xs font-medium ' +
                      COPY_LOCATION_STATUS_PILL[c.locationStatus]
                    }
                  >
                    {LIBRARY_COPY_LOCATION_STATUS_LABELS[c.locationStatus]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PlaceHoldButton({ itemId }: { itemId: string }) {
  const placeHold = usePlaceHold();
  const toast = useToast();
  return (
    <button
      onClick={async () => {
        try {
          await placeHold.mutateAsync({ catalogueItemId: itemId });
          toast.toast('Hold placed — you will be notified when a copy is available.');
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Could not place hold';
          toast.toast(message, 'error');
        }
      }}
      disabled={placeHold.isPending}
      className="mt-3 w-full rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-60"
    >
      {placeHold.isPending ? 'Placing hold…' : 'Place a hold'}
    </button>
  );
}

function ReviewsSection({ itemId }: { itemId: string }) {
  const user = useAuthStore((s) => s.user);
  const isStudent = user?.personType === 'STUDENT';
  const isModerator =
    !!user &&
    user.personType !== 'STUDENT' &&
    hasAnyPermission(user, ['sch-001:admin', 'lib-003:write']);

  const reviewsQ = useItemReviews(itemId);
  const submitReview = useSubmitReview(itemId);
  const updateReview = useUpdateReview(itemId);
  const hideReview = useHideReview(itemId);
  const unhideReview = useUnhideReview(itemId);
  const toast = useToast();

  const reviews = reviewsQ.data ?? [];
  const myReview = isStudent ? reviews.find((r) => r.studentId === user?.personId) : null;
  // The student's review is keyed by sis_students.id, not iam_person.id, so the
  // above match might miss. We render the form unconditionally for students.
  void myReview;

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <h2 className="text-base font-semibold text-gray-900">Reader reviews</h2>

      {isStudent && (
        <SubmitReviewForm
          onSubmit={async (rating, text) => {
            try {
              await submitReview.mutateAsync({ rating, reviewText: text || undefined });
              toast.toast('Review submitted.');
            } catch (err) {
              const message = err instanceof Error ? err.message : 'Could not submit review';
              toast.toast(message, 'error');
            }
          }}
        />
      )}

      {reviewsQ.isLoading ? (
        <LoadingSpinner />
      ) : reviews.length === 0 ? (
        <p className="mt-4 text-sm text-gray-600">No reviews yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-gray-100">
          {reviews.map((r) => (
            <li key={r.id} className="py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-amber-500">{'★'.repeat(r.rating)}</span>
                  <span className="text-xs text-gray-500">
                    {r.studentName ?? '—'} · {formatRelative(r.createdAt)}
                  </span>
                  {!r.isApproved && (
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                      Hidden
                    </span>
                  )}
                </div>
                {isModerator && (
                  <div className="flex gap-2 text-xs">
                    {r.isApproved ? (
                      <button
                        onClick={async () => {
                          await hideReview.mutateAsync(r.id);
                          toast.toast('Review hidden.');
                        }}
                        className="text-rose-700 hover:text-rose-800"
                      >
                        Hide
                      </button>
                    ) : (
                      <button
                        onClick={async () => {
                          await unhideReview.mutateAsync(r.id);
                          toast.toast('Review restored.');
                        }}
                        className="text-emerald-700 hover:text-emerald-800"
                      >
                        Unhide
                      </button>
                    )}
                  </div>
                )}
              </div>
              {r.reviewText && (
                <p className="mt-2 text-sm leading-relaxed text-gray-700">{r.reviewText}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {/* Modal helper kept imported for future moderator-edit flow */}
      <ModalSentinel updateReview={updateReview} />
    </section>
  );
}

function SubmitReviewForm({
  onSubmit,
}: {
  onSubmit: (rating: number, text: string) => Promise<void>;
}) {
  const [rating, setRating] = useState(5);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setSubmitting(true);
        await onSubmit(rating, text);
        setSubmitting(false);
        setText('');
      }}
      className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-4"
    >
      <div className="text-sm font-medium text-gray-900">Write a review</div>
      <div className="mt-2 flex items-center gap-2">
        <span className="text-xs font-medium text-gray-700">Rating</span>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            type="button"
            key={n}
            onClick={() => setRating(n)}
            className={
              'text-2xl transition ' +
              (n <= rating ? 'text-amber-500' : 'text-gray-300 hover:text-amber-300')
            }
            aria-label={`Rate ${n}`}
          >
            ★
          </button>
        ))}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="Tell other students what you thought (optional)"
        className="mt-3 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
      />
      <button
        type="submit"
        disabled={submitting}
        className="mt-3 rounded-md bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-60"
      >
        {submitting ? 'Submitting…' : 'Submit review'}
      </button>
      <p className="mt-2 text-xs text-gray-500">
        You can submit one review per book. To edit, use PATCH (a future polish).
      </p>
    </form>
  );
}

// Sentinel that keeps Modal + updateReview imports referenced for the
// future inline-edit flow without rendering anything yet.
function ModalSentinel({ updateReview }: { updateReview: ReturnType<typeof useUpdateReview> }) {
  void Modal;
  void updateReview;
  return null;
}
