'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { cn } from './cn';

type ToastVariant = 'info' | 'success' | 'warning' | 'error';

interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  toast: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, variant: ToastVariant = 'info') => {
      const id = Date.now() + Math.random();
      setToasts((current) => [...current, { id, message, variant }]);
      setTimeout(() => dismiss(id), 4000);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onClose={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const variantClass = {
    info: 'bg-campus-700 text-white',
    success: 'bg-success text-white',
    warning: 'bg-warning text-white',
    error: 'bg-danger text-white',
  }[toast.variant];

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex items-start justify-between gap-3 rounded-card px-4 py-3 shadow-elevated',
        variantClass,
      )}
    >
      <p className="text-sm">{toast.message}</p>
      <button
        type="button"
        onClick={onClose}
        className="text-white/80 hover:text-white"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
