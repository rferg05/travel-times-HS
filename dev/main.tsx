import React from 'react';
import { createRoot } from 'react-dom/client';
import manifest from '../manifest.json';
import TravelTimes from '../src/index';
import { mockFetcher } from './mock';
import { makeHostDisplayCache } from './host-cache';

// Stand-in for the host: just enough SDK for the module to run.
(window as unknown as { React: typeof React }).React = React;
(window as unknown as { __HS_SDK__: unknown }).__HS_SDK__ = {
  displayCache: makeHostDisplayCache(),
  // The host's fetch hook; here it only answers Settings > Family.
  useFetchData: (url: string | null) => (url === '/api/family' ? [FAMILY, null] : [null, null]),
};

const params = new URLSearchParams(location.search);
const FAMILY = params.get('family') === '0' ? null : { members: [
  { id: 'p1', name: 'Ryan', color: '#f97316', emoji: 'lucide:crown' },
  { id: 'p2', name: 'Audra', color: '#3b82f6', emoji: 'lucide:heart' },
], groups: [], revision: '1' };
// `?usage=8500` starts this month's Google count there, to see the warning.
// The count otherwise carries over between reloads, like on a display.
if (params.has('usage')) {
  const month = new Date().toISOString().slice(0, 7);
  localStorage.setItem('travel-times:google-usage', JSON.stringify({ month, count: Number(params.get('usage')), alerted: true, capped: false }));
}
const style = {
  fontSize: Number(params.get('fs') ?? 16), fontFamily: 'inter', textColor: '#ffffff', backgroundColor: 'rgba(0, 0, 0, 0.45)',
  borderRadius: 12, padding: 14, opacity: 1, backdropBlur: 12,
};
const w = Number(params.get('w') ?? manifest.defaultSize.w);
const h = Number(params.get('h') ?? manifest.defaultSize.h);

// As on the real display: only people with a calendar linked reach the
// plugin's props (Ryan here); Settings > Family has everyone. `?family=0`
// leaves the Family list out to see the calendar-only fallback.
const people = [{ id: 'p1', name: 'Ryan', color: '#3b82f6', sourceIds: ['cal-ryan', 'cal-audra'] }];
const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const events = [
  { id: 'e1', title: 'Dentist', start: inMin(95), end: inMin(155), location: '30 N Michigan Ave, Chicago, IL', allDay: false, sourceId: 'cal-audra' },
  { id: 'e2', title: 'Team sync', start: inMin(60), end: inMin(90), location: 'https://zoom.us/j/123', allDay: false, sourceId: 'cal-ryan' },
  { id: 'e4', title: 'Brewers game', start: inMin(300), end: inMin(480), location: '1 Brewers Way, Milwaukee, WI', allDay: false, sourceId: 'cal-ryan' },
  { id: 'e3', title: 'Dinner at Avec', start: inMin(420), end: inMin(540), location: '615 W Randolph St, Chicago, IL', allDay: false, sourceId: 'cal-ryan' },
];

const config = {
  ...manifest.defaultConfig,
  homeAddress: '1500 N Milwaukee Ave, Chicago, IL',
  quietFrom: '', quietTo: '',
  routes: [
    { label: 'Work', person: 'Ryan', origin: '', destination: '233 S Wacker Dr, Chicago, IL', days: [], activeFrom: '', activeTo: '', work: false },
    { label: 'Work', person: 'Audra', origin: '', destination: '525 W Monroe St, Chicago, IL', days: [], activeFrom: '', activeTo: '', work: true },
  ],
  ...Object.fromEntries([...params].filter(([k]) => !['w', 'h', 'fs', 'usage'].includes(k))),
};

createRoot(document.getElementById('root')!).render(
  <div style={{ width: w, height: h }}>
    <TravelTimes config={config} style={style} events={events} people={people} fetcher={mockFetcher} timezone="America/Chicago"
      latitude={41.9087} longitude={-87.6776} />
  </div>,
);
