// app/api/sr1-calendar/route.js
//
// ICS calendar feed for SR1 practicum observation bookings.
// Subscribe to this URL in Google Calendar to see all current-term
// observation blocks as busy events.
//
// URL: https://mylumos.vercel.app/api/sr1-calendar?token=YOUR_SECRET
//
// Environment variable required (set in Vercel dashboard):
//   LUMOS_CALENDAR_TOKEN — any long random string you choose
//
// Each event contains:
//   Title:       SR1 Observation — First Last
//   Location:    Building name (from sr1_buildings via sr1_supervision)
//   Start/End:   lesson_start → reflection_end (full block)
//   Description: Lesson: 9:00–9:45 AM · Reflection: 9:45–10:15 AM
//
// Only current-term bookings with status = 'booked' are included.
// Cancelled bookings are excluded.
//
// The route uses the Supabase service-role key so it can read all
// bookings without RLS filtering by auth.uid(). Never expose the
// service-role key to the client — this is a server-only route.

import { createClient } from '@supabase/supabase-js';

const SR1_TZ = 'America/Chicago';

// Format a UTC ISO string as a local Chicago time string for the description.
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: SR1_TZ,
  });
}

// Convert a UTC ISO string to the ICS DTSTART/DTEND format in Chicago local time.
// ICS format with TZID: YYYYMMDDTHHMMSS (no Z — Z means UTC, which ignores TZID)
function toIcsLocal(iso) {
  const d = new Date(iso);
  // Build the string in Chicago local time piece by piece
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SR1_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find(p => p.type === t).value;
  const yr = get('year');
  const mo = get('month');
  const dy = get('day');
  let hr = get('hour');
  const mn = get('minute');
  const sc = get('second');
  // Intl may return '24' for midnight — normalize to '00'
  if (hr === '24') hr = '00';
  return `${yr}${mo}${dy}T${hr}${mn}${sc}`;
}

// Escape special characters in ICS text fields (RFC 5545 §3.3.11)
function icsEscape(str) {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// Fold long ICS lines at 75 octets (RFC 5545 §3.1)
function foldLine(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const chunks = [];
  let offset = 0;
  let first = true;
  while (offset < bytes.length) {
    const limit = first ? 75 : 74; // continuation lines lose 1 octet to the leading space
    chunks.push(bytes.slice(offset, offset + limit));
    offset += limit;
    first = false;
  }
  return chunks.map((c, i) => (i === 0 ? '' : ' ') + new TextDecoder().decode(c)).join('\r\n');
}

// Generate a stable UID for each booking so Google Calendar can update
// events without creating duplicates on re-poll.
function uid(bookingId) {
  return `sr1-${bookingId}@mylumos.vercel.app`;
}

export async function GET(request) {
  // ── Token check ───────────────────────────────────────────────────────────
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const expected = process.env.LUMOS_CALENDAR_TOKEN;

  if (!expected) {
    // Misconfigured — don't expose data
    return new Response('Calendar feed not configured.', { status: 503 });
  }
  if (!token || token !== expected) {
    return new Response('Unauthorized.', { status: 401 });
  }

  // ── Supabase client (service role — server only) ───────────────────────────
  // Uses the service-role key so RLS doesn't filter out other users' bookings.
  // This key must NEVER be sent to the browser — this route is server-only.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return new Response('Server configuration error.', { status: 503 });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // ── Determine current term ────────────────────────────────────────────────
  let term = 'FA26'; // fallback
  try {
    const { data: setting } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'current_term')
      .single();
    if (setting?.value) term = setting.value;
  } catch {
    // keep fallback
  }

  // ── Fetch bookings (with candidate name) ──────────────────────────────────
  const { data: bookings, error: bErr } = await supabase
    .from('sr1_bookings')
    .select('id, profile_id, lesson_start, lesson_end, reflection_start, reflection_end, status, profiles(first_name, last_name)')
    .eq('term', term)
    .eq('status', 'booked')
    .order('lesson_start');

  if (bErr) {
    console.error('sr1-calendar: bookings error', bErr);
    return new Response('Error loading bookings.', { status: 500 });
  }

  // ── Fetch supervision roster (building per candidate) ─────────────────────
  const { data: roster, error: rErr } = await supabase
    .from('sr1_supervision')
    .select('profile_id, building_id, sr1_buildings(name)')
    .eq('term', term);

  if (rErr) {
    console.error('sr1-calendar: roster error', rErr);
    // Non-fatal — we'll just omit building names
  }

  // Build a lookup: profile_id → building name
  const buildingByProfile = {};
  for (const r of (roster || [])) {
    if (r.sr1_buildings?.name) {
      buildingByProfile[r.profile_id] = r.sr1_buildings.name;
    }
  }

  // ── Build ICS ─────────────────────────────────────────────────────────────
  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lumos//SR1 Observations//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:SR1 Observations',
    'X-WR-CALDESC:Practicum observation schedule — Lumos',
    `X-WR-TIMEZONE:${SR1_TZ}`,
    // Embed a minimal VTIMEZONE block so clients that don't know America/Chicago
    // can still render events correctly. Covers standard (CST, UTC-6) and
    // daylight (CDT, UTC-5) time. Transition rules use simplified RRULE.
    'BEGIN:VTIMEZONE',
    `TZID:${SR1_TZ}`,
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0500',
    'TZOFFSETTO:-0600',
    'TZNAME:CST',
    'DTSTART:19671029T020000',
    'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:-0600',
    'TZOFFSETTO:-0500',
    'TZNAME:CDT',
    'DTSTART:19870405T020000',
    'RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
  ];

  for (const bk of (bookings || [])) {
    const first = bk.profiles?.first_name || '';
    const last = bk.profiles?.last_name || '';
    const name = `${first} ${last}`.trim() || 'Unknown';
    const building = buildingByProfile[bk.profile_id] || '';

    const lessonRange = `Lesson: ${fmtTime(bk.lesson_start)}–${fmtTime(bk.lesson_end)}`;
    const reflRange = `Reflection: ${fmtTime(bk.reflection_start)}–${fmtTime(bk.reflection_end)}`;
    const description = `${lessonRange} · ${reflRange}`;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid(bk.id)}`);
    lines.push(`DTSTAMP:${now}`);
    lines.push('TRANSP:OPAQUE');
    lines.push(foldLine(`DTSTART;TZID=${SR1_TZ}:${toIcsLocal(bk.lesson_start)}`));
    lines.push(foldLine(`DTEND;TZID=${SR1_TZ}:${toIcsLocal(bk.reflection_end)}`));
    lines.push(foldLine(`SUMMARY:SR1 Observation — ${icsEscape(name)}`));
    if (building) lines.push(foldLine(`LOCATION:${icsEscape(building)}`));
    lines.push(foldLine(`DESCRIPTION:${icsEscape(description)}`));
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  const body = lines.join('\r\n');

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="sr1-observations.ics"',
      // Tell Google Calendar to re-poll every 30 minutes.
      // (Google may ignore this and poll on its own schedule, but it's good practice.)
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
