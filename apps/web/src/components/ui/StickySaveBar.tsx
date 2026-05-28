'use client';

import { cn } from '@/components/ui/cn';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

/**
 * Viewport-fixed save bar for long tabbed forms. Renders nothing
 * until there are unsaved changes, then slides a bar across the
 * bottom of the screen with Discard + Save Changes — so the user
 * never has to hunt for the save button on a long page.
 *
 * Position is `fixed`, so it doesn't matter where in the tree it's
 * rendered — it always pins to the bottom of the viewport. Inner
 * content is centered to max-w-3xl to line up with the page columns.
 */
export function StickySaveBar({
  isDirty,
  onSave,
  onDiscard,
  saving = false,
  label = 'Unsaved changes',
}: {
  isDirty: boolean;
  onSave: () => void;
  onDiscard: () => void;
  saving?: boolean;
  label?: string;
}) {
  if (!isDirty) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white/95 shadow-[0_-2px_10px_rgba(0,0,0,0.07)] backdrop-blur">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3">
        <span className="text-sm font-medium text-gray-700">{label}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onDiscard}
            disabled={saving}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:opacity-60"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className={cn(
              'inline-flex items-center justify-center gap-2 rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-campus-600 disabled:opacity-60',
            )}
          >
            {saving && <LoadingSpinner size="sm" />}
            <span>{saving ? 'Saving…' : 'Save Changes'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
