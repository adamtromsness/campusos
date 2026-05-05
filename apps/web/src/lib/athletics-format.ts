import type {
  AthleticsClearanceReviewStatus,
  AthleticsCoachingRole,
  AthleticsEligibilityStatus,
  AthleticsGameLocation,
  AthleticsGameOutcome,
  AthleticsGameStatus,
  AthleticsInjurySeverity,
  AthleticsProgrammeSeason,
  AthleticsReturnToPlayStatus,
  AthleticsRosterLevel,
  AthleticsSeasonStatus,
} from './types';

export const PROGRAMME_SEASON_LABELS: Record<AthleticsProgrammeSeason, string> = {
  FALL: 'Fall',
  WINTER: 'Winter',
  SPRING: 'Spring',
  YEAR_ROUND: 'Year-round',
};

export const ROSTER_LEVEL_LABELS: Record<AthleticsRosterLevel, string> = {
  VARSITY: 'Varsity',
  JV: 'JV',
  FRESHMAN: 'Freshman',
  CLUB: 'Club',
};

export const SEASON_STATUS_LABELS: Record<AthleticsSeasonStatus, string> = {
  UPCOMING: 'Upcoming',
  ACTIVE: 'Active',
  POSTSEASON: 'Postseason',
  COMPLETED: 'Completed',
};

export const SEASON_STATUS_PILL: Record<AthleticsSeasonStatus, string> = {
  UPCOMING: 'bg-gray-100 text-gray-700',
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  POSTSEASON: 'bg-amber-100 text-amber-700',
  COMPLETED: 'bg-sky-100 text-sky-700',
};

export const ELIGIBILITY_LABELS: Record<AthleticsEligibilityStatus, string> = {
  ELIGIBLE: 'Eligible',
  INELIGIBLE: 'Ineligible',
  PENDING_PHYSICAL: 'Pending physical',
  PENDING_CONSENT: 'Pending consent',
  PENDING_TRANSFER_WAIVER: 'Pending transfer waiver',
  INJURED_NOT_CLEARED: 'Injured — not cleared',
};

export const ELIGIBILITY_PILL: Record<AthleticsEligibilityStatus, string> = {
  ELIGIBLE: 'bg-emerald-100 text-emerald-700',
  INELIGIBLE: 'bg-rose-100 text-rose-700',
  PENDING_PHYSICAL: 'bg-gray-100 text-gray-700',
  PENDING_CONSENT: 'bg-gray-100 text-gray-700',
  PENDING_TRANSFER_WAIVER: 'bg-gray-100 text-gray-700',
  INJURED_NOT_CLEARED: 'bg-amber-100 text-amber-700',
};

export const GAME_STATUS_LABELS: Record<AthleticsGameStatus, string> = {
  SCHEDULED: 'Scheduled',
  CONFIRMED: 'Confirmed',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  POSTPONED: 'Postponed',
  CANCELLED: 'Cancelled',
};

export const GAME_STATUS_PILL: Record<AthleticsGameStatus, string> = {
  SCHEDULED: 'bg-gray-100 text-gray-700',
  CONFIRMED: 'bg-sky-100 text-sky-700',
  IN_PROGRESS: 'bg-amber-100 text-amber-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  POSTPONED: 'bg-amber-100 text-amber-700',
  CANCELLED: 'bg-rose-100 text-rose-700',
};

export const GAME_LOCATION_LABELS: Record<AthleticsGameLocation, string> = {
  HOME: 'Home',
  AWAY: 'Away',
  NEUTRAL: 'Neutral',
};

export const GAME_LOCATION_PILL: Record<AthleticsGameLocation, string> = {
  HOME: 'bg-emerald-100 text-emerald-700',
  AWAY: 'bg-rose-100 text-rose-700',
  NEUTRAL: 'bg-gray-100 text-gray-700',
};

export const GAME_OUTCOME_LABELS: Record<AthleticsGameOutcome, string> = {
  WIN: 'Win',
  LOSS: 'Loss',
  DRAW: 'Draw',
  FORFEIT: 'Forfeit',
};

export const COACHING_ROLE_LABELS: Record<AthleticsCoachingRole, string> = {
  HEAD_COACH: 'Head Coach',
  ASSISTANT_COACH: 'Assistant Coach',
  VOLUNTEER_COACH: 'Volunteer Coach',
  SPECIALIST: 'Specialist',
};

export const INJURY_SEVERITY_LABELS: Record<AthleticsInjurySeverity, string> = {
  MINOR: 'Minor',
  MODERATE: 'Moderate',
  SEVERE: 'Severe',
  EMERGENCY: 'Emergency',
};

export const INJURY_SEVERITY_PILL: Record<AthleticsInjurySeverity, string> = {
  MINOR: 'bg-gray-100 text-gray-700',
  MODERATE: 'bg-amber-100 text-amber-700',
  SEVERE: 'bg-orange-100 text-orange-700',
  EMERGENCY: 'bg-rose-100 text-rose-700',
};

export const RETURN_TO_PLAY_LABELS: Record<AthleticsReturnToPlayStatus, string> = {
  ACTIVE: 'Active',
  SIDELINED: 'Sidelined',
  CONCUSSION_PROTOCOL: 'Concussion protocol',
  CLEARED: 'Cleared',
};

export const RETURN_TO_PLAY_PILL: Record<AthleticsReturnToPlayStatus, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  SIDELINED: 'bg-amber-100 text-amber-700',
  CONCUSSION_PROTOCOL: 'bg-rose-100 text-rose-700',
  CLEARED: 'bg-emerald-100 text-emerald-700',
};

export const CLEARANCE_STATUS_LABELS: Record<AthleticsClearanceReviewStatus, string> = {
  PENDING: 'Pending review',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  NOT_SUBMITTED: 'Not submitted',
  EXPIRED: 'Expired',
};

export const CLEARANCE_STATUS_PILL: Record<AthleticsClearanceReviewStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-700',
  ACCEPTED: 'bg-emerald-100 text-emerald-700',
  REJECTED: 'bg-rose-100 text-rose-700',
  NOT_SUBMITTED: 'bg-gray-100 text-gray-700',
  EXPIRED: 'bg-gray-100 text-gray-700',
};

export const PROGRAMME_SEASONS: AthleticsProgrammeSeason[] = [
  'FALL',
  'WINTER',
  'SPRING',
  'YEAR_ROUND',
];
export const ROSTER_LEVELS: AthleticsRosterLevel[] = ['VARSITY', 'JV', 'FRESHMAN', 'CLUB'];

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

export function formatTime(hhmm: string | null | undefined): string {
  if (!hhmm) return '—';
  const [hRaw, m] = hhmm.split(':');
  if (!hRaw || !m) return hhmm;
  const h = Number(hRaw);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const displayH = h % 12 === 0 ? 12 : h % 12;
  return `${displayH}:${m} ${ampm}`;
}

export function formatRecord(
  rec:
    | {
        wins: number;
        losses: number;
        draws: number;
      }
    | null
    | undefined,
): string {
  if (!rec) return '—';
  return `${rec.wins}-${rec.losses}-${rec.draws}`;
}
