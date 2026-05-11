'use client';

import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import {
  useAwardPoints,
  useBehaviourRewards,
  useCreateReward,
  useRedeemReward,
  usePositiveCategories,
  useStudentPointsBalance,
  type BehaviourRewardType,
} from '@/hooks/use-behaviour-advanced';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';

const REWARD_TYPE_LABEL: Record<BehaviourRewardType, string> = {
  INDIVIDUAL: 'Individual',
  CLASS: 'Class',
  DIGITAL: 'Digital',
  PHYSICAL: 'Physical',
};

export default function PositiveBehaviourPage() {
  const { user } = useAuthStore();
  const canAward = hasAnyPermission(user, ['beh-001:write', 'beh-001:admin']);
  const canAdmin = hasAnyPermission(user, ['beh-001:admin']);

  const [awardOpen, setAwardOpen] = useState(false);
  const [awardStudent, setAwardStudent] = useState('');
  const [awardCategory, setAwardCategory] = useState('');
  const [awardPointsVal, setAwardPointsVal] = useState(5);
  const [awardReason, setAwardReason] = useState('');

  const [rewardModalOpen, setRewardModalOpen] = useState(false);
  const [rewardName, setRewardName] = useState('');
  const [rewardCost, setRewardCost] = useState(50);
  const [rewardType, setRewardType] = useState<BehaviourRewardType>('INDIVIDUAL');
  const [rewardDesc, setRewardDesc] = useState('');
  const [rewardQty, setRewardQty] = useState('');

  const [redeemFor, setRedeemFor] = useState('');
  const [balanceStudent, setBalanceStudent] = useState('');

  const categories = usePositiveCategories();
  const rewards = useBehaviourRewards();
  const balance = useStudentPointsBalance(balanceStudent || null);
  const award = useAwardPoints();
  const create = useCreateReward();
  const redeem = useRedeemReward();
  const { toast } = useToast();

  async function submitAward() {
    try {
      await award.mutateAsync({
        studentId: awardStudent,
        category: awardCategory,
        points: awardPointsVal,
        reason: awardReason,
      });
      toast('Points awarded', 'success');
      setAwardOpen(false);
      setAwardStudent('');
      setAwardCategory('');
      setAwardPointsVal(5);
      setAwardReason('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  async function submitReward() {
    try {
      await create.mutateAsync({
        rewardName,
        description: rewardDesc || undefined,
        pointsCost: rewardCost,
        rewardType,
        quantityAvailable: rewardQty ? Number(rewardQty) : undefined,
      });
      toast('Reward created', 'success');
      setRewardModalOpen(false);
      setRewardName('');
      setRewardDesc('');
      setRewardCost(50);
      setRewardType('INDIVIDUAL');
      setRewardQty('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  async function submitRedeem(rewardId: string) {
    try {
      const r = await redeem.mutateAsync({ rewardId, studentId: redeemFor });
      toast(`Redeemed for ${r.pointsSpent} pts — new balance ${r.newBalance}`, 'success');
      setRedeemFor('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Positive behaviour"
        description="Award points for good conduct, redeem rewards from the marketplace."
        actions={
          canAward ? (
            <button
              type="button"
              onClick={() => setAwardOpen(true)}
              className="rounded-md bg-campus-700 px-4 py-2 text-sm font-medium text-white"
            >
              Award points
            </button>
          ) : null
        }
      />

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="font-medium text-gray-900 mb-3">Student point balance</h2>
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={balanceStudent}
            onChange={(e) => setBalanceStudent(e.target.value)}
            placeholder="Student UUID"
            className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        {balance.isLoading ? (
          <LoadingSpinner />
        ) : balance.data ? (
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-md bg-emerald-50 p-3">
                <div className="text-xs text-gray-600">Awarded</div>
                <div className="text-2xl font-bold text-emerald-700">{balance.data.awarded}</div>
              </div>
              <div className="rounded-md bg-rose-50 p-3">
                <div className="text-xs text-gray-600">Redeemed</div>
                <div className="text-2xl font-bold text-rose-700">{balance.data.redeemed}</div>
              </div>
              <div className="rounded-md bg-campus-50 p-3">
                <div className="text-xs text-gray-600">Balance</div>
                <div className="text-2xl font-bold text-campus-700">{balance.data.balance}</div>
              </div>
            </div>
            <ul className="mt-3 text-sm space-y-1">
              {balance.data.history.slice(0, 10).map((tx) => (
                <li key={tx.id} className="flex justify-between border-b border-gray-100 py-1">
                  <span
                    className={
                      tx.transactionType === 'AWARD' ? 'text-emerald-700' : 'text-rose-700'
                    }
                  >
                    {tx.transactionType === 'AWARD' ? '+' : '−'}
                    {tx.points} {tx.category ?? tx.rewardName}
                  </span>
                  <span className="text-xs text-gray-500">{tx.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium text-gray-900">Rewards marketplace</h2>
          {canAdmin ? (
            <button
              type="button"
              onClick={() => setRewardModalOpen(true)}
              className="text-sm text-campus-700 hover:underline"
            >
              + New reward
            </button>
          ) : null}
        </div>
        <div className="mb-3 flex gap-2">
          <input
            type="text"
            value={redeemFor}
            onChange={(e) => setRedeemFor(e.target.value)}
            placeholder="Student UUID to redeem for"
            className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        {rewards.isLoading ? (
          <LoadingSpinner />
        ) : rewards.data && rewards.data.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {rewards.data.map((r) => (
              <div key={r.id} className="rounded-md border border-gray-200 p-3">
                <div className="flex justify-between gap-2">
                  <strong>{r.rewardName}</strong>
                  <span className="text-xs rounded-full bg-violet-100 text-violet-700 px-2 py-0.5">
                    {REWARD_TYPE_LABEL[r.rewardType]}
                  </span>
                </div>
                {r.description ? (
                  <p className="mt-1 text-xs text-gray-600">{r.description}</p>
                ) : null}
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-sm text-gray-700">{r.pointsCost} pts</span>
                  <span className="text-xs text-gray-500">
                    {r.quantityAvailable === null ? 'Unlimited' : `${r.quantityAvailable} left`}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={!redeemFor}
                  onClick={() => submitRedeem(r.id)}
                  className="mt-2 w-full rounded-md bg-campus-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  Redeem
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">No rewards configured.</p>
        )}
      </section>

      <Modal
        open={awardOpen}
        onClose={() => setAwardOpen(false)}
        title="Award positive behaviour points"
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAwardOpen(false)}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitAward}
              disabled={!awardStudent || !awardCategory || !awardReason || awardPointsVal < 1}
              className="rounded-md bg-campus-700 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Award
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <label className="block">
            <span className="text-sm">Student UUID</span>
            <input
              type="text"
              value={awardStudent}
              onChange={(e) => setAwardStudent(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm">Category</span>
            <select
              value={awardCategory}
              onChange={(e) => {
                setAwardCategory(e.target.value);
                const c = categories.data?.find((x) => x.name === e.target.value);
                if (c) setAwardPointsVal(c.defaultPoints);
              }}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">Select category…</option>
              {categories.data?.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.defaultPoints} pts default)
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-sm">Points</span>
            <input
              type="number"
              min={1}
              value={awardPointsVal}
              onChange={(e) => setAwardPointsVal(Number(e.target.value))}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm">Reason</span>
            <textarea
              value={awardReason}
              onChange={(e) => setAwardReason(e.target.value)}
              rows={2}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </Modal>

      <Modal
        open={rewardModalOpen}
        onClose={() => setRewardModalOpen(false)}
        title="New reward"
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setRewardModalOpen(false)}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitReward}
              disabled={!rewardName || rewardCost < 1}
              className="rounded-md bg-campus-700 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Create
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <label className="block">
            <span className="text-sm">Reward name</span>
            <input
              value={rewardName}
              onChange={(e) => setRewardName(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm">Description</span>
            <textarea
              value={rewardDesc}
              onChange={(e) => setRewardDesc(e.target.value)}
              rows={2}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm">Points cost</span>
            <input
              type="number"
              min={1}
              value={rewardCost}
              onChange={(e) => setRewardCost(Number(e.target.value))}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm">Reward type</span>
            <select
              value={rewardType}
              onChange={(e) => setRewardType(e.target.value as BehaviourRewardType)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="INDIVIDUAL">Individual</option>
              <option value="CLASS">Class</option>
              <option value="DIGITAL">Digital</option>
              <option value="PHYSICAL">Physical</option>
            </select>
          </label>
          <label className="block">
            <span className="text-sm">Quantity available (blank = unlimited)</span>
            <input
              type="number"
              min={0}
              value={rewardQty}
              onChange={(e) => setRewardQty(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </Modal>
    </div>
  );
}
