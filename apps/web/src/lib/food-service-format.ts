import type {
  FdsAllergenSeverity,
  FdsDietaryMealPlan,
  FdsDietaryUpdateChangeType,
  FdsDietaryUpdateStatus,
  FdsEligibilityCategory,
  FdsEligibilityStatus,
  FdsMealType,
  FdsMenuItemCategory,
  FdsPaymentMethod,
  FdsReconciliationStatus,
  FdsTempCheckLocation,
  FdsUsdaClaimStatus,
} from './types';

export const FDS_CATEGORY_LABEL: Record<FdsMenuItemCategory, string> = {
  MAIN: 'Main',
  SIDE: 'Side',
  DESSERT: 'Dessert',
  DRINK: 'Drink',
  SNACK: 'Snack',
};

export const FDS_CATEGORY_PILL: Record<FdsMenuItemCategory, string> = {
  MAIN: 'bg-amber-100 text-amber-700',
  SIDE: 'bg-emerald-100 text-emerald-700',
  DESSERT: 'bg-rose-100 text-rose-700',
  DRINK: 'bg-sky-100 text-sky-700',
  SNACK: 'bg-violet-100 text-violet-700',
};

export const FDS_MEAL_TYPE_LABEL: Record<FdsMealType, string> = {
  BREAKFAST: 'Breakfast',
  LUNCH: 'Lunch',
  DINNER: 'Dinner',
  SNACK: 'Snack',
};

export const FDS_PAYMENT_METHOD_LABEL: Record<FdsPaymentMethod, string> = {
  LUNCH_ACCOUNT: 'Lunch account',
  INVOICE: 'Invoice',
  CASH: 'Cash',
  FREE_MEAL: 'Free meal',
  STAFF_ACCOUNT: 'Staff account',
};

export const FDS_RECON_STATUS_LABEL: Record<FdsReconciliationStatus, string> = {
  OPEN: 'Open',
  RECONCILED: 'Reconciled',
  VARIANCE_FLAGGED: 'Variance flagged',
};

export const FDS_RECON_STATUS_PILL: Record<FdsReconciliationStatus, string> = {
  OPEN: 'bg-sky-100 text-sky-700',
  RECONCILED: 'bg-emerald-100 text-emerald-700',
  VARIANCE_FLAGGED: 'bg-rose-100 text-rose-700',
};

export const FDS_SEVERITY_LABEL: Record<FdsAllergenSeverity, string> = {
  INFO: 'Info',
  WARNING: 'Warning',
  CRITICAL: 'Critical',
};

export const FDS_SEVERITY_PILL: Record<FdsAllergenSeverity, string> = {
  INFO: 'bg-gray-100 text-gray-700',
  WARNING: 'bg-amber-100 text-amber-700',
  CRITICAL: 'bg-rose-700 text-white',
};

export const FDS_MEAL_PLAN_LABEL: Record<FdsDietaryMealPlan, string> = {
  STANDARD: 'Standard',
  VEGETARIAN: 'Vegetarian',
  VEGAN: 'Vegan',
  HALAL: 'Halal',
  KOSHER: 'Kosher',
  OTHER: 'Other',
};

export const FDS_DUR_TYPE_LABEL: Record<FdsDietaryUpdateChangeType, string> = {
  ADD_RESTRICTION: 'Add restriction',
  REMOVE_RESTRICTION: 'Remove restriction',
  ADD_ALLERGEN: 'Add allergen',
  REMOVE_ALLERGEN: 'Remove allergen',
  CHANGE_MEAL_PLAN: 'Change meal plan',
  UPDATE_ELIGIBILITY: 'Update eligibility',
};

export const FDS_DUR_STATUS_LABEL: Record<FdsDietaryUpdateStatus, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

export const FDS_DUR_STATUS_PILL: Record<FdsDietaryUpdateStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-emerald-100 text-emerald-700',
  REJECTED: 'bg-rose-100 text-rose-700',
};

export const FDS_ELIGIBILITY_STATUS_LABEL: Record<FdsEligibilityStatus, string> = {
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  APPROVED: 'Approved',
  DENIED: 'Denied',
  WITHDRAWN: 'Withdrawn',
};

export const FDS_ELIGIBILITY_CATEGORY_LABEL: Record<FdsEligibilityCategory, string> = {
  FREE: 'Free',
  REDUCED: 'Reduced',
  PAID: 'Paid',
  DENIED: 'Denied',
};

export const FDS_ELIGIBILITY_CATEGORY_PILL: Record<FdsEligibilityCategory, string> = {
  FREE: 'bg-emerald-100 text-emerald-700',
  REDUCED: 'bg-amber-100 text-amber-700',
  PAID: 'bg-sky-100 text-sky-700',
  DENIED: 'bg-rose-100 text-rose-700',
};

export const FDS_USDA_STATUS_LABEL: Record<FdsUsdaClaimStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

export const FDS_TEMP_LOCATION_LABEL: Record<FdsTempCheckLocation, string> = {
  DELIVERY: 'Delivery',
  REFRIGERATOR: 'Refrigerator',
  FREEZER: 'Freezer',
  SERVING_LINE: 'Serving line',
  HOT_HOLD: 'Hot hold',
  COLD_HOLD: 'Cold hold',
  COOK_TEMP: 'Cook temperature',
};

export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

export function formatDateOnly(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}
