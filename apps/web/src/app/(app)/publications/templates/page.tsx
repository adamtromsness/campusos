'use client';

import { useState } from 'react';
import { PageHeader, EmptyState, Modal } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useCreateFromTemplate, useCreateTemplate, useTemplates } from '@/hooks/use-publications';
import { PUBLICATION_TYPES, PUBLICATION_TYPE_LABELS } from '@/lib/publications-format';
import { useToast } from '@/components/ui/Toast';
import { useRouter } from 'next/navigation';
import type {
  PubCreateFromTemplatePayload,
  PubCreateTemplatePayload,
  PubPublicationType,
  PubTemplateDto,
} from '@/lib/types';

export default function PublicationTemplatesPage() {
  const { user } = useAuthStore();
  const isStaff = user?.activePersona?.type === 'STAFF';
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const canManage = isAdmin || isStaff;

  const templatesQ = useTemplates(false);
  const create = useCreateTemplate();
  const { toast } = useToast();
  const router = useRouter();

  const [showCreate, setShowCreate] = useState(false);
  const [pickedTemplate, setPickedTemplate] = useState<PubTemplateDto | null>(null);

  const systemTemplates = (templatesQ.data ?? []).filter((t) => t.isSystem);
  const customTemplates = (templatesQ.data ?? []).filter((t) => !t.isSystem);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Publication Templates"
        description="Start a new publication from a pre-populated section structure."
        actions={
          canManage ? (
            <button
              type="button"
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-700"
              onClick={() => setShowCreate(true)}
            >
              New custom template
            </button>
          ) : undefined
        }
      />

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          System templates
        </h2>
        <p className="mb-3 text-xs text-gray-500">
          Platform-seeded templates available in every school. Read-only — only the platform team
          can modify these.
        </p>
        {systemTemplates.length === 0 ? (
          <EmptyState
            title="No system templates available"
            description="System templates ship via the platform seeder."
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {systemTemplates.map((t) => (
              <li key={t.id} className="rounded-md border border-blue-200 bg-blue-50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-base font-semibold text-blue-900">{t.name}</p>
                    {t.description && <p className="mt-1 text-sm text-gray-700">{t.description}</p>}
                    <p className="mt-2 text-xs text-blue-700">
                      {PUBLICATION_TYPE_LABELS[t.publicationType]} ·{' '}
                      {Array.isArray((t.templateContent as { sections?: unknown[] }).sections)
                        ? `${(t.templateContent as { sections: unknown[] }).sections.length} sections`
                        : '0 sections'}
                    </p>
                  </div>
                  <span className="rounded bg-blue-200 px-2 py-0.5 text-xs font-semibold text-blue-800">
                    System
                  </span>
                </div>
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    className="text-sm font-semibold text-blue-700 hover:underline"
                    onClick={() => setPickedTemplate(t)}
                  >
                    Use template →
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Custom templates
        </h2>
        {customTemplates.length === 0 ? (
          <EmptyState
            title="No custom templates yet"
            description="Schools can author their own templates alongside the platform catalogue."
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {customTemplates.map((t) => (
              <li key={t.id} className="rounded-md border border-gray-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-base font-semibold text-campus-700">{t.name}</p>
                    {t.description && <p className="mt-1 text-sm text-gray-700">{t.description}</p>}
                    <p className="mt-2 text-xs text-gray-500">
                      {PUBLICATION_TYPE_LABELS[t.publicationType]} ·{' '}
                      {Array.isArray((t.templateContent as { sections?: unknown[] }).sections)
                        ? `${(t.templateContent as { sections: unknown[] }).sections.length} sections`
                        : '0 sections'}
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    className="text-sm font-semibold text-campus-700 hover:underline"
                    onClick={() => setPickedTemplate(t)}
                  >
                    Use template →
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {showCreate && canManage && (
        <CreateTemplateModal
          onClose={() => setShowCreate(false)}
          onSubmit={async (payload) => {
            try {
              await create.mutateAsync(payload);
              toast(`Created template "${payload.name}"`, 'success');
              setShowCreate(false);
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Failed to create template', 'error');
            }
          }}
          submitting={create.isPending}
        />
      )}

      {pickedTemplate && (
        <UseTemplateModal
          template={pickedTemplate}
          onClose={() => setPickedTemplate(null)}
          onCreated={(publicationId) => {
            toast('Publication created from template', 'success');
            setPickedTemplate(null);
            router.push(`/publications/${publicationId}`);
          }}
        />
      )}
    </div>
  );
}

function CreateTemplateModal({
  onClose,
  onSubmit,
  submitting,
}: {
  onClose: () => void;
  onSubmit: (payload: PubCreateTemplatePayload) => Promise<void>;
  submitting: boolean;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [publicationType, setPublicationType] = useState<PubPublicationType>('NEWSLETTER');
  const [sectionTitles, setSectionTitles] = useState("Principal's Message\nUpcoming Events");

  const sections = sectionTitles
    .split('\n')
    .map((line, index) => ({ title: line.trim(), sortOrder: index, ownerHint: 'STAFF' }))
    .filter((s) => s.title.length > 0);

  return (
    <Modal
      open={true}
      title="New custom template"
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!name.trim() || sections.length === 0 || submitting}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-700 disabled:opacity-50"
            onClick={() =>
              onSubmit({
                name: name.trim(),
                description: description.trim() || undefined,
                publicationType,
                templateContent: { sections },
                isActive: true,
              })
            }
          >
            {submitting ? 'Creating…' : 'Create template'}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="block text-sm">
          <span className="text-gray-700">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            placeholder="School Quarterly"
          />
        </label>
        <label className="block text-sm">
          <span className="text-gray-700">Description</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-gray-700">Publication type</span>
          <select
            value={publicationType}
            onChange={(e) => setPublicationType(e.target.value as PubPublicationType)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          >
            {PUBLICATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {PUBLICATION_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-gray-700">Sections (one title per line)</span>
          <textarea
            value={sectionTitles}
            onChange={(e) => setSectionTitles(e.target.value)}
            rows={6}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </label>
      </div>
    </Modal>
  );
}

function UseTemplateModal({
  template,
  onClose,
  onCreated,
}: {
  template: PubTemplateDto;
  onClose: () => void;
  onCreated: (publicationId: string) => void;
}) {
  const [title, setTitle] = useState('');
  const fromTemplate = useCreateFromTemplate(template.id);
  const { toast } = useToast();
  const sections = Array.isArray((template.templateContent as { sections?: unknown[] }).sections)
    ? ((template.templateContent as { sections: Array<{ title?: string }> }).sections ?? [])
    : [];

  return (
    <Modal
      open={true}
      title={`Use "${template.name}"`}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!title.trim() || fromTemplate.isPending}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-campus-700 disabled:opacity-50"
            onClick={async () => {
              try {
                const payload: PubCreateFromTemplatePayload = { title: title.trim() };
                const created = await fromTemplate.mutateAsync(payload);
                onCreated(created.id);
              } catch (err) {
                toast(
                  err instanceof Error ? err.message : 'Failed to create from template',
                  'error',
                );
              }
            }}
          >
            {fromTemplate.isPending ? 'Creating…' : 'Create publication'}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="block text-sm">
          <span className="text-gray-700">Title for the new publication</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={300}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            placeholder="Spring Newsletter — May 2026"
          />
        </label>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Sections that will be created
          </p>
          <ul className="mt-1 space-y-1">
            {sections.map((s, i) => (
              <li
                key={i}
                className="rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-700"
              >
                {i + 1}. {s.title ?? 'Untitled section'}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
}
