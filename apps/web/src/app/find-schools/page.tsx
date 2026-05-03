'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

interface EnrollmentSearchResultDto {
  schoolId: string;
  schoolName: string;
  schoolFullAddress: string | null;
  distanceMiles: number;
  periodId: string;
  periodName: string;
  closesAt: string;
  acceptingGrades: string[];
}

export default function FindSchoolsPage() {
  // Defaults centred on the demo school (Springfield, IL) so the page
  // returns sensible results out of the box. Geolocation override on click.
  const [lat, setLat] = useState('39.7817');
  const [lng, setLng] = useState('-89.6501');
  const [radius, setRadius] = useState(25);
  const [gradeLevel, setGradeLevel] = useState('');
  const [submitted, setSubmitted] = useState<{
    lat: number;
    lng: number;
    radiusMiles: number;
    gradeLevel?: string;
  } | null>(null);

  function detectLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(6));
        setLng(pos.coords.longitude.toFixed(6));
      },
      // Silent on denial — manual entry still works.
      () => {},
      { timeout: 5_000 },
    );
  }

  function runSearch() {
    const latNum = Number(lat);
    const lngNum = Number(lng);
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return;
    setSubmitted({
      lat: latNum,
      lng: lngNum,
      radiusMiles: radius,
      gradeLevel: gradeLevel.trim() || undefined,
    });
  }

  return (
    <main className="mx-auto min-h-screen max-w-4xl px-4 py-12">
      <div className="mb-8 flex items-baseline justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight text-campus-700">
          Find schools near you
        </h1>
        <Link href="/login" className="text-sm font-medium text-campus-700 hover:text-campus-600">
          Sign in →
        </Link>
      </div>

      <p className="mb-6 text-sm text-gray-600">
        Schools with open enrollment periods are listed here. Pick a location and a radius and
        we&rsquo;ll show you what&rsquo;s currently accepting applications.
      </p>

      <div className="mb-6 rounded-card border border-gray-200 bg-white p-4 shadow-card">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Latitude</span>
            <input
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Longitude</span>
            <input
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Radius (miles)</span>
            <input
              type="number"
              min={1}
              max={100}
              value={radius}
              onChange={(e) => setRadius(Math.max(1, Math.min(100, Number(e.target.value) || 0)))}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Grade (optional)</span>
            <input
              value={gradeLevel}
              onChange={(e) => setGradeLevel(e.target.value)}
              placeholder="e.g. 5"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={runSearch}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
          >
            Search
          </button>
          <button
            type="button"
            onClick={detectLocation}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
          >
            Use my location
          </button>
        </div>
      </div>

      {submitted ? <SearchResults args={submitted} /> : null}
    </main>
  );
}

function SearchResults({
  args,
}: {
  args: { lat: number; lng: number; radiusMiles: number; gradeLevel?: string };
}) {
  const params = new URLSearchParams({
    lat: String(args.lat),
    lng: String(args.lng),
    radiusMiles: String(args.radiusMiles),
  });
  if (args.gradeLevel) params.set('gradeLevel', args.gradeLevel);
  const q = useQuery({
    queryKey: ['enrollment-search', args],
    queryFn: () =>
      apiFetch<EnrollmentSearchResultDto[]>(`/api/v1/enrollment/search?${params.toString()}`),
  });

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <LoadingSpinner size="sm" /> Searching…
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="rounded-card border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        Search failed. Try another location.
      </div>
    );
  }
  const results = q.data ?? [];
  if (results.length === 0) {
    return (
      <div className="rounded-card border border-gray-200 bg-white p-6 text-center text-sm text-gray-600 shadow-card">
        No schools with open enrollment periods within {args.radiusMiles} mile
        {args.radiusMiles === 1 ? '' : 's'} of that location.
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {results.map((r) => (
        <li
          key={`${r.schoolId}-${r.periodId}`}
          className="rounded-card border border-gray-200 bg-white p-4 shadow-card"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-gray-900">{r.schoolName}</h2>
            <span className="text-xs text-gray-500">{r.distanceMiles} mi</span>
          </div>
          {r.schoolFullAddress && (
            <p className="text-sm text-gray-600">{r.schoolFullAddress}</p>
          )}
          <p className="mt-2 text-sm text-gray-700">
            <span className="font-medium">{r.periodName}</span>
            {r.acceptingGrades.length > 0 && (
              <span className="text-gray-500">
                {' · Grades '}
                {r.acceptingGrades.join(', ')}
              </span>
            )}
          </p>
          <p className="text-xs text-gray-500">
            Application closes {new Date(r.closesAt).toLocaleDateString()}
          </p>
        </li>
      ))}
    </ul>
  );
}
