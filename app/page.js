'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { COURSES, TM, CAL_LINK, BRAND, CURRENT_TERM, calcGrade, calcStudentGrade, getBlockers, tokBal, getTokenTarget, getCourseSections } from '../lib/courses';

const F = { d: "'Source Serif 4',Georgia,serif", b: "'DM Sans',sans-serif" };

/* ================================================================
   DATA LAYER — Supabase reads/writes
   ================================================================ */
async function loadUserProfile(email) {
  const { data } = await supabase.from('profiles').select('*').eq('email', email).single();
  return data;
}

// Term-scoped: only activeTerm() enrollments are returned. A student whose only
// enrollments are from a past term gets an empty list, which the app renders as
// the "This course has ended" screen. Past-term data is never loaded.
// ============================================================================
// CURRENT TERM — resolution layer
// ----------------------------------------------------------------------------
// The active term lives in app_settings.current_term so it can be changed from
// the Settings tab instead of by editing courses.js. CURRENT_TERM (courses.js)
// remains as a fallback for the window before the setting has loaded, and for
// the case where app_settings is unreachable.
//
// activeTerm() is the single source every read filter and every write stamp
// uses. Never read CURRENT_TERM directly outside this block.
// ============================================================================
let _activeTerm = CURRENT_TERM;

function activeTerm() { return _activeTerm || CURRENT_TERM; }

async function loadActiveTerm() {
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'current_term').single();
    if (data?.value) _activeTerm = data.value;
  } catch {
    // Table missing or unreachable — keep the courses.js fallback.
  }
  return activeTerm();
}

async function setActiveTerm(term) {
  const { error } = await supabase.from('app_settings')
    .upsert({ key: 'current_term', value: term, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) return { error };
  _activeTerm = term;
  return { error: null };
}

// Generated term list — no table to maintain. Covers a few years either side of
// the active term so the dropdown always includes where you are and where you
// are going.
function termOptions() {
  const seasons = [['SP', 'Spring'], ['SU', 'Summer'], ['FA', 'Fall']];
  const cur = activeTerm();
  const curYear = parseInt((cur || '').slice(2), 10);
  const base = Number.isFinite(curYear) ? curYear : (new Date().getFullYear() % 100);
  const out = [];
  for (let y = base - 1; y <= base + 3; y++) {
    for (const [code, name] of seasons) {
      const yy = String(y).padStart(2, '0');
      out.push({ value: `${code}${yy}`, label: `${name} 20${yy}` });
    }
  }
  return out;
}

// After a term switch: enroll the instructor in the courses she is actually
// teaching that term. Not every course runs every semester — enrolling in all of
// them would leave empty courses cluttering the switcher.
// Idempotent: the (profile_id, course_key, term) unique constraint makes a
// repeat a no-op.
async function ensureInstructorEnrollments(profileId, term, courseKeys) {
  const keys = (courseKeys && courseKeys.length) ? courseKeys : Object.keys(COURSES);
  const rows = keys.map(k => ({ profile_id: profileId, course_key: k, term, active: true }));
  const { error } = await supabase.from('enrollments')
    .upsert(rows, { onConflict: 'profile_id,course_key,term', ignoreDuplicates: true });
  return { error };
}

// Copy the previous term's due dates into the current term. Section structure
// and text notes are preserved; dates come across as-is for the instructor to
// adjust. Items already set in the current term are left alone.
async function copyDueDatesFromTerm(courseKey, fromTerm, toTerm) {
  const { data: src } = await supabase.from('assignment_due_dates')
    .select('assignment_id, due_label, due_date, section')
    .eq('course_key', courseKey).eq('term', fromTerm);
  if (!src || src.length === 0) return { copied: 0, error: null };

  const { data: existing } = await supabase.from('assignment_due_dates')
    .select('assignment_id, section')
    .eq('course_key', courseKey).eq('term', toTerm);
  const taken = new Set((existing || []).map(r => `${r.assignment_id}|${r.section || ''}`));

  const rows = src
    .filter(r => !taken.has(`${r.assignment_id}|${r.section || ''}`))
    .map(r => ({ course_key: courseKey, assignment_id: r.assignment_id, due_label: r.due_label, due_date: r.due_date, section: r.section, term: toTerm, updated_at: new Date().toISOString() }));
  if (rows.length === 0) return { copied: 0, error: null };

  const { error } = await supabase.from('assignment_due_dates').insert(rows);
  return { copied: error ? 0 : rows.length, error };
}

// ---------------------------------------------------------------------------
// TOKEN CUTOFFS — per course, per term
// The live cutoff lives in term_settings so it can be set from Settings each
// semester. courses.js still carries tokenCutoff / tokenCutoffDate, which are
// now DEFAULTS ONLY — used when term_settings has no row for this term.
//
// cutoffFor() / cutoffLabelFor() replace the imported pastCutoff() /
// getTokenCutoff() everywhere in the student view.
// ---------------------------------------------------------------------------
let _cutoffs = {}; // { [course_key]: 'YYYY-MM-DD' } for the ACTIVE term only

async function loadTermSettings(term) {
  try {
    const { data } = await supabase.from('term_settings').select('course_key, token_cutoff_date').eq('term', term);
    const map = {};
    (data || []).forEach(r => { if (r.token_cutoff_date) map[r.course_key] = r.token_cutoff_date; });
    _cutoffs = map;
  } catch {
    _cutoffs = {}; // fall back to the courses.js defaults
  }
  return _cutoffs;
}

async function setTokenCutoff(courseKey, term, dateStr) {
  const { error } = await supabase.from('term_settings')
    .upsert({ course_key: courseKey, term, token_cutoff_date: dateStr || null, updated_at: new Date().toISOString() }, { onConflict: 'course_key,term' });
  if (error) return { error };
  if (dateStr) _cutoffs[courseKey] = dateStr; else delete _cutoffs[courseKey];
  return { error: null };
}

function cutoffDateFor(ck) {
  const override = _cutoffs[ck];
  if (override) return new Date(override + 'T23:59:59');
  return COURSES[ck]?.tokenCutoffDate || null; // courses.js default
}

// True when the token period has ended for this course in the active term.
function cutoffFor(ck) {
  const d = cutoffDateFor(ck);
  if (!d) return false;
  return new Date() > d;
}

// Display string, e.g. "July 9, 2026".
function cutoffLabelFor(ck) {
  const override = _cutoffs[ck];
  if (override) return new Date(override + 'T12:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return COURSES[ck]?.tokenCutoff || "";
}

// Course codes — listed and toggled from Settings so deactivating a code (e.g.
// the generic MATH4850 before Fall sections open) is a click, not SQL.
async function loadCourseCodes() {
  const { data } = await supabase.from('course_codes').select('code, course_key, label, section, active').order('course_key');
  return data || [];
}

async function setCourseCodeActive(code, active) {
  const { error } = await supabase.from('course_codes').update({ active }).eq('code', code);
  return { error };
}

// Mark/unmark an enrollment as a test account (colleague sign-ins used to check
// the student view). Test enrollments are excluded from grade distribution,
// counts, CSV export, and the Tracks tab.
async function setEnrollmentTest(profileId, courseKey, isTest) {
  const { error } = await supabase.from('enrollments')
    .update({ is_test: isTest })
    .eq('profile_id', profileId).eq('course_key', courseKey).eq('term', activeTerm());
  return { error };
}

async function loadEnrollments(profileId) {
  const { data } = await supabase.from('enrollments').select('course_key, active, section, term').eq('profile_id', profileId).eq('term', activeTerm());
  return (data || []).map(e => ({ key: e.course_key, active: e.active !== false, section: e.section || null, term: e.term }));
}

// Unfiltered — used only to tell "she has past-term enrollments" (show the
// course-ended screen) apart from "she has none at all" (show the join screen).
async function loadAnyEnrollments(profileId) {
  const { data } = await supabase.from('enrollments').select('course_key, term').eq('profile_id', profileId);
  return data || [];
}

async function loadReleasedAssignments(courseKey) {
  const { data } = await supabase.from('released_assignments').select('assignment_id').eq('course_key', courseKey);
  const ids = (data || []).map(r => r.assignment_id);
  return ids;
}

// Section-aware due-date loader.
//   `viewerSection` = the section to resolve the flat `dueDates` map for
//     (a student's own section, or an instructor's active section filter).
//     null = resolve to the "all sections" row.
// Returns { dueDates, dueDatesAll }:
//   - dueDates: flat { [assignmentId]: { label, date } }, resolved for viewerSection
//       (section-specific row wins; falls back to the null "all sections" row).
//       This preserves the exact shape every existing consumer (grade calc, feed,
//       checklist, grid, preview) already expects — they never learn sections exist.
//   - dueDatesAll: full per-section detail { [assignmentId]: { all, LS, WB, ... } }
//       where each value is { label, date }. Only the Settings editor reads this.
async function loadDueDates(courseKey, viewerSection = null) {
  const { data } = await supabase.from('assignment_due_dates').select('assignment_id, due_label, due_date, section').eq('course_key', courseKey).eq('term', activeTerm());
  const bySection = {}; // { [assignmentId]: { [sectionKeyOrAll]: { label, date } } }
  (data || []).forEach(r => {
    const aid = r.assignment_id;
    const sec = r.section || 'all';
    if (!bySection[aid]) bySection[aid] = {};
    bySection[aid][sec] = { label: r.due_label || null, date: r.due_date || null };
  });
  const map = {};
  Object.keys(bySection).forEach(aid => {
    // Section-specific override wins; otherwise fall back to the "all sections" row.
    const override = viewerSection ? bySection[aid][viewerSection] : null;
    const resolved = override || bySection[aid].all;
    if (resolved) map[aid] = resolved;
  });
  return { dueDates: map, dueDatesAll: bySection };
}

// section = null writes the "all sections" row; 'LS'/'WB' writes that section's override.
// The 3-column unique constraint (course_key, assignment_id, section) with NULLS NOT
// DISTINCT makes the null "all sections" row a single upsert target.
async function upsertDueDate(courseKey, assignmentId, dueLabel, dueDate, section = null) {
  if (!dueLabel && !dueDate) {
    const q = supabase.from('assignment_due_dates').delete().eq('course_key', courseKey).eq('assignment_id', assignmentId).eq('term', activeTerm());
    const { error } = section ? await q.eq('section', section) : await q.is('section', null);
    return { error };
  } else {
    const { error } = await supabase.from('assignment_due_dates').upsert({ course_key: courseKey, assignment_id: assignmentId, due_label: dueLabel || null, due_date: dueDate || null, section: section || null, term: activeTerm(), updated_at: new Date().toISOString() }, { onConflict: 'course_key,assignment_id,section,term' });
    return { error };
  }
}

async function loadStudentsForCourse(courseKey) {
  const { data } = await supabase.from('enrollments').select('profile_id, section, is_test, profiles(id, email, first_name, last_name, role)').eq('course_key', courseKey).eq('term', activeTerm()).eq('active', true);
  return (data || []).filter(e => e.profiles?.role === 'student').map(e => ({ id: e.profiles.id, first: e.profiles.first_name, last: e.profiles.last_name, email: e.profiles.email, name: `${e.profiles.first_name} ${e.profiles.last_name}`, section: e.section || null, isTest: e.is_test === true }));
}

// Dropped students — for the "Dropped students" restore list in Settings.
// Loaded on demand only (not part of the main data load), since it's rarely needed.
async function loadInactiveStudentsForCourse(courseKey) {
  const { data } = await supabase.from('enrollments').select('profile_id, section, is_test, profiles(id, email, first_name, last_name, role)').eq('course_key', courseKey).eq('term', activeTerm()).eq('active', false);
  return (data || []).filter(e => e.profiles?.role === 'student').map(e => ({ id: e.profiles.id, first: e.profiles.first_name, last: e.profiles.last_name, email: e.profiles.email, name: `${e.profiles.first_name} ${e.profiles.last_name}`, section: e.section || null, isTest: e.is_test === true }));
}

// Soft-remove: hides the student from the active roster (grid, CSV, batch grading,
// grade calcs) but keeps every row in student_checks/instructor_statuses/tokens/
// feedback_queue untouched, so restoring her later restores her full history.
async function removeStudentFromCourse(profileId, courseKey) {
  const { error } = await supabase.from('enrollments').update({ active: false }).eq('profile_id', profileId).eq('course_key', courseKey).eq('term', activeTerm());
  return { error };
}

async function restoreStudentToCourse(profileId, courseKey) {
  const { error } = await supabase.from('enrollments').update({ active: true }).eq('profile_id', profileId).eq('course_key', courseKey).eq('term', activeTerm());
  return { error };
}

// Name correction — profiles table only, no grade/enrollment logic involved.
async function updateStudentName(profileId, firstName, lastName) {
  const { error } = await supabase.from('profiles').update({ first_name: firstName, last_name: lastName }).eq('id', profileId);
  return { error };
}

async function loadInstrStatuses(courseKey) {
  const { data } = await supabase.from('instructor_statuses').select('*').eq('course_key', courseKey).eq('term', activeTerm());
  const map = {};
  (data || []).forEach(r => { if (!map[r.profile_id]) map[r.profile_id] = {}; map[r.profile_id][r.assignment_id] = r.status; });
  return map;
}

async function loadMyInstrStatuses(courseKey, profileId) {
  const { data } = await supabase.from('instructor_statuses').select('assignment_id, status, updated_at').eq('course_key', courseKey).eq('profile_id', profileId).eq('term', activeTerm());
  const map = {};
  (data || []).forEach(r => { map[r.assignment_id] = { status: r.status, updated_at: r.updated_at }; });
  return map;
}

async function loadInstrNotes(courseKey) {
  const { data } = await supabase.from('instructor_notes').select('*').eq('course_key', courseKey).eq('term', activeTerm());
  const map = {};
  (data || []).forEach(r => { if (!map[r.profile_id]) map[r.profile_id] = {}; map[r.profile_id][r.assignment_id] = r.note; });
  return map;
}

async function loadStudentChecks(courseKey, profileId) {
  const q = supabase.from('student_checks').select('*').eq('course_key', courseKey).eq('term', activeTerm());
  if (profileId) q.eq('profile_id', profileId);
  const { data } = await q;
  const map = {};
  (data || []).forEach(r => { if (!map[r.profile_id]) map[r.profile_id] = {}; map[r.profile_id][r.assignment_id] = r.checked; });
  return map;
}

async function loadClassPrep(courseKey, profileId) {
  const q = supabase.from('class_prep').select('*').eq('course_key', courseKey).eq('term', activeTerm());
  if (profileId) q.eq('profile_id', profileId);
  const { data } = await q;
  const map = {};
  (data || []).forEach(r => { if (!map[r.profile_id]) map[r.profile_id] = {}; map[r.profile_id][r.prep_id] = r.checked; });
  return map;
}

async function loadTokens(courseKey, profileId) {
  const q = supabase.from('tokens').select('*').eq('course_key', courseKey).eq('term', activeTerm());
  if (profileId) q.eq('profile_id', profileId);
  const { data } = await q;
  const map = {};
  (data || []).forEach(r => { if (!map[r.profile_id]) map[r.profile_id] = []; map[r.profile_id].push(r); });
  return map;
}

// Student-scoped view of her own token submissions, so the checklist can show
// "Token submitted [date] — awaiting review" / "reviewed". The instructor loader
// below pulls the whole course; RLS lets a student read only her own rows, so
// this is the same table filtered to her.
async function loadMyQueue(courseKey, profileId) {
  const { data } = await supabase.from('feedback_queue')
    .select('assignment_id, token_type, submitted_at, resolved, resolution, resolved_at')
    .eq('course_key', courseKey).eq('term', activeTerm()).eq('profile_id', profileId)
    .order('submitted_at', { ascending: false });
  const map = {};
  (data || []).forEach(r => { if (!map[r.assignment_id]) map[r.assignment_id] = r; }); // newest per assignment
  return map;
}

async function loadFeedbackQueue(courseKey) {
  const { data } = await supabase.from('feedback_queue').select('*, profiles(first_name, last_name)').eq('course_key', courseKey).eq('term', activeTerm()).order('submitted_at', { ascending: false });
  return (data || []).map(r => ({ ...r, sName: `${r.profiles?.first_name || ''} ${r.profiles?.last_name || ''}`.trim() }));
}

// WRITE OPERATIONS
async function upsertInstrStatus(profileId, courseKey, assignmentId, status) {
  if (!status) {
    return await supabase.from('instructor_statuses').delete().match({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, term: activeTerm() });
  } else {
    return await supabase.from('instructor_statuses').upsert({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, status, term: activeTerm(), updated_at: new Date().toISOString() }, { onConflict: 'profile_id,course_key,assignment_id,term' });
  }
}

async function upsertInstrNote(profileId, courseKey, assignmentId, note) {
  await supabase.from('instructor_notes').upsert({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, note, term: activeTerm(), updated_at: new Date().toISOString() }, { onConflict: 'profile_id,course_key,assignment_id,term' });
}

async function toggleStudentCheck(profileId, courseKey, assignmentId) {
  const { data: existing } = await supabase.from('student_checks').select('id').match({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, term: activeTerm() }).single();
  if (existing) {
    await supabase.from('student_checks').delete().eq('id', existing.id);
    return false;
  } else {
    await supabase.from('student_checks').insert({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, checked: true, term: activeTerm() });
    return true;
  }
}

async function toggleClassPrep(profileId, courseKey, prepId) {
  const { data: existing } = await supabase.from('class_prep').select('id').match({ profile_id: profileId, course_key: courseKey, prep_id: prepId, term: activeTerm() }).single();
  if (existing) {
    await supabase.from('class_prep').delete().eq('id', existing.id);
    return false;
  } else {
    await supabase.from('class_prep').insert({ profile_id: profileId, course_key: courseKey, prep_id: prepId, checked: true, term: activeTerm() });
    return true;
  }
}

async function submitToken(profileId, courseKey, assignmentId, tokenType, note, link) {
  await supabase.from('tokens').insert({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, token_type: tokenType, note, link, term: activeTerm() });
  await supabase.from('feedback_queue').insert({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, token_type: tokenType, note, link, term: activeTerm() });
}

async function resolveQueueItem(queueId, profileId, courseKey, assignmentId, resolution) {
  await supabase.from('feedback_queue').update({ resolved: true, resolution, resolved_at: new Date().toISOString() }).eq('id', queueId);
  if (resolution === 'M' || resolution === 'R') {
    const status = resolution === 'M' ? 'mastery' : 'revision';
    // Find the student's email from auth, then get their current profile ID
    const { data: authUser } = await supabase.from('profiles').select('email').eq('id', profileId).single();
    if (authUser?.email) {
      const { data: currentProfile } = await supabase.from('profiles').select('id').eq('email', authUser.email).single();
      if (currentProfile) {
        await upsertInstrStatus(currentProfile.id, courseKey, assignmentId, status);
        return;
      }
    }
    // Fallback to original profileId
    await upsertInstrStatus(profileId, courseKey, assignmentId, status);
  }
}

async function returnToken(queueId, profileId, courseKey, assignmentId) {
  await supabase.from('feedback_queue').delete().eq('id', queueId);
  // Delete the matching token (most recent one for this student/assignment)
  const { data: tok } = await supabase.from('tokens').select('id').match({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, term: activeTerm() }).order('submitted_at', { ascending: false }).limit(1).single();
  if (tok) await supabase.from('tokens').delete().eq('id', tok.id);
}

async function toggleReleased(courseKey, assignmentId) {
  const { data: existing } = await supabase.from('released_assignments').select('id').match({ course_key: courseKey, assignment_id: assignmentId }).single();
  if (existing) {
    await supabase.from('released_assignments').delete().eq('id', existing.id);
  } else {
    await supabase.from('released_assignments').insert({ course_key: courseKey, assignment_id: assignmentId });
  }
}

// TEACHING SCHEDULE
async function loadTeachingDates(courseKey) {
  const { data } = await supabase.from('teaching_dates').select('*').eq('course_key', courseKey).eq('term', activeTerm()).order('teach_date');
  return data || [];
}

async function loadTeachingSelections(courseKey, profileId) {
  const q = supabase.from('teaching_selections').select('*, profiles(first_name, last_name)').eq('course_key', courseKey).eq('term', activeTerm());
  if (profileId) q.eq('profile_id', profileId);
  const { data } = await q;
  return data || [];
}

async function pickTeachingDate(profileId, courseKey, assignmentId, teachDate) {
  const planDue = new Date(teachDate);
  planDue.setDate(planDue.getDate() - 3);
  const planDueStr = planDue.toISOString().slice(0, 10);
  // Upsert — if they already picked a date for this assignment, replace it
  const { data: existing } = await supabase.from('teaching_selections').select('id').match({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, term: activeTerm() }).single();
  if (existing) {
    await supabase.from('teaching_selections').update({ teach_date: teachDate, plan_due_date: planDueStr }).eq('id', existing.id);
  } else {
    await supabase.from('teaching_selections').insert({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, teach_date: teachDate, plan_due_date: planDueStr, term: activeTerm() });
  }
}

async function removeTeachingSelection(profileId, courseKey, assignmentId) {
  await supabase.from('teaching_selections').delete().match({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, term: activeTerm() });
}

async function addTeachingDate(courseKey, assignmentId, teachDate, section = null) {
  const { error } = await supabase.from('teaching_dates').insert({ course_key: courseKey, assignment_id: assignmentId, teach_date: teachDate, section: section || null, term: activeTerm() });
  return !error;
}

// Fall 2026: a teaching date's `section` says who it's offered to.
//   null = both sections (the common case), 'LS'/'WB' = that section only.
// A given calendar date can therefore exist as more than one row for one assignment,
// so edit/delete key off the row's own `id`, not the (course, assignment, date) triple.
async function updateTeachingDate(id, courseKey, assignmentId, oldDate, newDate) {
  const planDue = new Date(newDate);
  planDue.setDate(planDue.getDate() - 3);
  const planDueStr = planDue.toISOString().slice(0, 10);
  // Update the specific teaching_dates row by id
  await supabase.from('teaching_dates').update({ teach_date: newDate }).eq('id', id);
  // Cascade to student selections that used the old date for this assignment so their
  // plan due date stays correct. (Selections reference the date, not the row id.)
  await supabase.from('teaching_selections').update({ teach_date: newDate, plan_due_date: planDueStr }).match({ course_key: courseKey, assignment_id: assignmentId, teach_date: oldDate, term: activeTerm() });
}

async function deleteTeachingDate(id) {
  const { error } = await supabase.from('teaching_dates').delete().eq('id', id);
  return !error;
}

/* ================================================================
   PRACTICUM OBSERVATION SCHEDULING (SR1)
   ----------------------------------------------------------------
   Separate from the 4850 "Teaching Schedule" above. That one is
   course-wide and lets several students pick the same date. This one
   covers only the ~8 candidates Dr. Beggs supervises in the field,
   is scoped to a building, and is exclusive — two candidates can
   never hold overlapping times, because she cannot be in two places.

   Exclusivity is enforced in Postgres (an exclusion constraint over
   the booking's time span), not here. The client is a convenience;
   book_sr1_observation() is the gate. See practicum-schema.sql.

   All times are stored as timestamptz and displayed in Central. See
   fmtTime / fmtTimeRange below — never render a raw timestamp.
   ================================================================ */

const SR1_TZ = 'America/Chicago';

// Courses whose rosters can be pulled into practicum supervision. Only affects
// the Roster Setup picker — everything downstream (windows, bookings, the
// student view) keys off profile_id and never looks at a course, so a
// candidate keeps working normally no matter which course she came from.
// Add a course key here when a new block starts using field supervision.
const SR1_COURSES = ["ECEL 4850", "ECEL 3820"];

// 12-hour, no leading zero: "9:20 AM", "1:30 PM". Times are absolute
// instants in the database; this is the only place they become text.
function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: SR1_TZ });
}
function fmtDay(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: SR1_TZ });
}
// A date-only column (window_date) has no time part, so it must NOT be
// shifted into Central — that would roll it back a day. Parse at noon.
function fmtDateOnly(d) {
  if (!d) return '';
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
// "9:20 AM – 10:05 AM"
function fmtTimeRange(a, b) { return `${fmtTime(a)} – ${fmtTime(b)}`; }

// Build a timestamptz string for a local Central wall-clock time on a given
// date. The offset changes with DST, so it is derived rather than hardcoded.
function centralISO(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [h, m] = timeStr.split(':').map(Number);
  // Probe the offset for this specific date by comparing a UTC instant to how
  // Central renders it.
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const centralHour = Number(probe.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: SR1_TZ }));
  const offset = 12 - centralHour; // 5 in CDT, 6 in CST
  const utcH = h + offset;
  const base = new Date(`${dateStr}T00:00:00Z`);
  base.setUTCHours(utcH, m, 0, 0);
  return base.toISOString();
}

async function loadSr1Buildings() {
  const { data } = await supabase.from('sr1_buildings')
    .select('id, name, active').eq('term', activeTerm()).order('name');
  return data || [];
}

async function addSr1Building(name) {
  const { error } = await supabase.from('sr1_buildings')
    .insert({ term: activeTerm(), name: name.trim() });
  return { error };
}

async function deleteSr1Building(id) {
  const { error } = await supabase.from('sr1_buildings').delete().eq('id', id);
  return { error };
}

// The supervision roster: who Dr. Beggs observes in the field this term.
// Being enrolled in 4850 does not put a student here.
async function loadSr1Supervision() {
  const { data } = await supabase.from('sr1_supervision')
    .select('id, profile_id, building_id, ct_name, profiles(id, first_name, last_name)')
    .eq('term', activeTerm());
  return data || [];
}

async function loadMySr1Supervision(profileId) {
  const { data } = await supabase.from('sr1_supervision')
    .select('id, building_id, ct_name').eq('profile_id', profileId).eq('term', activeTerm()).maybeSingle();
  return data || null;
}

async function upsertSr1Supervision(profileId, buildingId, ctName) {
  const { error } = await supabase.from('sr1_supervision').upsert({
    profile_id: profileId, term: activeTerm(),
    building_id: buildingId || null, ct_name: ctName || null,
    updated_at: new Date().toISOString()
  }, { onConflict: 'profile_id,term' });
  return { error };
}

async function removeSr1Supervision(profileId) {
  const { error } = await supabase.from('sr1_supervision')
    .delete().match({ profile_id: profileId, term: activeTerm() });
  return { error };
}

async function loadSr1Windows() {
  const { data } = await supabase.from('sr1_windows')
    .select('*').eq('term', activeTerm()).order('window_date');
  return data || [];
}

async function createSr1Window(w) {
  const { error } = await supabase.from('sr1_windows').insert({
    term: activeTerm(), building_id: w.building_id, window_date: w.window_date,
    start_time: w.start_time, end_time: w.end_time,
    reflection_minutes: w.reflection_minutes, buffer_minutes: w.buffer_minutes,
    note: w.note || null, published: w.published
  });
  return { error };
}

async function setSr1WindowPublished(id, published) {
  const { error } = await supabase.from('sr1_windows').update({ published }).eq('id', id);
  return { error };
}

// RESTRICT on the FK means this fails while bookings still reference the
// window — deliberate, so a window can never silently take bookings with it.
async function deleteSr1Window(id) {
  const { error } = await supabase.from('sr1_windows').delete().eq('id', id);
  return { error };
}

async function loadSr1Bookings() {
  const { data } = await supabase.from('sr1_bookings')
    .select('*, profiles(id, first_name, last_name)')
    .eq('term', activeTerm()).order('lesson_start');
  return data || [];
}

async function loadMySr1Bookings(profileId) {
  const { data } = await supabase.from('sr1_bookings')
    .select('*').eq('profile_id', profileId).eq('term', activeTerm()).order('lesson_start');
  return data || [];
}

// Spans only — no names, no topics. This is how a candidate sees which times
// are taken without learning who took them.
async function loadSr1TakenTimes() {
  const { data } = await supabase.from('sr1_taken_times')
    .select('window_id, span_start, span_end').eq('term', activeTerm());
  return data || [];
}

// Every booking rule lives in the database function, not here.
async function bookSr1Observation(windowId, lessonStartISO, lessonEndISO, topic) {
  const { data, error } = await supabase.rpc('book_sr1_observation', {
    p_window_id: windowId, p_lesson_start: lessonStartISO,
    p_lesson_end: lessonEndISO, p_topic: topic
  });
  return { data, error };
}

// Student self-cancel. The RLS policy allows this only outside the 24-hour
// lockout, so inside it the update matches zero rows and we say so.
async function cancelSr1Booking(id) {
  const { data, error } = await supabase.from('sr1_bookings')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', id).select('id');
  if (error) return { error, blocked: false };
  if (!data || data.length === 0) return { error: null, blocked: true };
  return { error: null, blocked: false };
}

// Instructor edit. Recomputes the span so the overlap guarantee still holds,
// and writes a notification whenever the candidate's times actually move.
async function instrUpdateSr1Booking(booking, next, notify) {
  const bufferMin = next.buffer_minutes ?? booking.buffer_minutes ?? 10;
  const spanEnd = new Date(new Date(next.reflection_end).getTime() + bufferMin * 60000).toISOString();
  const { error } = await supabase.from('sr1_bookings').update({
    lesson_start: next.lesson_start, lesson_end: next.lesson_end,
    reflection_start: next.reflection_start, reflection_end: next.reflection_end,
    span: `[${next.lesson_start},${spanEnd})`,
    topic: next.topic, reflection_minutes: next.reflection_minutes,
    buffer_minutes: bufferMin, instructor_override: next.instructor_override,
    override_note: next.override_note || null,
    updated_at: new Date().toISOString()
  }).eq('id', booking.id);
  if (error) return { error };
  if (notify) {
    await supabase.from('sr1_notifications').insert({
      profile_id: booking.profile_id, booking_id: booking.id, term: activeTerm(),
      kind: 'time_changed',
      message: `Your observation on ${fmtDay(next.lesson_start)} was changed to ${fmtTimeRange(next.lesson_start, next.lesson_end)}, with reflection until ${fmtTime(next.reflection_end)}. Please let your cooperating teacher know.`
    });
  }
  return { error: null };
}

async function instrCancelSr1Booking(booking) {
  const { error } = await supabase.from('sr1_bookings')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', booking.id);
  if (error) return { error };
  await supabase.from('sr1_notifications').insert({
    profile_id: booking.profile_id, booking_id: booking.id, term: activeTerm(),
    kind: 'cancelled',
    message: `Your observation on ${fmtDay(booking.lesson_start)} at ${fmtTime(booking.lesson_start)} was cancelled by Dr. Beggs. Please schedule a new time.`
  });
  return { error: null };
}

async function loadMySr1Notifications(profileId) {
  const { data } = await supabase.from('sr1_notifications')
    .select('id, kind, message, created_at')
    .eq('profile_id', profileId).eq('term', activeTerm())
    .is('read_at', null).order('created_at', { ascending: false });
  return data || [];
}

async function dismissSr1Notification(id) {
  await supabase.from('sr1_notifications').update({ read_at: new Date().toISOString() }).eq('id', id);
}

// Which slices of a window are still free, given everything already booked.
// Used for the "Open: 10:40 AM – 12:00 PM" list a candidate reads before
// choosing. Returns [] when the window is fully taken.
function sr1OpenGaps(win, taken) {
  const start = new Date(centralISO(win.window_date, win.start_time)).getTime();
  const end = new Date(centralISO(win.window_date, win.end_time)).getTime();
  const spans = taken.filter(t => t.window_id === win.id)
    .map(t => [new Date(t.span_start).getTime(), new Date(t.span_end).getTime()])
    .sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cursor = start;
  for (const [s, e] of spans) {
    if (s > cursor) gaps.push([cursor, Math.min(s, end)]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < end) gaps.push([cursor, end]);
  // A gap shorter than the minimum lesson plus reflection cannot hold a
  // booking, so showing it would only mislead.
  const minMs = (20 + (win.reflection_minutes ?? 25)) * 60000;
  return gaps.filter(([s, e]) => e - s >= minMs).map(([s, e]) => ({ start: new Date(s), end: new Date(e) }));
}

// Mirrors the 48-hour rule enforced in book_sr1_observation().
function sr1TooSoon(iso) {
  return new Date(iso).getTime() < Date.now() + 48 * 3600 * 1000;
}
// Mirrors the 24-hour self-cancel lockout in the RLS policy.
function sr1CancelLocked(iso) {
  return new Date(iso).getTime() < Date.now() + 24 * 3600 * 1000;
}


/* ================================================================
   TINY COMPONENTS
   ================================================================ */
function Pill({ t, bg = "#F8F7F4", c = "#767676" }) { return <span role="status" aria-label={t} style={{ display: "inline-block", padding: "2px 7px", borderRadius: 4, fontFamily: F.b, fontSize: 11, fontWeight: 600, background: bg, color: c, whiteSpace: "nowrap" }}>{t}</span>; }
function Lbl({ children, s = {}, onClick, expanded }) { 
  if (onClick !== undefined) {
    return <button aria-expanded={expanded} onClick={onClick} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", fontFamily: F.b, fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "#555", marginBottom: 10, padding: "8px 0", background: "none", border: "none", borderBottom: "1px solid #E8E6E1", cursor: "pointer", ...s }}><span>{children}</span><span style={{ fontSize: 12, color: "#767676", transform: expanded ? "rotate(180deg)" : "", transition: "transform .2s" }}>▾</span></button>;
  }
  return <h2 style={{ fontFamily: F.b, fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "#555", marginBottom: 10, padding: "8px 0", borderBottom: "1px solid #E8E6E1", ...s }}>{children}</h2>; 
}
function GradeRing({ grade, size = 50, label = "" }) { const m = TM[grade] || TM.F; const on = grade !== "F" && grade !== "early"; return <div role="img" aria-label={label || `Grade track: ${grade}`} style={{ width: size, height: size, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: on ? m.c : "#F0EEEA", border: `3px solid ${on ? m.c : "#E0DDD8"}`, transition: "all .4s" }}><span style={{ fontSize: size * .38, fontWeight: 700, fontFamily: F.d, color: on ? "#fff" : "#767676", lineHeight: 1 }}>{grade === "early" ? "—" : grade}</span></div>; }
// Accessible confirmation for switching semesters. Moves focus into the dialog
// on open, returns it to whatever was focused before on close, traps Tab inside
// while open, and cancels on Escape. role="dialog" + aria-modal so screen
// readers treat the rest of the page as inert.
function TermSwitchDialog({ from, to, busy, selected, onToggleCourse, onCancel, onConfirm }) {
  const boxRef = useRef(null);
  const cancelRef = useRef(null);
  const prevFocus = useRef(null);

  useEffect(() => {
    prevFocus.current = document.activeElement;
    if (cancelRef.current) cancelRef.current.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }
      if (e.key !== 'Tab' || !boxRef.current) return;
      const f = boxRef.current.querySelectorAll('button, [href], select, input, [tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (prevFocus.current && prevFocus.current.focus) prevFocus.current.focus();
    };
  }, [onCancel]);

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="term-dlg-title" aria-describedby="term-dlg-desc"
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120 }}
      onClick={() => { if (!busy) onCancel(); }}>
      <div ref={boxRef} onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 10, padding: 22, maxWidth: 400, width: "90%" }}>
        <h2 id="term-dlg-title" style={{ fontFamily: F.d, fontSize: 16, fontWeight: 700, margin: "0 0 10px", color: "#1A1A1A" }}>Change semester to {to}?</h2>
        <div id="term-dlg-desc" style={{ fontFamily: F.b, fontSize: 12, color: "#555", lineHeight: 1.6, marginBottom: 16 }}>
          <p style={{ margin: "0 0 8px" }}>Everything from {from} — students, grades, checkoffs, due dates, tokens — will be hidden from every view in Lumos.</p>
          <p style={{ margin: "0 0 8px" }}>Nothing is deleted. Switching back to {from} restores it exactly as it is now.</p>
          <p style={{ margin: 0 }}>Students enrolled only in {from} will see &ldquo;This course has ended&rdquo; when they sign in. Export your grades first if you haven&rsquo;t.</p>
        </div>

        <fieldset style={{ border: "1px solid #E8E6E1", borderRadius: 8, padding: "10px 12px", marginBottom: 16 }}>
          <legend style={{ fontFamily: F.b, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "#555", padding: "0 6px" }}>Teaching in {to}</legend>
          <p style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", margin: "0 0 8px", lineHeight: 1.5 }}>
            Only the courses you check will appear in your course list. You can add others later by changing semester again.
          </p>
          {Object.keys(COURSES).map(k => {
            const on = (selected || []).includes(k);
            return (
              <label key={k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer" }}>
                <input type="checkbox" checked={on} onChange={() => onToggleCourse(k)} disabled={busy}
                  style={{ width: 16, height: 16, cursor: "pointer", accentColor: "#CF202E" }} />
                <span style={{ fontFamily: F.b, fontSize: 12, color: "#1A1A1A" }}>{COURSES[k]?.short || k}</span>
              </label>
            );
          })}
        </fieldset>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button ref={cancelRef} onClick={onCancel} disabled={busy}
            style={{ padding: "7px 14px", background: "#F5F4F0", color: "#555", border: "1px solid #E8E6E1", borderRadius: 5, fontFamily: F.b, fontSize: 12, fontWeight: 600, cursor: busy ? "default" : "pointer" }}>Cancel</button>
          <button onClick={onConfirm} disabled={busy || !(selected || []).length}
            style={{ padding: "7px 14px", background: (busy || !(selected || []).length) ? "#B0ADA8" : "#CF202E", color: "#fff", border: "none", borderRadius: 5, fontFamily: F.b, fontSize: 12, fontWeight: 600, cursor: (busy || !(selected || []).length) ? "default" : "pointer" }}>
            {busy ? "Changing…" : `Change to ${to}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function Loading() { return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}><div style={{ fontFamily: F.b, color: "#6B6B6B", fontSize: 14 }}>Loading...</div></div>; }

/* ================================================================
   MAIN APP
   ================================================================ */
export default function App() {
  const [user, setUser] = useState(null); // { profile, courses }
  const [ck, setCk] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginErr, setLoginErr] = useState('');
  const [isSignup, setIsSignup] = useState(false);
  const [signupCode, setSignupCode] = useState('');
  const [signupFirst, setSignupFirst] = useState('');
  const [signupLast, setSignupLast] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [hasPastEnrollments, setHasPastEnrollments] = useState(false); // student had enrollments in a PRIOR term only
  const [termNow, setTermNow] = useState(CURRENT_TERM); // active term, mirrored into state for rendering
  const [termPending, setTermPending] = useState(null); // term awaiting confirmation in the dialog
  const [termSwitching, setTermSwitching] = useState(false);
  const [termCourses, setTermCourses] = useState(Object.keys(COURSES)); // courses being taught in the term you are switching TO
  const [courseCodes, setCourseCodes] = useState([]);
  const [codesLoading, setCodesLoading] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [cutoffDraft, setCutoffDraft] = useState(''); // yyyy-mm-dd in the cutoff picker
  const [cutoffBusy, setCutoffBusy] = useState(false);
  // Settings section collapse state — Settings has grown, so each block folds.
  const [expSemester, setExpSemester] = useState(false);
  const [expSetup, setExpSetup] = useState(false);
  const [expCodes, setExpCodes] = useState(false);
  const [expManageStudents, setExpManageStudents] = useState(true);
  const [joinErr, setJoinErr] = useState(''); // '' | error string | { ok: true, msg: string }
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotMsg, setForgotMsg] = useState(''); // confirmation message after submission

  // Course data
  // Course data — single object to prevent multiple re-renders
  const [courseData, setCourseData] = useState({ rel: [], dueDates: {}, dueDatesAll: {}, students: [], iS: {}, iN: {}, sC: {}, cP: {}, toks: {}, fq: [], teachDates: [], teachSel: [], myInstrSt: {}, myQueue: {} });
  const [dataLoading, setDataLoading] = useState(false);
  const { rel, dueDates, dueDatesAll, students, iS, iN, sC, cP, toks, fq, teachDates, teachSel, myInstrSt, myQueue } = courseData;

  // Practicum (SR1) — loaded separately from courseData because it is not
  // course-scoped. The roster is the ~8 candidates supervised in the field
  // this term, which is independent of which course is selected above.
  const [sr1, setSr1] = useState({ buildings: [], roster: [], windows: [], bookings: [], taken: [], mySup: null, myBookings: [], myNotifs: [] });
  const [sr1Loading, setSr1Loading] = useState(false);
  const [expSr1Windows, setExpSr1Windows] = useState(false); // collapsed by default
  const [expSr1Roster, setExpSr1Roster] = useState(false);
  const [expSr1Student, setExpSr1Student] = useState(false);
  const [sr1OpenCandidate, setSr1OpenCandidate] = useState(null); // accordion
  const [sr1EditBooking, setSr1EditBooking] = useState(null);     // instructor edit modal
  const [sr1BookWindow, setSr1BookWindow] = useState(null);       // student booking modal
  const [sr1Busy, setSr1Busy] = useState(false);

  // UI state
  const [tab, setTab] = useState('overview');
  const [batch, setBatch] = useState(false);
  const [batchAsgn, setBatchAsgn] = useState('');
  const [prepView, setPrepView] = useState(false);
  const [prepItem, setPrepItem] = useState('');
  const [sortBy, setSortBy] = useState('last');
  const [drill, setDrill] = useState(null);
  const [modal, setModal] = useState(null);
  const [tfType, setTfType] = useState('revision');
  const [tfNote, setTfNote] = useState('');
  const [tfLink, setTfLink] = useState('');
  const [tfExtra, setTfExtra] = useState('');
  const [tfSubmitting, setTfSubmitting] = useState(false);
  const [noteFor, setNoteFor] = useState(null);
  const [noteVal, setNoteVal] = useState('');
  const [editDue, setEditDue] = useState(null);
  const [editDueVal, setEditDueVal] = useState('');
  // Per-section due-date editing (4850 only). editDueSectioned toggles the LS/WB fields
  // open for the row currently being edited. editDueSecVals holds the per-section field
  // values while editing: { [sectionKey]: { date, label } }.
  const [editDueSectioned, setEditDueSectioned] = useState(false);
  const [editDueSecVals, setEditDueSecVals] = useState({});
  const [queueFilter, setQueueFilter] = useState('pending');
  const [tokExpand, setTokExpand] = useState(null);
  const [tokSearch, setTokSearch] = useState('');
  const [gridSearch, setGridSearch] = useState('');
  const [cpGridSearch, setCpGridSearch] = useState('');
  const [batchSearch, setBatchSearch] = useState('');
  const [teachDateFilter, setTeachDateFilter] = useState('all');
  const [teachSearch, setTeachSearch] = useState('');
  const [sectionFilter, setSectionFilter] = useState('all');
  const [editDueDate, setEditDueDate] = useState('');
  const [editTeachDate, setEditTeachDate] = useState(null); // { id } — which date row is being edited (keyed by row id, since a date can exist per section)
  const [editTeachDateVal, setEditTeachDateVal] = useState('');
  const [newTeachDate, setNewTeachDate] = useState({}); // { [aid]: 'YYYY-MM-DD' } — add-date inputs per lesson
  const [newTeachSection, setNewTeachSection] = useState({}); // { [aid]: '' | 'LS' | 'WB' } — which section a new date is offered to ('' = both)
  const [expScheduled, setExpScheduled] = useState(false);
  const [expStudents, setExpStudents] = useState(true);
  const [expStruggles, setExpStruggles] = useState(true);
  const [expTokLookup, setExpTokLookup] = useState(false);
  const [expClassPrep, setExpClassPrep] = useState(true);
  const [expTeachSched, setExpTeachSched] = useState(true);
  const [expFinalGrades, setExpFinalGrades] = useState(false);
  const [expTracks, setExpTracks] = useState(false);
  const [expTokens, setExpTokens] = useState(false);
  const [expPrep, setExpPrep] = useState(false);
  const [expTeach, setExpTeach] = useState(true);
  const [toast, setToast] = useState(null); // { msg, type }
  const [previewStudent, setPreviewStudent] = useState(null); // { id, name } — instructor preview of student view
  const [editStudentId, setEditStudentId] = useState(null); // profile id of student whose name is being edited
  const [editFirstName, setEditFirstName] = useState('');
  const [editLastName, setEditLastName] = useState('');
  const [removeConfirm, setRemoveConfirm] = useState(null); // { id, name } — student pending removal confirmation
  const [showDropped, setShowDropped] = useState(false);
  const [droppedStudents, setDroppedStudents] = useState([]);
  const [droppedLoading, setDroppedLoading] = useState(false);
  const [studentMgmtSearch, setStudentMgmtSearch] = useState('');

  const showToast = (msg, type = 'error') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  // Check auth on mount
  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    const { data: { session } } = await supabase.auth.getSession();
    // Resolve the active term FIRST — every enrollment/course read below filters
    // on it. Loading it after would filter the first render on the stale fallback.
    await loadActiveTerm();
    await loadTermSettings(activeTerm());
    setTermNow(activeTerm());
    if (session?.user) {
      const profile = await loadUserProfile(session.user.email);
      if (profile) {
        const courses = await loadEnrollments(profile.id);
        // No current-term enrollments? Find out whether she ever had any, so we can
        // tell "your course has ended" apart from "you haven't joined anything."
        if (courses.length === 0 && profile.role === 'student') {
          const anyEnr = await loadAnyEnrollments(profile.id);
          setHasPastEnrollments(anyEnr.length > 0);
        } else {
          setHasPastEnrollments(false);
        }
        setUser({ profile, courses });
        if (courses.length === 1) setCk(courses[0].key);
      }
    }
    setLoading(false);
  }

  // Load course data when ck changes
  useEffect(() => {
    if (ck && user) loadCourseData();
  }, [ck, user]);

  // Practicum loads once per session on the user, NOT on ck — the roster spans
  // the term rather than a course, so changing the course selector must not
  // refetch it.
  useEffect(() => {
    if (user) loadSr1(true);
  }, [user]);

  async function loadCourseData(isInitial = true) {
    if (isInitial) setDataLoading(true);
    const isStudent = user.profile.role === 'student';
    // Refresh token cutoffs on every course load, not just at sign-in. Otherwise a
    // student already in a session keeps the cutoff that was live when she signed
    // in, and would not see an extended deadline until she re-authenticated.
    await loadTermSettings(activeTerm());
    // A student resolves due dates to their own section; the instructor loads the
    // "all sections" view (null) — the Settings editor works off dueDatesAll, and the
    // feed/grid correctly show the all-sections row as the default.
    const mySection = isStudent ? (user.courses.find(co => co.key === ck)?.section || null) : null;
    const [r, dd, s, is, inn, sc, cp, t, f, td, ts, mis, mq] = await Promise.all([
      loadReleasedAssignments(ck),
      loadDueDates(ck, mySection),
      !isStudent ? loadStudentsForCourse(ck) : Promise.resolve([]),
      !isStudent ? loadInstrStatuses(ck) : Promise.resolve({}),
      !isStudent ? loadInstrNotes(ck) : Promise.resolve({}),
      loadStudentChecks(ck, isStudent ? user.profile.id : null),
      loadClassPrep(ck, isStudent ? user.profile.id : null),
      loadTokens(ck, isStudent ? user.profile.id : null),
      !isStudent ? loadFeedbackQueue(ck) : Promise.resolve([]),
      loadTeachingDates(ck),
      loadTeachingSelections(ck, isStudent ? user.profile.id : null),
      isStudent ? loadMyInstrStatuses(ck, user.profile.id) : Promise.resolve({}),
      isStudent ? loadMyQueue(ck, user.profile.id) : Promise.resolve({}),
    ]);
    setCourseData({ rel: r, dueDates: dd.dueDates, dueDatesAll: dd.dueDatesAll, students: s, iS: is, iN: inn, sC: sc, cP: cp, toks: t, fq: f, teachDates: td, teachSel: ts, myInstrSt: mis, myQueue: mq });
    if (isInitial) setDataLoading(false);
  }

  const refresh = () => loadCourseData(false);

  // Practicum data. Deliberately NOT part of loadCourseData: it is term-scoped
  // but not course-scoped, so switching courses must not re-fetch it, and an
  // instructor who supervises nobody this term simply gets empty arrays.
  async function loadSr1(isInitial = false) {
    if (!user?.profile) return;
    const instr = user.profile.role === 'instructor';
    if (isInitial) setSr1Loading(true);
    try {
      if (instr) {
        const [b, r, w, bk, tk] = await Promise.all([
          loadSr1Buildings(), loadSr1Supervision(), loadSr1Windows(),
          loadSr1Bookings(), loadSr1TakenTimes()
        ]);
        setSr1(s => ({ ...s, buildings: b, roster: r, windows: w, bookings: bk, taken: tk }));
      } else {
        const sup = await loadMySr1Supervision(user.profile.id);
        if (!sup) {
          // Not supervised this term — the section never renders.
          setSr1(s => ({ ...s, mySup: null, myBookings: [], myNotifs: [], windows: [], taken: [], buildings: [] }));
        } else {
          const [b, w, mb, tk, nf] = await Promise.all([
            loadSr1Buildings(), loadSr1Windows(),
            loadMySr1Bookings(user.profile.id), loadSr1TakenTimes(),
            loadMySr1Notifications(user.profile.id)
          ]);
          setSr1(s => ({ ...s, mySup: sup, buildings: b, windows: w, myBookings: mb, taken: tk, myNotifs: nf }));
        }
      }
    } catch {
      // Tables missing (migration not yet run) — leave the feature dormant
      // rather than breaking the rest of the app.
    }
    if (isInitial) setSr1Loading(false);
  }
  const refreshSr1 = () => loadSr1(false);

  // ---- TERM SWITCHING ----------------------------------------------------
  // Confirmed via dialog. On confirm: persist the new term, make sure the
  // instructor has an enrollment in every course for it (otherwise her course
  // list comes back empty), then reload from scratch.
  async function confirmTermSwitch() {
    if (!termPending || termSwitching) return;
    setTermSwitching(true);
    const target = termPending;
    try {
      const { error } = await setActiveTerm(target);
      if (error) { showToast('Could not change the term — please try again.'); return; }

      const { error: enrErr } = await ensureInstructorEnrollments(user.profile.id, target, termCourses);
      if (enrErr) showToast('Term changed, but your course enrollments may need attention.', 'error');

      await loadTermSettings(target);
      setCutoffDraft('');
      setTermNow(target);
      setTermPending(null);
      setCk(null);           // drop back to the course list; old course is gone
      setCourseCodes([]);
      const courses = await loadEnrollments(user.profile.id);
      setUser(u => ({ ...u, courses }));
      showToast(`Now showing ${target}.`, 'success');
    } finally {
      setTermSwitching(false);
    }
  }

  // ---- COPY DUE DATES ----------------------------------------------------
  async function handleCopyDueDates(fromTerm) {
    if (copyBusy || !fromTerm) return;
    setCopyBusy(true);
    try {
      const { copied, error } = await copyDueDatesFromTerm(ck, fromTerm, activeTerm());
      if (error) { showToast('Could not copy due dates — please try again.'); return; }
      if (copied === 0) { showToast('Nothing to copy — those items already have dates this term.', 'success'); return; }
      showToast(`${copied} due date${copied === 1 ? '' : 's'} copied. Adjust them below.`, 'success');
      refresh();
    } finally {
      setCopyBusy(false);
    }
  }

  // ---- TOKEN CUTOFF ------------------------------------------------------
  async function handleSaveCutoff() {
    if (cutoffBusy) return;
    setCutoffBusy(true);
    try {
      const { error } = await setTokenCutoff(ck, activeTerm(), cutoffDraft);
      if (error) { showToast('Could not save the token cutoff — please try again.'); return; }
      showToast(cutoffDraft ? `Token cutoff set to ${cutoffLabelFor(ck)}.` : 'Token cutoff cleared — using the course default.', 'success');
      refresh();
    } finally {
      setCutoffBusy(false);
    }
  }

  // ---- COURSE CODES ------------------------------------------------------
  async function openCourseCodes() {
    setCodesLoading(true);
    setCourseCodes(await loadCourseCodes());
    setCodesLoading(false);
  }

  async function toggleCourseCode(code, next) {
    const prev = courseCodes;
    setCourseCodes(cs => cs.map(c2 => c2.code === code ? { ...c2, active: next } : c2)); // optimistic
    const { error } = await setCourseCodeActive(code, next);
    if (error) { setCourseCodes(prev); showToast('Could not update that course code.'); }
  }

  // ---- TEST ACCOUNTS -----------------------------------------------------
  async function toggleTestAccount(profileId, next) {
    const prevData = courseData;
    setCourseData(d => ({ ...d, students: d.students.map(st => st.id === profileId ? { ...st, isTest: next } : st) })); // optimistic
    const { error } = await setEnrollmentTest(profileId, ck, next);
    if (error) { setCourseData(prevData); showToast('Could not update that account.'); }
  }


  // Save an item's due dates: always writes the "all sections" row, and (when the
  // per-section editor is open) writes/clears each section's override row.
  // Optimistic: updates dueDates (flat, resolved for the instructor's null default =
  // all-sections row) and dueDatesAll immediately, then persists in the background.
  // Rolls back with a toast on failure. No refresh() — matches the optimistic pattern.
  async function saveDueDatesForItem(itemId, allVals, secVals) {
    const prevData = courseData;
    const secKeys = Object.keys(secVals || {});
    // Build the new dueDatesAll entry for this item.
    const newAllEntry = {};
    if (allVals.date || allVals.label) newAllEntry.all = { date: allVals.date || null, label: allVals.label || null };
    secKeys.forEach(sk => {
      const v = secVals[sk];
      if (v && (v.date || v.label)) newAllEntry[sk] = { date: v.date || null, label: v.label || null };
    });
    // Optimistic UI: flat map (instructor default) shows the all-sections row.
    setCourseData(prev => {
      const nextAll = { ...prev.dueDatesAll };
      if (Object.keys(newAllEntry).length) nextAll[itemId] = newAllEntry; else delete nextAll[itemId];
      const nextFlat = { ...prev.dueDates };
      if (newAllEntry.all) nextFlat[itemId] = newAllEntry.all; else delete nextFlat[itemId];
      return { ...prev, dueDates: nextFlat, dueDatesAll: nextAll };
    });
    // Persist: all-sections row first, then each section override.
    const results = [];
    results.push(await upsertDueDate(ck, itemId, allVals.label, allVals.date, null));
    for (const sk of secKeys) {
      const v = secVals[sk] || {};
      results.push(await upsertDueDate(ck, itemId, v.label, v.date, sk));
    }
    const failed = results.find(r => r && r.error);
    if (failed) {
      setCourseData(prevData); // rollback
      showToast('Save failed — please try again', 'error');
      return false;
    }
    showToast('Due date saved ✓', 'success');
    return true;
  }

  // Clear all due-date rows (all sections + every override) for an item. Optimistic.
  async function clearDueDatesForItem(itemId, sectionKeys) {
    const prevData = courseData;
    setCourseData(prev => {
      const nextAll = { ...prev.dueDatesAll }; delete nextAll[itemId];
      const nextFlat = { ...prev.dueDates }; delete nextFlat[itemId];
      return { ...prev, dueDates: nextFlat, dueDatesAll: nextAll };
    });
    const results = [await upsertDueDate(ck, itemId, '', '', null)];
    for (const sk of (sectionKeys || [])) results.push(await upsertDueDate(ck, itemId, '', '', sk));
    if (results.find(r => r && r.error)) {
      setCourseData(prevData);
      showToast('Clear failed — please try again', 'error');
      return false;
    }
    showToast('Due date cleared', 'success');
    return true;
  }

  // Compact one-line summary of an item's due dates for the collapsed row.
  // Shows "All: <date>" plus any section overrides, e.g. "All: Aug 26 · LS: Aug 28".
  function dueSummary(itemId, secObj) {
    const entry = dueDatesAll?.[itemId];
    if (!entry) return null;
    const fmt = (v) => {
      if (!v) return '';
      const d = v.date ? new Date(v.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
      return `${d}${v.date && v.label ? ' · ' : ''}${v.label || ''}`;
    };
    const parts = [];
    if (entry.all) parts.push(`All: ${fmt(entry.all)}`);
    Object.keys(secObj || {}).forEach(sk => { if (entry[sk]) parts.push(`${sk}: ${fmt(entry[sk])}`); });
    return parts.length ? parts.join('  ·  ') : null;
  }

  // Open the editor for an item, pre-filling the all-sections fields and any existing
  // per-section overrides (so the toggle opens showing what's already set).
  function openDueEditor(itemId, sectionsObj) {
    const entry = dueDatesAll?.[itemId] || {};
    setEditDue(itemId);
    setEditDueVal(entry.all?.label || '');
    setEditDueDate(entry.all?.date || '');
    const secKeys = sectionsObj ? Object.keys(sectionsObj) : [];
    const hasOverride = secKeys.some(sk => entry[sk]);
    setEditDueSectioned(hasOverride);
    const secVals = {};
    secKeys.forEach(sk => { secVals[sk] = { date: entry[sk]?.date || '', label: entry[sk]?.label || '' }; });
    setEditDueSecVals(secVals);
  }

  // Renders the expanded due-date editor for one item (assignment or class prep).
  // `sectionsObj` = the course's sections ({} or null when the course has no sections).
  // When sections exist, a "Set different dates per section" switch reveals per-section
  // fields. Shared by both the assignment and class-prep editors.
  function renderDueEditor(itemId, itemName, sectionsObj, accent) {
    const secKeys = sectionsObj ? Object.keys(sectionsObj) : [];
    const hasSecs = secKeys.length > 0;
    const saveAndClose = async () => {
      const ok = await saveDueDatesForItem(itemId, { date: editDueDate, label: editDueVal }, editDueSectioned ? editDueSecVals : {});
      if (ok) { setEditDue(null); setEditDueSectioned(false); setEditDueSecVals({}); }
    };
    return <div style={{ padding: "4px 16px 12px 16px" }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <input type="date" value={editDueDate} onChange={e => setEditDueDate(e.target.value)} aria-label={`${hasSecs ? 'All sections due date' : 'Due date'} for ${itemName}`} autoFocus style={{ padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, outline: "none" }} />
        <input value={editDueVal} onChange={e => setEditDueVal(e.target.value)} placeholder="e.g. Before class, By end of day" aria-label={`${hasSecs ? 'All sections due date note' : 'Due date note'} for ${itemName}`} onKeyDown={e => { if (e.key === "Enter") saveAndClose(); }} style={{ flex: 2, minWidth: 140, padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, outline: "none" }} />
        <button onClick={saveAndClose} style={{ padding: "5px 10px", background: accent, color: "#fff", border: "none", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Save</button>
        <button onClick={async () => { const ok = await clearDueDatesForItem(itemId, secKeys); if (ok) { setEditDue(null); setEditDueSectioned(false); setEditDueSecVals({}); } }} style={{ padding: "5px 8px", background: "#F5F4F0", color: "#6B6B6B", border: "1px solid #E8E6E1", borderRadius: 5, fontFamily: F.b, fontSize: 11, cursor: "pointer" }}>Clear</button>
      </div>
      {hasSecs && <div style={{ marginTop: 8 }}>
        <button role="switch" aria-checked={editDueSectioned} aria-label={`Set different due dates per section for ${itemName}`}
          onClick={() => setEditDueSectioned(v => !v)}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 4px", background: "none", border: "none", cursor: "pointer", fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>
          <span style={{ width: 30, height: 16, borderRadius: 8, background: editDueSectioned ? accent : "#D5D2CC", position: "relative", transition: "background .2s", flexShrink: 0 }}>
            <span style={{ position: "absolute", top: 2, left: editDueSectioned ? 16 : 2, width: 12, height: 12, borderRadius: "50%", background: "#fff", transition: "left .2s" }} />
          </span>
          Set different dates per section
        </button>
        {editDueSectioned && <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontFamily: F.b, fontSize: 10, color: "#767676" }}>Leave a section blank to use the all-sections date above.</div>
          {secKeys.map(sk => {
            const v = editDueSecVals[sk] || { date: '', label: '' };
            const setV = (patch) => setEditDueSecVals(prev => ({ ...prev, [sk]: { ...(prev[sk] || { date: '', label: '' }), ...patch } }));
            return <div key={sk} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, color: accent, minWidth: 90 }}>{sectionsObj[sk]?.name || sk}</span>
              <input type="date" value={v.date} onChange={e => setV({ date: e.target.value })} aria-label={`${sectionsObj[sk]?.name || sk} due date for ${itemName}`} style={{ padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, outline: "none" }} />
              <input value={v.label} onChange={e => setV({ label: e.target.value })} placeholder="Note (optional)" aria-label={`${sectionsObj[sk]?.name || sk} due date note for ${itemName}`} onKeyDown={e => { if (e.key === "Enter") saveAndClose(); }} style={{ flex: 2, minWidth: 120, padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, outline: "none" }} />
            </div>;
          })}
        </div>}
      </div>}
    </div>;
  }

  async function handleLogin() {
    setLoginErr('');
    const { error } = await supabase.auth.signInWithPassword({ email: loginEmail, password: loginPass });
    if (error) {
      if (error.message.includes('Invalid login')) {
        setLoginErr('Invalid email or password. If this is your first time, click "First time? Create account".');
      } else {
        setLoginErr(error.message);
      }
      return;
    }
    await checkAuth();
  }

  async function handleSignup() {
    setLoginErr('');
    const email = loginEmail.trim().toLowerCase();
    
    // Validate UCM email
    if (!email.endsWith('@ucmo.edu')) {
      setLoginErr('Please use your UCM email address (@ucmo.edu).');
      return;
    }
    
    // Validate name fields
    if (!signupFirst.trim() || !signupLast.trim()) {
      setLoginErr('Please enter your first and last name.');
      return;
    }
    
    // Validate course code
    const { data: courseCode } = await supabase.from('course_codes').select('*').eq('code', signupCode.trim().toUpperCase()).eq('active', true).single();
    if (!courseCode) {
      setLoginErr('Invalid course code. Check with Dr. Beggs for the correct code.');
      return;
    }
    
    // Create the auth account
    const { error } = await supabase.auth.signUp({ email, password: loginPass });
    
    // If already registered, try signing in with the provided password instead of showing an error.
    // This handles returning students who were in a previous course and are joining a new one.
    if (error) {
      if (error.message.includes('already registered') || error.message.includes('already been registered') || error.message.includes('User already registered')) {
        const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({ email, password: loginPass });
        if (signInErr) {
          // Password was wrong — give a clear, actionable message
          setLoginErr('You already have a Lumos account. Please use "Already have an account? Sign in" and enter your existing password.');
          return;
        }
        // Sign-in succeeded — fall through to enrollment logic below
        const authId = signInData.user.id;
        const existingEnrollments = await loadEnrollments(authId);
        const entry = existingEnrollments.find(e => e.key === courseCode.course_key);
        // loadEnrollments only returns activeTerm() rows, so `entry` missing means
        // she has no enrollment THIS term — insert one. A prior-term enrollment is
        // left untouched: it is her archived record, not something to reactivate.
        if (!entry) {
          await supabase.from('enrollments').insert({ profile_id: authId, course_key: courseCode.course_key, section: courseCode.section || null, term: activeTerm() });
        } else if (!entry.active) {
          // Dropped and rejoining WITHIN the current term — reactivate in place.
          await supabase.from('enrollments').update({ active: true, section: courseCode.section || null }).eq('profile_id', authId).eq('course_key', courseCode.course_key).eq('term', activeTerm());
        }
        await checkAuth();
        return;
      }
      setLoginErr(error.message);
      return;
    }
    
    // Sign in immediately (new account)
    const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({ email, password: loginPass });
    if (signInErr) { setLoginErr('Account created! Please sign in.'); setIsSignup(false); return; }
    
    const authId = signInData.user.id;
    
    // Check if profile already exists (for students who were in the original pilot)
    const existingProfile = await loadUserProfile(email);
    
    if (!existingProfile) {
      // Create new profile with the auth ID
      await supabase.from('profiles').insert({ id: authId, email, first_name: signupFirst.trim(), last_name: signupLast.trim(), role: 'student' });
      // Create enrollment with section if course code has one
      await supabase.from('enrollments').insert({ profile_id: authId, course_key: courseCode.course_key, section: courseCode.section || null, term: activeTerm() });
    } else if (existingProfile.id === authId) {
      // Returning student from another course — add enrollment for this course if not already enrolled
      const existingEnrollments = await loadEnrollments(authId);
      const entry = existingEnrollments.find(e => e.key === courseCode.course_key);
      // See note above: `entry` is scoped to activeTerm(), so absent means
      // "not enrolled this term" and a fresh row is correct. A retaking student
      // keeps her prior-term row intact alongside the new one.
      if (!entry) {
        await supabase.from('enrollments').insert({ profile_id: authId, course_key: courseCode.course_key, section: courseCode.section || null, term: activeTerm() });
      } else if (!entry.active) {
        // Dropped and rejoining WITHIN the current term — reactivate in place.
        await supabase.from('enrollments').update({ active: true, section: courseCode.section || null }).eq('profile_id', authId).eq('course_key', courseCode.course_key).eq('term', activeTerm());
      }
    } else {
      // Profile exists but with wrong ID — this shouldn't happen with new flow but just in case
      setLoginErr('Account issue — contact Dr. Beggs.');
      return;
    }
    
    await checkAuth();
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setUser(null); setCk(null); setLoginEmail(''); setLoginPass(''); setLoginErr(''); setSignupCode(''); setSignupFirst(''); setSignupLast('');
  }

  async function handleForgotPassword() {
    setForgotMsg('');
    const email = forgotEmail.trim().toLowerCase();
    if (!email) { setForgotMsg('error:Please enter your email address.'); return; }
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/`
    });
    // Always show neutral success — Supabase does not reveal whether the email exists (privacy)
    setForgotMsg('ok:If an account exists for that email, a reset link is on its way. Check your spam folder too.');
  }

  async function handleJoinCourse() {
    setJoinErr('');
    const code = joinCode.trim().toUpperCase();
    if (!code) { setJoinErr('Please enter a course code.'); return; }

    // Validate the code is active
    const { data: courseCode } = await supabase.from('course_codes').select('*').eq('code', code).eq('active', true).single();
    if (!courseCode) { setJoinErr('Invalid course code. Check with Dr. Beggs for the correct code.'); return; }

    // Check not already enrolled
    const existing = await loadEnrollments(user.profile.id);
    const existingEntry = existing.find(e => e.key === courseCode.course_key);
    if (existingEntry && existingEntry.active) {
      setJoinErr("You're already enrolled in that course.");
      return;
    }

    if (existingEntry && !existingEntry.active) {
      // Re-joining a course she was previously dropped from — reactivate rather than duplicate-insert
      // Dropped and rejoining WITHIN the current term — reactivate in place.
      // (existingEntry comes from loadEnrollments, which is activeTerm()-scoped.)
      const { error } = await supabase.from('enrollments').update({ active: true, section: courseCode.section || null }).eq('profile_id', user.profile.id).eq('course_key', courseCode.course_key).eq('term', activeTerm());
      if (error) { setJoinErr('Something went wrong — please try again or contact Dr. Beggs.'); return; }
    } else {
      // Add enrollment
      const { error } = await supabase.from('enrollments').insert({ profile_id: user.profile.id, course_key: courseCode.course_key, section: courseCode.section || null, term: activeTerm() });
      if (error) { setJoinErr('Something went wrong — please try again or contact Dr. Beggs.'); return; }
    }

    setJoinCode('');
    setJoinErr({ ok: true, msg: 'Course added! Select it below.' });
    await checkAuth();
  }

  // ---- LOADING ----
  if (loading) return <Loading />;

  // ---- LOGIN ----
  if (!user) return (
    <main style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
      <div style={{ maxWidth: 420, width: "100%", padding: "0 20px" }}>
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div aria-hidden="true" style={{ display: "inline-block", padding: "4px 10px", background: "#CF202E", color: "#fff", fontFamily: F.b, fontSize: 11, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase", borderRadius: 3, marginBottom: 14 }}>Lumos</div>
          <h1 style={{ fontSize: 30, fontWeight: 700, color: "#1A1A1A", lineHeight: 1.15, marginBottom: 6 }}>Learning, illuminated.</h1>
          <p style={{ fontFamily: F.b, fontSize: 13, color: "#6B6B6B" }}>Own your learning. Track your growth. Pursue mastery.</p>
        </div>
        <div role="region" aria-label={forgotMode ? "Reset password" : isSignup ? "Create account" : "Sign in"} style={{ background: "#fff", border: "1px solid #E8E6E1", borderRadius: 10, padding: "20px" }}>
          {forgotMode ? (
            <>
              <h2 style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em", color: "#6B6B6B", marginBottom: 10 }}>Reset Password</h2>
              <p style={{ fontFamily: F.b, fontSize: 12, color: "#555", marginBottom: 12, lineHeight: 1.5 }}>Enter your UCM email and we'll send you a link to reset your password.</p>
              <input value={forgotEmail} onChange={e => { setForgotEmail(e.target.value); setForgotMsg(''); }} placeholder="UCM email (@ucmo.edu)" aria-label="UCM email address for password reset" type="email"
                onKeyDown={e => { if (e.key === 'Enter') handleForgotPassword(); }}
                style={{ width: "100%", padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13, marginBottom: 8, boxSizing: "border-box", outline: "none" }} />
              {forgotMsg && (
                <div role="alert" aria-live="polite" style={{ fontFamily: F.b, fontSize: 11, color: forgotMsg.startsWith('ok:') ? "#2D6A4F" : "#C0392B", marginBottom: 10, lineHeight: 1.4, background: forgotMsg.startsWith('ok:') ? "#D4EDDA" : "#FFF0F0", padding: "8px 10px", borderRadius: 6 }}>
                  {forgotMsg.replace(/^(ok|error):/, '')}
                </div>
              )}
              <button onClick={handleForgotPassword}
                style={{ width: "100%", padding: "10px", background: "#CF202E", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: F.b, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
                Send Reset Link
              </button>
              <button onClick={() => { setForgotMode(false); setForgotMsg(''); setForgotEmail(''); }}
                style={{ width: "100%", padding: "8px", background: "none", border: "none", cursor: "pointer", fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>
                ← Back to sign in
              </button>
            </>
          ) : (
            <>
              <h2 style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em", color: "#6B6B6B", marginBottom: 10 }}>
                {isSignup ? "Create Your Account" : "Sign In"}
              </h2>
              {isSignup && <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <input value={signupFirst} onChange={e => { setSignupFirst(e.target.value); setLoginErr(''); }} placeholder="First name" aria-label="First name"
                  style={{ flex: 1, padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13, boxSizing: "border-box", outline: "none" }} />
                <input value={signupLast} onChange={e => { setSignupLast(e.target.value); setLoginErr(''); }} placeholder="Last name" aria-label="Last name"
                  style={{ flex: 1, padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13, boxSizing: "border-box", outline: "none" }} />
              </div>}
              <input value={loginEmail} onChange={e => { setLoginEmail(e.target.value); setLoginErr(''); }} placeholder="UCM email (@ucmo.edu)" aria-label="UCM email"
                style={{ width: "100%", padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13, marginBottom: 8, boxSizing: "border-box", outline: "none" }} />
              <input value={loginPass} onChange={e => { setLoginPass(e.target.value); setLoginErr(''); }} placeholder={isSignup ? "Create a password (6+ characters)" : "Password"} type="password" aria-label="Password"
                onKeyDown={e => { if (e.key === 'Enter' && !isSignup) handleLogin(); }}
                style={{ width: "100%", padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13, marginBottom: isSignup ? 8 : 4, boxSizing: "border-box", outline: "none" }} />
              {!isSignup && (
                <div style={{ textAlign: "right", marginBottom: 10 }}>
                  <button onClick={() => { setForgotMode(true); setForgotEmail(loginEmail); setForgotMsg(''); }} aria-label="Forgot your password? Reset it here"
                    style={{ background: "none", border: "none", cursor: "pointer", fontFamily: F.b, fontSize: 11, color: "#1565C0", padding: 0 }}>
                    Forgot password?
                  </button>
                </div>
              )}
              {isSignup && <input value={signupCode} onChange={e => { setSignupCode(e.target.value); setLoginErr(''); }} placeholder="Course code (provided by Dr. Beggs)" aria-label="Course code"
                onKeyDown={e => { if (e.key === 'Enter') handleSignup(); }}
                style={{ width: "100%", padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13, marginBottom: 4, boxSizing: "border-box", outline: "none" }} />}
              {isSignup && <div style={{ fontFamily: F.b, fontSize: 11, color: "#767676", marginBottom: 12, paddingLeft: 2 }}>Example: MATH4850 or MATH3820</div>}
              {loginErr && <div role="alert" aria-live="assertive" style={{ fontFamily: F.b, fontSize: 11, color: "#C0392B", marginBottom: 10, lineHeight: 1.4 }}>{loginErr}</div>}
              <button onClick={isSignup ? handleSignup : handleLogin}
                style={{ width: "100%", padding: "10px", background: "#CF202E", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: F.b, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
                {isSignup ? "Create Account" : "Sign In"}
              </button>
              <button onClick={() => { setIsSignup(!isSignup); setLoginErr(''); }}
                style={{ width: "100%", padding: "8px", background: "none", border: "none", cursor: "pointer", fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>
                {isSignup ? "Already have an account? Sign in" : "First time? Create account"}
              </button>
            </>
          )}
        </div>
        <div style={{ marginTop: 20, padding: "12px 16px", background: "#F9F8F5", borderRadius: 8, border: "1px solid #E8E6E1" }}>
          <div style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 4 }}>Accessibility Statement</div>
          <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", lineHeight: 1.5 }}>Lumos is committed to ensuring digital accessibility for all users. This application conforms to WCAG 2.1 Level AA standards and is designed to work with screen readers, keyboard navigation, and assistive technologies. If you experience any accessibility barriers, please contact Dr. Beggs at <a href="mailto:mbeggs@ucmo.edu" style={{ color: "#1565C0" }}>mbeggs@ucmo.edu</a>.</div>
        </div>
      </div>
    </main>
  );

  // ---- COURSE ENDED ----
  // A student whose only enrollments belong to a past term. Her records are kept
  // in the database; the app simply no longer loads them. Mirrors the existing
  // "no longer enrolled" treatment rather than showing an empty course list.
  if (user.profile.role === 'student' && user.courses.length === 0 && hasPastEnrollments) {
    return (
      <div>
        <a href="#main-content" className="skip-link">Skip to main content</a>
        <header style={{ borderBottom: "1px solid #E8E6E1", background: "#fff" }}>
          <div style={{ maxWidth: 600, margin: "0 auto", padding: "10px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>{user.profile.first_name} {user.profile.last_name}</span>
            <button onClick={handleLogout} aria-label="Sign out" style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", background: "none", border: "1px solid #E0DDD8", borderRadius: 4, padding: "3px 8px", cursor: "pointer" }}>Sign out</button>
          </div>
        </header>
        <main id="main-content" style={{ maxWidth: 600, margin: "0 auto", padding: "40px 20px" }}>
          <div role="status" style={{ padding: "24px 20px", background: "#F5F4F0", border: "2px solid #E8E6E1", borderRadius: 10 }}>
            <h1 style={{ fontFamily: F.d, fontSize: 20, fontWeight: 700, marginBottom: 8, color: "#1A1A1A" }}>This course has ended</h1>
            <p style={{ fontFamily: F.b, fontSize: 13, color: "#555", lineHeight: 1.6, margin: 0 }}>
              Your coursework is complete and this course is no longer active in Lumos. Your final grade is recorded in your official university record.
            </p>
            <p style={{ fontFamily: F.b, fontSize: 13, color: "#555", lineHeight: 1.6, marginTop: 12, marginBottom: 0 }}>
              If you have a question about your grade, contact Dr. Beggs at <a href="mailto:mbeggs@ucmo.edu" style={{ color: "#1565C0" }}>mbeggs@ucmo.edu</a>.
            </p>
          </div>

          {/* She may be starting a new course this term — let her join. */}
          <div style={{ marginTop: 28, paddingTop: 24, borderTop: "1px solid #E8E6E1" }}>
            <h2 style={{ fontFamily: F.b, fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "#555", marginBottom: 12 }}>Starting a New Course?</h2>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={joinCode}
                onChange={e => { setJoinCode(e.target.value); setJoinErr(''); }}
                onKeyDown={e => { if (e.key === 'Enter') handleJoinCourse(); }}
                placeholder="Course code (provided by Dr. Beggs)"
                aria-label="Course code to join"
                style={{ flex: 1, padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13, boxSizing: "border-box", outline: "none" }}
              />
              <button
                onClick={handleJoinCourse}
                aria-label="Join course"
                style={{ padding: "8px 16px", background: "#CF202E", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: F.b, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>
                Join
              </button>
            </div>
            {joinErr && (
              <div role="alert" aria-live="assertive" style={{ fontFamily: F.b, fontSize: 11, marginTop: 8, color: joinErr.ok ? "#2D6A4F" : "#C0392B" }}>
                {joinErr.ok ? joinErr.msg : joinErr}
              </div>
            )}
          </div>
        </main>
      </div>
    );
  }

  // ---- COURSE SELECT ----
  if (!ck) {
    return (
      <div>
        <a href="#main-content" className="skip-link">Skip to main content</a>
        <header style={{ borderBottom: "1px solid #E8E6E1", background: "#fff" }}>
          <div style={{ maxWidth: 600, margin: "0 auto", padding: "10px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>{user.profile.first_name} {user.profile.last_name} ({user.profile.role})</span>
            <button onClick={handleLogout} aria-label="Sign out" style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", background: "none", border: "1px solid #E0DDD8", borderRadius: 4, padding: "3px 8px", cursor: "pointer" }}>Sign out</button>
          </div>
        </header>
        <main id="main-content" style={{ maxWidth: 600, margin: "0 auto", padding: "40px 20px" }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 20 }}>Select Course</h1>
          {user.courses.map(({ key: k, active }) => {
            const co = COURSES[k]; if (!co) return null;
            if (!active) return (
              <div key={k} aria-label={`${co.title} - no longer enrolled`} style={{ display: "block", width: "100%", padding: "16px 20px", marginBottom: 8, background: "#F5F4F0", border: "2px solid #E8E6E1", borderRadius: 10, textAlign: "left", position: "relative", overflow: "hidden", opacity: 0.7 }}>
                <div style={{ fontFamily: F.d, fontSize: 16, fontWeight: 600, color: "#767676" }}>{co.title}</div>
                <div style={{ fontFamily: F.b, fontSize: 11, color: "#C0392B", marginTop: 2 }}>You're no longer enrolled</div>
              </div>
            );
            return <button key={k} onClick={() => setCk(k)} aria-label={`${co.title} - ${co.assignments.length} assignments`} style={{ display: "block", width: "100%", padding: "16px 20px", marginBottom: 8, background: "#fff", border: "2px solid #E8E6E1", borderRadius: 10, cursor: "pointer", textAlign: "left", position: "relative", overflow: "hidden" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = co.color} onMouseLeave={e => e.currentTarget.style.borderColor = "#E8E6E1"}>
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, background: co.color }} aria-hidden="true" />
              <div style={{ fontFamily: F.d, fontSize: 16, fontWeight: 600 }}>{co.title}</div>
              <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>{co.assignments.length} assignments</div>
            </button>;
          })}

          {/* Join another course — students only */}
          {user.profile.role === 'student' && (
            <div style={{ marginTop: 28, paddingTop: 24, borderTop: "1px solid #E8E6E1" }}>
              <h2 style={{ fontFamily: F.b, fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "#555", marginBottom: 12 }}>Join Another Course</h2>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={joinCode}
                  onChange={e => { setJoinCode(e.target.value); setJoinErr(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') handleJoinCourse(); }}
                  placeholder="Course code (e.g. FAMILY3468)"
                  aria-label="Course code to join"
                  style={{ flex: 1, padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13, boxSizing: "border-box", outline: "none" }}
                />
                <button
                  onClick={handleJoinCourse}
                  aria-label="Join course"
                  style={{ padding: "8px 16px", background: "#CF202E", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: F.b, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>
                  Join
                </button>
              </div>
              {joinErr && (
                <div role="alert" aria-live="assertive" style={{ fontFamily: F.b, fontSize: 11, marginTop: 8, color: joinErr.ok ? "#2D6A4F" : "#C0392B" }}>
                  {joinErr.ok ? joinErr.msg : joinErr}
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    );
  }

  if (dataLoading) return <Loading />;

  const c = COURSES[ck];
  const isInstr = user.profile.role === 'instructor';
  const assignmentIds = new Set(c.assignments.map(a => a.id));
  // All assignments are now visible from day one — no release gating
  const relAssignments = c.assignments.map(a => a.id);

  // ---- STUDENT VIEW ----
  if (!isInstr) {
    const myEnrollment = user.courses.find(co => co.key === ck);
    if (myEnrollment && myEnrollment.active === false) {
      return (
        <div>
          <a href="#main-content" className="skip-link">Skip to main content</a>
          <header style={{ borderBottom: "1px solid #E8E6E1", background: "#fff" }}>
            <div style={{ maxWidth: 600, margin: "0 auto", padding: "10px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>{user.profile.first_name} {user.profile.last_name}</span>
              <button onClick={handleLogout} aria-label="Sign out" style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", background: "none", border: "1px solid #E0DDD8", borderRadius: 4, padding: "3px 8px", cursor: "pointer" }}>Sign out</button>
            </div>
          </header>
          <main id="main-content" style={{ maxWidth: 600, margin: "0 auto", padding: "60px 20px", textAlign: "center" }}>
            <h1 style={{ fontFamily: F.d, fontSize: 22, fontWeight: 700, marginBottom: 10 }}>You're no longer enrolled in {c.short}</h1>
            <div style={{ fontFamily: F.b, fontSize: 13, color: "#6B6B6B", lineHeight: 1.6, marginBottom: 24 }}>
              If you believe this is a mistake, please contact Dr. Beggs.
            </div>
            <button onClick={() => setCk(null)} style={{ padding: "8px 16px", background: c.color, color: "#fff", border: "none", borderRadius: 6, fontFamily: F.b, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>← Back to course list</button>
          </main>
        </div>
      );
    }
    const myId = user.profile.id;
    const myChecks = sC[myId] || {};
    const myPrep = cP[myId] || {};
    const myToks = toks[myId] || [];
    // myInstrSt is now { [assignmentId]: { status, updated_at } }
    // Derive a plain status map for the calc functions
    const myInstrStatuses = Object.fromEntries(Object.entries(myInstrSt).map(([k, v]) => [k, v?.status]));
    const grade = calcStudentGrade(myChecks, myInstrStatuses, relAssignments, ck, dueDates);
    const { target, blockers, msg: bMsg } = getBlockers(myChecks, relAssignments, ck, myInstrStatuses, dueDates);
    const tok = tokBal(myToks.length, 0);
    const cutoff = cutoffFor(ck);

    const handleCheck = async (aid) => {
      await toggleStudentCheck(myId, ck, aid);
      refresh();
    };
    const handlePrep = async (pid) => {
      await toggleClassPrep(myId, ck, pid);
      refresh();
    };
    // ---- PRACTICUM (student side) ----------------------------------------
    // Opens the booking form for a window, defaulting the lesson start to the
    // first genuinely open moment so she is not typing into a taken slot.
    const openSr1Book = (w) => {
      const gaps = sr1OpenGaps(w, sr1.taken).filter(g => !sr1TooSoon(g.start.toISOString()));
      const first = gaps[0];
      const timeOf = d => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: SR1_TZ });
      const start = first ? timeOf(first.start) : w.start_time.slice(0, 5);
      const end = first
        ? timeOf(new Date(Math.min(first.start.getTime() + 45 * 60000, first.end.getTime())))
        : '';
      setSr1BookWindow({ win: w, lessonStart: start, lessonEnd: end, topic: '', err: '' });
    };

    const handleStudentCancelSr1 = async (b) => {
      if (!confirm(`Cancel your observation on ${fmtDay(b.lesson_start)} at ${fmtTime(b.lesson_start)}?`)) return;
      const { error, blocked } = await cancelSr1Booking(b.id);
      // The 24-hour lockout lives in the RLS policy, so a late attempt simply
      // matches no rows rather than erroring.
      if (blocked) { showToast('That observation is within 24 hours — email Dr. Beggs at mbeggs@ucmo.edu to change it.'); return; }
      if (error) { showToast('Could not cancel — please try again.'); return; }
      showToast('Observation cancelled', 'success');
      refreshSr1();
    };

    const handleToken = async () => {
      if (!modal || tfSubmitting) return;
      setTfSubmitting(true);
      try {
        const note = tfType === 'extra' ? `Extra token: ${tfExtra}${tfNote ? ' — ' + tfNote : ''}` : tfNote;
        await submitToken(myId, ck, modal.id, tfType === 'extra' ? 'revision' : tfType, note, tfLink);
        setModal(null); setTfNote(''); setTfType('revision'); setTfLink(''); setTfExtra('');
        refresh();
      } finally {
        setTfSubmitting(false);
      }
    };

    const hasGroupToken = (gid) => myToks.some(t => t.assignment_id === gid);
    const isFirstInGroup = (a) => {
      if (!a.tokenGroup) return true;
      const grp = c.groups.find(g => g.tokenGroup === a.tokenGroup);
      if (!grp) return true;
      return grp.ids.find(id => relAssignments.includes(id) && !myChecks[id]) === a.id;
    };
    // Token submission status for a row. Answers "did my token go through?" —
    // the toast at submit time is gone by the next visit, so this persists it.
    //
    // DELIBERATELY does not reveal the OUTCOME. Whether the instructor marked M
    // or R must be learned by reading her feedback, not by reading the interface
    // (see Lumos-Grade-Calculation-Spec.md — the M-unchecked / R equivalence is
    // the whole point of Option A). So there is ONE neutral style, and the
    // resolved text says only that a review happened, never what it concluded.
    const tokenStatusFor = (a) => {
      const q = (myQueue || {})[a.id] || (a.tokenGroup ? (myQueue || {})[a.tokenGroup] : null);
      if (!q) return null;
      const when = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
      const kind = q.token_type === 'revision' ? 'Revision' : 'Late submission';
      const text = q.resolved
        ? `${kind} token submitted ${when(q.submitted_at)} — reviewed ${when(q.resolved_at)}`
        : `${kind} token submitted ${when(q.submitted_at)} — awaiting review`;
      return { text };
    };

    const showTokenBtn = (a) => !cutoff && tok.avail > 0 && !myChecks[a.id] && relAssignments.includes(a.id) && !(a.tokenGroup && hasGroupToken(a.tokenGroup));

    return (
      <div style={{ overflowX: "hidden" }}>
        <a href="#main-content" className="skip-link">Skip to main content</a>
        <header style={{ borderBottom: "1px solid #E8E6E1", background: "#fff", position: "sticky", top: 0, zIndex: 10 }}>
          <div style={{ maxWidth: 780, margin: "0 auto", padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button onClick={() => setCk(null)} aria-label="Back to course list" style={{ background: "none", border: "none", cursor: "pointer", fontFamily: F.b, fontSize: 12, color: "#6B6B6B" }}>← Back</button>
              <div style={{ width: 1, height: 14, background: "#E0DDD8" }} aria-hidden="true" />
              <span style={{ fontFamily: F.d, fontSize: 14, fontWeight: 600 }}>{c.short}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <a href={CAL_LINK} target="_blank" rel="noopener noreferrer" aria-label="Schedule a meeting with Dr. Beggs" style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 12px", background: "#FFF5F5", border: "1px solid #FCDEDE", borderRadius: 7, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#CF202E", textDecoration: "none" }}>📅 Meet with Dr. Beggs</a>
              <a href="mailto:mbeggs@ucmo.edu" aria-label="Email Dr. Beggs" style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 12px", background: "#F5F5F5", border: "1px solid #E8E6E1", borderRadius: 7, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", textDecoration: "none" }}>✉ Email Dr. Beggs</a>
              <button onClick={handleLogout} aria-label="Sign out" style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", background: "none", border: "1px solid #E0DDD8", borderRadius: 4, padding: "3px 8px", cursor: "pointer" }}>Sign out</button>
            </div>
          </div>
        </header>

        <main id="main-content" style={{ maxWidth: 780, margin: "0 auto", padding: "22px 20px" }}>
          {/* Dashboard */}
          <div style={{ background: "#fff", border: `2px solid ${(TM[grade] || TM.F).c}`, borderRadius: 14, padding: "22px", marginBottom: 18 }}>
            <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
              <GradeRing grade={grade} size={54} />
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em", color: "#6B6B6B", marginBottom: 2 }}>
                  {grade === "early" ? "Status" : "Based on what's been assigned so far"}
                </div>
                <div style={{ fontFamily: F.d, fontSize: 22, fontWeight: 700, color: (TM[grade] || TM.F).c }}>
                  {grade === "early" ? "Getting Started" : grade === "F" ? "You're on F track" : `You're on ${grade} track`}
                </div>
                <div style={{ fontFamily: F.b, fontSize: 11, color: "#767676", marginTop: 1 }}>{relAssignments.filter(id => myChecks[id]).length} of {relAssignments.length} checked off</div>
              </div>
              <div style={{ textAlign: "center", padding: "6px 14px", background: "#F9F8F5", borderRadius: 8 }}>
                <div style={{ display: "flex", gap: 3, justifyContent: "center", marginBottom: 3 }} aria-hidden="true">
                  {Array.from({ length: tok.total }).map((_, i) => <div key={i} style={{ width: 14, height: 14, borderRadius: "50%", background: i < tok.avail ? "#CF202E" : "#E0DDD8", fontSize: 9, color: i < tok.avail ? "#fff" : "#767676", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>✦</div>)}
                </div>
                <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }} aria-label={`${tok.avail} tokens available, ${tok.used} used`}>{tok.avail} token{tok.avail !== 1 ? "s" : ""}</div>
              </div>
            </div>
            {target && blockers.length > 0 && <div style={{ marginTop: 14, padding: "10px 14px", background: "#FFFCF5", borderRadius: 8, borderLeft: `3px solid ${(TM[target] || TM.F).c}` }}>
              <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: (TM[target] || TM.F).c, marginBottom: 3 }}>To reach {target} track:</div>
              <div style={{ fontFamily: F.b, fontSize: 12, color: "#666", lineHeight: 1.6 }}>
                {blockers.map((id, i) => {
                  const a = c.assignments.find(x => x.id === id);
                  const isMastery = a?.eval === "mastery";
                  const st = myInstrStatuses[id];
                  const verb = !isMastery ? "Submit late"
                    : st === "revision" ? "Revise"
                    : st === "not_submitted" ? "Submit late"
                    : "Complete";
                  return <span key={id}>{i > 0 ? " · " : ""}<span style={{ color: "#555", fontWeight: 600 }}>{verb}</span> <strong>{a?.name || id}</strong></span>;
                })}
              </div>
            </div>}
            {grade === "early" && <div style={{ marginTop: 12, padding: "10px 14px", background: "#F3F4F6", borderRadius: 8, fontFamily: F.b, fontSize: 12, color: "#6B7280" }}>Check off your first assignment to see your grade track!</div>}
            {grade === "A" && <div style={{ marginTop: 12, padding: "10px 14px", background: "#D4EDDA", borderRadius: 8, fontFamily: F.b, fontSize: 12, color: "#2D6A4F" }}>You're on the highest track — keep it up!</div>}
          </div>

          {/* Upcoming Due Dates Feed — Student */}
          {(() => {
            const today = new Date(); today.setHours(0,0,0,0);
            const sevenOut = new Date(today); sevenOut.setDate(sevenOut.getDate() + 7);
            const formatFeedDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            const feedItems = [];
            // Assignment due dates — only incomplete items
            relAssignments.forEach(id => {
              if (myChecks[id]) return; // skip completed
              const dd = dueDates[id];
              if (dd?.date) {
                const dDate = new Date(dd.date + 'T00:00:00');
                if (dDate >= today && dDate <= sevenOut) {
                  const a = c.assignments.find(x => x.id === id);
                  feedItems.push({ date: dd.date, name: a?.name || id, label: dd.label, type: a?.eval === 'mastery' ? 'mastery' : 'completion' });
                }
              }
            });
            // Class prep due dates — only incomplete
            (c.classPrep || []).forEach(cp => {
              if (myPrep[cp.id]) return;
              const dd = dueDates[cp.id];
              if (dd?.date) {
                const dDate = new Date(dd.date + 'T00:00:00');
                if (dDate >= today && dDate <= sevenOut) {
                  feedItems.push({ date: dd.date, name: cp.name, label: dd.label, type: 'prep' });
                }
              }
            });
            // Teaching plan due dates
            teachSel.forEach(ts => {
              if (ts.plan_due_date) {
                const pDate = new Date(ts.plan_due_date + 'T00:00:00');
                if (pDate >= today && pDate <= sevenOut) {
                  const a = c.assignments.find(x => x.id === ts.assignment_id);
                  feedItems.push({ date: ts.plan_due_date, name: `${a?.name || ts.assignment_id} — plan due`, type: 'teaching' });
                }
              }
            });
            feedItems.sort((a, b) => a.date.localeCompare(b.date));
            if (feedItems.length === 0) return null;
            return <div role="region" aria-label="Upcoming due dates" style={{ marginBottom: 14, background: "#fff", borderRadius: 10, border: `1px solid ${c.colorLight || '#E8E6E1'}`, overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", background: "#FAFAF7", borderBottom: "1px solid #F0EEEA", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <h2 style={{ fontFamily: F.b, fontSize: 12, fontWeight: 700, color: "#555", margin: 0 }}>📋 Due This Week</h2>
                <span style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>{feedItems.length} item{feedItems.length !== 1 ? 's' : ''}</span>
              </div>
              {feedItems.map((item, ii) => {
                const dDate = new Date(item.date + 'T00:00:00');
                const daysUntil = Math.floor((dDate - today) / (1000 * 60 * 60 * 24));
                const urgLabel = daysUntil <= 0 ? "Today" : daysUntil === 1 ? "Tomorrow" : formatFeedDate(item.date);
                const urgColor = daysUntil <= 0 ? { bg: "#FFF3CD", c: "#856404" } : daysUntil <= 2 ? { bg: "#FAEEDA", c: "#633806" } : { bg: "#F5F4F0", c: "#666" };
                return <div key={ii} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: ii < feedItems.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                  <Pill t={urgLabel} bg={urgColor.bg} c={urgColor.c} />
                  <span style={{ fontFamily: F.b, fontSize: 12, fontWeight: 500, color: "#1A1A1A", flex: 1 }}>{item.name}</span>
                  {item.label && <span style={{ fontFamily: F.b, fontSize: 11, color: "#767676" }}>{item.label}</span>}
                  {item.type === 'teaching' && <Pill t="Plan" bg="#DCEEFB" c="#1565C0" />}
                  {item.type === 'mastery' && <Pill t="Mastery" bg="#FFF0F0" c="#C0392B" />}
                  {item.type === 'completion' && <Pill t="Completion" bg="#F0F8FF" c="#1565C0" />}
                  {item.type === 'prep' && <Pill t="Prep" bg="#F0F8FF" c="#1565C0" />}
                </div>;
              })}
            </div>;
          })()}

          {/* Checklist */}
          <Lbl>My Progress</Lbl>
          <div style={{ fontFamily: F.b, fontSize: 12, color: "#6B6B6B", marginBottom: 14, lineHeight: 1.6, padding: "10px 14px", background: "#F9F8F5", borderRadius: 8 }}>
            <strong style={{ color: "#555" }}>Completion items:</strong> Check off once you've submitted your work.<br />
            <strong style={{ color: "#555" }}>Mastery items:</strong> Unlocked once Dr. Beggs has reviewed your work. Check off when you've met the specs.
          </div>

          {c.groups.map((grp, gi) => {
            const grpA = grp.ids.map(id => c.assignments.find(a => a.id === id)).filter(Boolean);
            return <div key={gi} style={{ marginBottom: 14 }}>
              {grp.name && <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: c.color, marginBottom: 5, padding: "0 4px" }}>{grp.name}{grp.tokenGroup ? <span style={{ fontWeight: 400, color: "#6B6B6B", fontSize: 11, marginLeft: 6 }}>(1 token covers entire project)</span> : ""}</div>}
              <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
                {grpA.map((a, i) => {
                  const isChecked = !!myChecks[a.id];
                  const isMastery = a.eval === "mastery";
                  const instrRec = myInstrSt[a.id]; // { status, updated_at } | undefined
                  const instrStatus = instrRec?.status; // 'mastery' | 'revision' | 'not_submitted' | undefined
                  const instrDate = instrRec?.updated_at ? new Date(instrRec.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
                  const isLocked = isMastery && (!instrStatus || instrStatus === 'not_submitted');
                  const isRevision = instrStatus === 'revision';
                  const isNS = instrStatus === 'not_submitted';

                  // Locked mastery item — not yet evaluated, or marked NS
                  if (isLocked) return <div key={a.id} style={{ borderBottom: i < grpA.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px" }}>
                      <div aria-hidden="true" style={{ width: 22, height: 22, borderRadius: 6, border: "2px solid #E0DDD8", background: "#F5F4F0", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <span style={{ fontSize: 10, color: "#B0ADA8" }}>🔒</span>
                      </div>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontFamily: F.b, fontSize: 13, color: "#555" }}>{a.name}</span>
                        {(dueDates[a.id]?.date || dueDates[a.id]?.label) && <div style={{ fontFamily: F.b, fontSize: 11, color: "#767676", marginTop: 1 }}>{dueDates[a.id].date ? new Date(dueDates[a.id].date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : ''}{dueDates[a.id].date && dueDates[a.id].label ? ' · ' : ''}{dueDates[a.id].label || ''}</div>}
                        {isNS
                          ? <div style={{ fontFamily: F.b, fontSize: 11, color: "#C0392B", marginTop: 2, fontStyle: "italic" }}>No submission recorded. If you believe this is an error, contact Dr. Beggs.</div>
                          : <div style={{ fontFamily: F.b, fontSize: 11, color: "#767676", marginTop: 2, fontStyle: "italic" }}>Locked until Dr. Beggs reviews your work</div>
                        }
                      </div>
                      <Pill t="Mastery" bg="#FFF0F0" c="#C0392B" />
                    </div>
                    {(() => { const ts = tokenStatusFor(a); return ts ? <div role="status" style={{ margin: "0 16px 10px 48px", padding: "5px 10px", background: "#F9F8F5", border: "1px solid #E8E6E1", borderRadius: 5, fontFamily: F.b, fontSize: 11, color: "#555" }}>✦ {ts.text}</div> : null; })()}
                    {showTokenBtn(a) && isFirstInGroup(a) && <div style={{ padding: "0 16px 10px 48px" }}>
                      <button onClick={(e) => { e.stopPropagation(); const tt = getTokenTarget(a.id, ck); setModal(tt); setTfType("late"); setTfNote(""); setTfLink(""); setTfExtra(""); }}
                        style={{ padding: "4px 12px", background: "#FFFCF5", border: "1px solid #FFECB5", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#856404", cursor: "pointer" }}>
                        Submit a token{a.tokenGroup ? " (entire project)" : ""}
                      </button>
                    </div>}
                  </div>;

                  // Unlocked item — either completion, or mastery with instructor evaluation
                  return <div key={a.id} style={{ borderBottom: i < grpA.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                    <div role="checkbox" aria-checked={isChecked} aria-label={`${a.name} - ${a.eval}${instrStatus ? (isRevision ? ', needs revision' : ', mastered') : ''}`} tabIndex={0} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", cursor: "pointer" }}
                      onClick={() => handleCheck(a.id)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCheck(a.id); } }}
                      onMouseEnter={e => e.currentTarget.style.background = "#FAFAF7"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <div style={{ width: 22, height: 22, borderRadius: 6, border: isChecked ? "none" : "2px solid #D0CEC9", background: isChecked ? "#CF202E" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .2s", flexShrink: 0 }}>
                        {isChecked && <span style={{ color: "#fff", fontSize: 13, fontWeight: 700 }}>✓</span>}
                      </div>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontFamily: F.b, fontSize: 13, fontWeight: 500, color: isChecked ? "#767676" : "#1A1A1A", textDecoration: isChecked ? "line-through" : "none", textDecorationColor: "#DDD" }}>{a.name}</span>
                        {(dueDates[a.id]?.date || dueDates[a.id]?.label) && <div style={{ fontFamily: F.b, fontSize: 11, color: isChecked ? "#767676" : "#6B6B6B", marginTop: 1 }}>{dueDates[a.id].date ? new Date(dueDates[a.id].date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : ''}{dueDates[a.id].date && dueDates[a.id].label ? ' · ' : ''}{dueDates[a.id].label || ''}</div>}
                        {isMastery && instrStatus && instrStatus !== 'not_submitted' && !isChecked && <div style={{ fontFamily: F.b, fontSize: 11, color: isRevision ? "#856404" : "#2D6A4F", marginTop: 2 }}>{`Dr. Beggs left feedback${instrDate ? ` on ${instrDate}` : ''} — please review it before checking off`}</div>}
                      </div>
                      {isMastery && <Pill t="Mastery" bg="#FFF0F0" c="#C0392B" />}
                      {a.eval === "completion" && <Pill t="Completion" bg="#F0F8FF" c="#1565C0" />}
                    </div>
                    {(() => { const ts = tokenStatusFor(a); return ts ? <div role="status" style={{ margin: "0 16px 10px 48px", padding: "5px 10px", background: "#F9F8F5", border: "1px solid #E8E6E1", borderRadius: 5, fontFamily: F.b, fontSize: 11, color: "#555" }}>✦ {ts.text}</div> : null; })()}
                    {showTokenBtn(a) && isFirstInGroup(a) && <div style={{ padding: "0 16px 10px 48px" }}>
                      <button onClick={(e) => { e.stopPropagation(); const tt = getTokenTarget(a.id, ck); setModal(tt); setTfType("revision"); setTfNote(""); setTfLink(""); setTfExtra(""); }}
                        style={{ padding: "4px 12px", background: "#FFFCF5", border: "1px solid #FFECB5", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#856404", cursor: "pointer" }}>
                        Submit a token{a.tokenGroup ? " (entire project)" : ""}
                      </button>
                    </div>}
                  </div>;
                })}
              </div>
            </div>;
          })}

          {/* Practicum booking form. Every rule shown here is also enforced in
              book_sr1_observation(); this is the friendly version, not the gate. */}
          {sr1BookWindow && (() => {
            const B = sr1BookWindow;
            const w = B.win;
            const set = p => setSr1BookWindow(v => ({ ...v, ...p }));
            const lsISO = centralISO(w.window_date, B.lessonStart);
            const leISO = centralISO(w.window_date, B.lessonEnd);
            const okOrder = lsISO && leISO && new Date(leISO) > new Date(lsISO);
            const mins = okOrder ? Math.round((new Date(leISO) - new Date(lsISO)) / 60000) : 0;
            const reflISO = okOrder ? new Date(new Date(leISO).getTime() + w.reflection_minutes * 60000) : null;
            const winEnd = new Date(centralISO(w.window_date, w.end_time));
            const winStart = new Date(centralISO(w.window_date, w.start_time));

            let problem = '';
            if (B.lessonStart && B.lessonEnd) {
              if (!okOrder) problem = 'The end time must be after the start time.';
              else if (mins < 20) problem = 'A lesson must be at least 20 minutes long.';
              else if (mins > 90) problem = 'A lesson cannot be longer than 90 minutes. Email Dr. Beggs if you need more.';
              else if (new Date(lsISO) < winStart) problem = `This day does not open until ${fmtTime(winStart)}.`;
              else if (reflISO > winEnd) problem = `Your reflection would run to ${fmtTime(reflISO)}, past the ${fmtTime(winEnd)} close. Choose an earlier start.`;
              else if (sr1TooSoon(lsISO)) problem = 'That time is less than 48 hours away and can no longer be booked online. Email Dr. Beggs at mbeggs@ucmo.edu.';
            }
            const ready = okOrder && !problem && B.topic.trim().length > 0;

            return <div role="dialog" aria-modal="true" aria-labelledby="sr1-book-title"
              onClick={e => { if (e.target === e.currentTarget) setSr1BookWindow(null); }}
              style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}>
              <div style={{ background: "#fff", borderRadius: 14, padding: "22px", maxWidth: 440, width: "100%", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 12px 40px rgba(0,0,0,.15)" }}>
                <h2 id="sr1-book-title" style={{ fontFamily: F.d, fontSize: 18, fontWeight: 600, marginBottom: 3 }}>Book an observation</h2>
                <div style={{ fontFamily: F.b, fontSize: 12, color: "#555", marginBottom: 4 }}>{fmtDateOnly(w.window_date)}</div>
                <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 14 }}>
                  Dr. Beggs is available {fmtTime(winStart)} – {fmtTime(winEnd)}{w.note ? ` · ${w.note}` : ''}
                </div>

                {(() => {
                  const gaps = sr1OpenGaps(w, sr1.taken).filter(g => !sr1TooSoon(g.start.toISOString()));
                  if (gaps.length === 0) return null;
                  return <div style={{ marginBottom: 14, padding: "8px 10px", background: "#F9F8F5", borderRadius: 6 }}>
                    <div style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>Times still open</div>
                    <ul style={{ margin: 0, paddingLeft: 16 }}>
                      {gaps.map((g, i) => <li key={i} style={{ fontFamily: F.b, fontSize: 11, color: "#2D6A4F" }}>{fmtTime(g.start)} – {fmtTime(g.end)}</li>)}
                    </ul>
                  </div>;
                })()}

                <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
                  <div>
                    <label htmlFor="sr1-b-start" style={{ display: "block", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>Lesson starts</label>
                    <input id="sr1-b-start" type="time" value={B.lessonStart} onChange={e => set({ lessonStart: e.target.value })}
                      style={{ padding: "7px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13 }} />
                  </div>
                  <div>
                    <label htmlFor="sr1-b-end" style={{ display: "block", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>Lesson ends</label>
                    <input id="sr1-b-end" type="time" value={B.lessonEnd} onChange={e => set({ lessonEnd: e.target.value })}
                      style={{ padding: "7px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13 }} />
                  </div>
                </div>

                {/* The reflection window is the part her CT needs to hear about,
                    so it is announced rather than only displayed. */}
                {okOrder && !problem && <div role="status" aria-live="polite" style={{ fontFamily: F.b, fontSize: 12, color: "#1A1A1A", background: "#F0F8FF", border: "1px solid #DCEEFB", borderRadius: 6, padding: "9px 11px", marginBottom: 12, lineHeight: 1.5 }}>
                  Lesson {fmtTimeRange(lsISO, leISO)} · Reflection {fmtTimeRange(leISO, reflISO)}
                  <div style={{ color: "#555", marginTop: 3 }}>Make sure your cooperating teacher can release you until {fmtTime(reflISO)}.</div>
                </div>}

                {problem && <div role="alert" style={{ fontFamily: F.b, fontSize: 12, color: "#C0392B", background: "#FDF2F2", border: "1px solid #F5C6CB", borderRadius: 6, padding: "9px 11px", marginBottom: 12, lineHeight: 1.5 }}>{problem}</div>}

                <div style={{ marginBottom: 6 }}>
                  <label htmlFor="sr1-b-topic" style={{ display: "block", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>What are you teaching?</label>
                  <input id="sr1-b-topic" type="text" value={B.topic} onChange={e => set({ topic: e.target.value })}
                    placeholder="e.g. Fractions — comparing unlike denominators"
                    style={{ width: "100%", padding: "8px 11px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12, boxSizing: "border-box" }} />
                </div>

                {B.err && <div role="alert" style={{ fontFamily: F.b, fontSize: 12, color: "#C0392B", background: "#FDF2F2", border: "1px solid #F5C6CB", borderRadius: 6, padding: "9px 11px", margin: "10px 0", lineHeight: 1.5 }}>{B.err}</div>}

                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <button disabled={!ready || sr1Busy}
                    onClick={async () => {
                      setSr1Busy(true); set({ err: '' });
                      const { error } = await bookSr1Observation(w.id, lsISO, leISO, B.topic.trim());
                      setSr1Busy(false);
                      if (error) {
                        // The database messages are written to be read by students.
                        set({ err: error.message || 'Could not book that time. Please try another.' });
                        refreshSr1();
                        return;
                      }
                      setSr1BookWindow(null);
                      showToast('Observation booked ✓', 'success');
                      refreshSr1();
                    }}
                    style={{ padding: "9px 18px", background: (!ready || sr1Busy) ? "#E0DDD8" : c.color, color: "#fff", border: "none", borderRadius: 6, fontFamily: F.b, fontSize: 13, fontWeight: 600, cursor: (!ready || sr1Busy) ? "not-allowed" : "pointer" }}>
                    {sr1Busy ? "Booking…" : "Book this time"}
                  </button>
                  <button onClick={() => setSr1BookWindow(null)}
                    style={{ padding: "9px 14px", background: "#F0EEEA", color: "#6B6B6B", border: "none", borderRadius: 6, fontFamily: F.b, fontSize: 12, cursor: "pointer" }}>Cancel</button>
                </div>
              </div>
            </div>;
          })()}

          {/* Token Modal */}
          {modal && <div role="dialog" aria-modal="true" aria-label="Submit a token" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={() => setModal(null)}>
            <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 14, padding: "24px", maxWidth: 420, width: "90%", boxShadow: "0 12px 40px rgba(0,0,0,.15)" }}>
              <h2 style={{ fontFamily: F.d, fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Submit a Token</h2>
              <div style={{ fontFamily: F.b, fontSize: 13, color: "#555", marginBottom: 14 }}>{modal.name}</div>
              <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#555", marginBottom: 6 }}>What is this token for?</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
                {[{ v: "revision", l: "I revised this" }, { v: "late", l: "I'm submitting late" }, { v: "extra", l: "Using an extra token" }].map(o => <button key={o.v} onClick={() => setTfType(o.v)} style={{ padding: "7px 14px", borderRadius: 6, fontFamily: F.b, fontSize: 11, cursor: "pointer", background: tfType === o.v ? c.color : "#fff", color: tfType === o.v ? "#fff" : "#555", border: tfType === o.v ? `1px solid ${c.color}` : "1px solid #E0DDD8", flex: 1, textAlign: "center", minWidth: o.v === "extra" ? "100%" : "auto" }}>{o.l}</button>)}
              </div>
              {tfType === "extra" && <input value={tfExtra} onChange={e => setTfExtra(e.target.value)} placeholder="List the extra token assignment you completed" aria-label="Extra token activity" style={{ width: "100%", padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12, marginBottom: 8, boxSizing: "border-box" }} />}
              <input value={tfLink} onChange={e => setTfLink(e.target.value)} placeholder="Paste a link to your work (Google Doc, Slides, Canva, etc.)" aria-label="Link to your work" style={{ width: "100%", padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12, marginBottom: 8, boxSizing: "border-box" }} />
              <input value={tfNote} onChange={e => setTfNote(e.target.value)} placeholder="Note for Dr. Beggs (optional)" aria-label="Note for Dr. Beggs" style={{ width: "100%", padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12, marginBottom: 14, boxSizing: "border-box" }} />
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={handleToken} disabled={tfSubmitting} style={{ padding: "8px 18px", background: tfSubmitting ? "#E0DDD8" : c.color, color: "#fff", border: "none", borderRadius: 6, cursor: tfSubmitting ? "not-allowed" : "pointer", fontFamily: F.b, fontSize: 13, fontWeight: 600 }}>{tfSubmitting ? "Submitting..." : "Submit Token"}</button>
                <button onClick={() => setModal(null)} style={{ padding: "8px 14px", background: "#F0EEEA", color: "#6B6B6B", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: F.b, fontSize: 12 }}>Cancel</button>
              </div>
              <div style={{ fontFamily: F.b, fontSize: 11, color: "#767676", marginTop: 8 }}>{tfType === "extra" ? "Uses 1 extra token. Requires prior approval from Dr. Beggs." : `Uses 1 of your ${tok.avail} token${tok.avail !== 1 ? "s" : ""}.`}</div>
            </div>
          </div>}

          {/* Teaching Schedule */}
          {teachDates.length > 0 && <>
          <button aria-expanded={expTeach} onClick={() => setExpTeach(!expTeach)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "12px 16px", background: "#fff", border: "1px solid #E8E6E1", borderRadius: expTeach ? "10px 10px 0 0" : 10, cursor: "pointer", marginBottom: expTeach ? 0 : 12 }}>
            <span style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#555" }}>Teaching Schedule</span>
            <span style={{ fontSize: 11, color: "#767676", transform: expTeach ? "rotate(180deg)" : "", transition: "transform .2s" }}>▾</span>
          </button>
          {expTeach && <div style={{ background: "#fff", border: "1px solid #E8E6E1", borderTop: "none", borderRadius: "0 0 10px 10px", padding: "14px 16px", marginBottom: 12 }}>
            <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 12, lineHeight: 1.5 }}>Select your teaching dates below. Your planning document is due 3 days before your teaching day.</div>
            {(() => {
              const assignmentIds = [...new Set(teachDates.map(td => td.assignment_id))];
              const mySection = myEnrollment?.section || null;
              // A student sees dates offered to both sections (section null) plus any
              // dates specific to their own section. Section-specific dates for the OTHER
              // section are hidden. (If the student has no section — e.g. legacy single-
              // section enrollment — they see every date, preserving old behavior.)
              const visibleForMe = (td) => !td.section || !mySection || td.section === mySection;
              return assignmentIds.map(aid => {
                const a = c.assignments.find(x => x.id === aid);
                const dates = teachDates.filter(td => td.assignment_id === aid && visibleForMe(td));
                if (dates.length === 0) return null;
                const allClosed = dates.every(d => d.closed);
                const mySel = teachSel.find(ts => ts.assignment_id === aid);
                const formatDate = (d) => { const dt = new Date(d + 'T12:00:00'); return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); };
                return <div key={aid} style={{ marginBottom: 12, padding: "12px", background: allClosed ? "#F9F8F5" : "#F0F8FF", borderRadius: 8, border: allClosed ? "1px solid #E8E6E1" : "1px solid #DCEEFB" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ fontFamily: F.b, fontSize: 13, fontWeight: 600, color: allClosed ? "#767676" : "#1A1A1A" }}>{a?.name || aid}</div>
                    {allClosed && <Pill t="Closed" bg="#F5F4F0" c="#767676" />}
                    {mySel && !allClosed && <Pill t="Scheduled" bg="#D4EDDA" c="#2D6A4F" />}
                  </div>
                  {mySel ? <div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0" }}>
                      <div>
                        <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>Teaching</div>
                        <div style={{ fontFamily: F.b, fontSize: 14, fontWeight: 500 }}>{formatDate(mySel.teach_date)}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>Plan due</div>
                        <div style={{ fontFamily: F.b, fontSize: 14, fontWeight: 500 }}>{formatDate(mySel.plan_due_date)}</div>
                      </div>
                      {!allClosed && <button aria-label="Change teaching date" onClick={async () => { await removeTeachingSelection(myId, ck, aid); refresh(); }} style={{ padding: "4px 10px", background: "#fff", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, color: "#6B6B6B", cursor: "pointer" }}>Change</button>}
                    </div>
                  </div> : !allClosed ? <div>
                    <div style={{ fontFamily: F.b, fontSize: 11, color: "#555", marginBottom: 6 }}>Pick your teaching date:</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {dates.filter(d => !d.closed).map(d => <button key={d.id || d.teach_date} aria-label={`Pick teaching date: ${formatDate(d.teach_date)}`} onClick={async () => { await pickTeachingDate(myId, ck, aid, d.teach_date); refresh(); }}
                        style={{ padding: "5px 10px", background: "#fff", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, cursor: "pointer", position: "relative" }}
                        onMouseEnter={e => { e.currentTarget.style.background = "#DCEEFB"; e.currentTarget.style.borderColor = "#1565C0"; }}
                        onMouseLeave={e => { e.currentTarget.style.background = "#fff"; e.currentTarget.style.borderColor = "#E0DDD8"; }}>
                        {formatDate(d.teach_date)}
                        {d.note && <div style={{ fontSize: 11, color: "#C0392B", marginTop: 1 }}>⚠ {d.note}</div>}
                      </button>)}
                    </div>
                  </div> : <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>Teaching window has closed.</div>}
                </div>;
              });
            })()}
          </div>}
          </>}

          {/* Practicum Observations — renders only for the candidates Dr. Beggs
              supervises in the field. Everyone else never sees it exist. */}
          {sr1.mySup && <>
          {sr1.myNotifs.length > 0 && <div style={{ marginBottom: 12 }}>
            {sr1.myNotifs.map(n => (
              <div key={n.id} role="status" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, padding: "10px 14px", marginBottom: 6, background: "#FFF3CD", border: "1px solid #FFECB5", borderRadius: 8 }}>
                <span style={{ fontFamily: F.b, fontSize: 12, color: "#856404", lineHeight: 1.5 }}>{n.message}</span>
                <button onClick={async () => { await dismissSr1Notification(n.id); refreshSr1(); }}
                  aria-label="Dismiss this notice"
                  style={{ flexShrink: 0, padding: "2px 9px", background: "#fff", border: "1px solid #E8D9A8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: "#856404", cursor: "pointer" }}>Dismiss</button>
              </div>
            ))}
          </div>}

          <button aria-expanded={expSr1Student} onClick={() => setExpSr1Student(!expSr1Student)}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "12px 16px", background: "#fff", border: "1px solid #E8E6E1", borderRadius: expSr1Student ? "10px 10px 0 0" : 10, cursor: "pointer", marginBottom: expSr1Student ? 0 : 12 }}>
            <span style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#555" }}>Practicum Observations</span>
            <span aria-hidden="true" style={{ fontSize: 11, color: "#767676", transform: expSr1Student ? "rotate(180deg)" : "", transition: "transform .2s" }}>▾</span>
          </button>
          {expSr1Student && <div style={{ background: "#fff", border: "1px solid #E8E6E1", borderTop: "none", borderRadius: "0 0 10px 10px", padding: "14px 16px", marginBottom: 12 }}>
            <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 12, lineHeight: 1.5 }}>
              Check with your cooperating teacher before booking. Your reflection happens right after the lesson, so you will need to be free until the reflection ends — not just until the lesson does.
            </div>

            {/* My bookings */}
            {(() => {
              const now = Date.now();
              const active = sr1.myBookings.filter(b => b.status === 'booked');
              const upcoming = active.filter(b => new Date(b.lesson_start).getTime() >= now)
                .sort((a, b) => new Date(a.lesson_start) - new Date(b.lesson_start));
              const past = active.filter(b => new Date(b.lesson_start).getTime() < now)
                .sort((a, b) => new Date(b.lesson_start) - new Date(a.lesson_start));
              return <>
                {upcoming.length > 0 && <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 6 }}>Your scheduled observations</div>
                  {upcoming.map(b => {
                    const locked = sr1CancelLocked(b.lesson_start);
                    return <div key={b.id} style={{ padding: "10px 12px", marginBottom: 6, background: "#F0F8FF", border: "1px solid #DCEEFB", borderRadius: 8 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                        <div>
                          <div style={{ fontFamily: F.b, fontSize: 13, fontWeight: 600 }}>{fmtDay(b.lesson_start)}</div>
                          <div style={{ fontFamily: F.b, fontSize: 12, color: "#555", marginTop: 2 }}>Lesson {fmtTimeRange(b.lesson_start, b.lesson_end)}</div>
                          <div style={{ fontFamily: F.b, fontSize: 12, color: "#555" }}>Reflection {fmtTimeRange(b.reflection_start, b.reflection_end)}</div>
                          <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginTop: 3 }}>{b.topic}</div>
                        </div>
                        {locked
                          ? <span style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", maxWidth: 200, textAlign: "right", lineHeight: 1.4 }}>
                              Within 24 hours — email Dr. Beggs at mbeggs@ucmo.edu to change this.
                            </span>
                          : <button onClick={() => handleStudentCancelSr1(b)}
                              aria-label={`Cancel your observation on ${fmtDay(b.lesson_start)}`}
                              style={{ flexShrink: 0, padding: "4px 10px", background: "#fff", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, color: "#C0392B", cursor: "pointer" }}>Cancel</button>}
                      </div>
                    </div>;
                  })}
                </div>}

                {past.length > 0 && <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#767676", marginBottom: 6 }}>Completed</div>
                  {past.map(b => <div key={b.id} style={{ padding: "6px 2px" }}>
                    <span style={{ fontFamily: F.b, fontSize: 12, color: "#767676" }}>{fmtDay(b.lesson_start)} · {fmtTimeRange(b.lesson_start, b.lesson_end)}</span>
                    <span style={{ fontFamily: F.b, fontSize: 11, color: "#909090" }}> — {b.topic}</span>
                  </div>)}
                </div>}
              </>;
            })()}

            {/* Bookable windows — already filtered to her building by RLS. */}
            {(() => {
              const todayStr = new Date().toISOString().slice(0, 10);
              const open = sr1.windows
                .filter(w => w.published && w.window_date >= todayStr)
                .filter(w => !sr1TooSoon(centralISO(w.window_date, w.end_time)))
                .sort((a, b) => a.window_date.localeCompare(b.window_date));
              if (open.length === 0) return <div style={{ fontFamily: F.b, fontSize: 12, color: "#6B6B6B" }}>
                No observation times are open right now. Dr. Beggs will post more.
              </div>;
              return <div>
                <div style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 6 }}>Available days</div>
                {open.map(w => {
                  const gaps = sr1OpenGaps(w, sr1.taken).filter(g => !sr1TooSoon(g.start.toISOString()));
                  const full = gaps.length === 0;
                  return <div key={w.id} style={{ padding: "10px 12px", marginBottom: 6, background: full ? "#F9F8F5" : "#fff", border: "1px solid #E8E6E1", borderRadius: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontFamily: F.b, fontSize: 13, fontWeight: 600 }}>{fmtDateOnly(w.window_date)}</div>
                        <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>
                          {fmtTime(centralISO(w.window_date, w.start_time))} – {fmtTime(centralISO(w.window_date, w.end_time))}
                          {w.note ? ` · ${w.note}` : ''}
                        </div>
                      </div>
                      {!full && <button onClick={() => openSr1Book(w)}
                        aria-label={`Book an observation on ${fmtDateOnly(w.window_date)}`}
                        style={{ padding: "5px 12px", background: c.color, color: "#fff", border: "none", borderRadius: 6, fontFamily: F.b, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Book a time</button>}
                    </div>
                    <div style={{ marginTop: 6 }}>
                      {full
                        ? <span style={{ fontFamily: F.b, fontSize: 11, color: "#767676" }}>Fully booked</span>
                        : <ul style={{ margin: 0, paddingLeft: 16, listStyle: "disc" }}>
                            {gaps.map((g, i) => <li key={i} style={{ fontFamily: F.b, fontSize: 11, color: "#2D6A4F" }}>
                              Open: {fmtTime(g.start)} – {fmtTime(g.end)}
                            </li>)}
                          </ul>}
                    </div>
                  </div>;
                })}
              </div>;
            })()}
          </div>}
          </>}

          {/* Class Prep */}
          {(c.classPrep && c.classPrep.length > 0) && <>

          <button aria-expanded={expPrep} onClick={() => setExpPrep(!expPrep)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "12px 16px", background: "#fff", border: "1px solid #E8E6E1", borderRadius: expPrep ? "10px 10px 0 0" : 10, cursor: "pointer", marginBottom: expPrep ? 0 : 12 }}>
            <span style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#555" }}>Class Preparation ({Object.values(myPrep).filter(Boolean).length}/{c.classPrep.length})</span>
            <span style={{ fontSize: 11, color: "#767676", transform: expPrep ? "rotate(180deg)" : "", transition: "transform .2s" }}>▾</span>
          </button>
          {expPrep && <div style={{ background: "#fff", border: "1px solid #E8E6E1", borderTop: "none", borderRadius: "0 0 10px 10px", padding: "14px 16px", marginBottom: 12 }}>
            <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 10, lineHeight: 1.5 }}>These do not affect your letter grade. They contribute to your educator disposition assessment.</div>
            {c.classPrep.map((cp, i) => {
              const done = !!myPrep[cp.id];
              return <div key={cp.id} role="checkbox" aria-checked={done} aria-label={`${cp.name} - Completion`} tabIndex={0} onClick={() => handlePrep(cp.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlePrep(cp.id); } }} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 4px", borderBottom: i < c.classPrep.length - 1 ? "1px solid #F5F3EF" : "none", cursor: "pointer" }}
                onMouseEnter={e => e.currentTarget.style.background = "#FAFAF7"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <div style={{ width: 20, height: 20, borderRadius: 5, border: done ? "none" : "2px solid #D0CEC9", background: done ? c.color : "#fff", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .2s", flexShrink: 0 }}>{done && <span style={{ color: "#fff", fontSize: 11, fontWeight: 700 }}>✓</span>}</div>
                <div style={{ flex: 1 }}>
                  <span style={{ fontFamily: F.b, fontSize: 12, color: done ? "#767676" : "#1A1A1A", textDecoration: done ? "line-through" : "none" }}>{cp.name}</span>
                  {(dueDates[cp.id]?.date || dueDates[cp.id]?.label) && <div style={{ fontFamily: F.b, fontSize: 11, color: done ? "#767676" : "#6B6B6B", marginTop: 1 }}>{dueDates[cp.id].date ? new Date(dueDates[cp.id].date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : ''}{dueDates[cp.id].date && dueDates[cp.id].label ? ' · ' : ''}{dueDates[cp.id].label || ''}</div>}
                </div>
                <Pill t="Completion" bg="#F0F8FF" c="#1565C0" />
              </div>;
            })}
          </div>}
          </>}

          {/* Grade Tracks */}
          <button aria-expanded={expTracks} onClick={() => setExpTracks(!expTracks)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "12px 16px", background: "#fff", border: "1px solid #E8E6E1", borderRadius: expTracks ? "10px 10px 0 0" : 10, cursor: "pointer", marginBottom: expTracks ? 0 : 12 }}>
            <span style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#555" }}>Grade Track Requirements</span>
            <span style={{ fontSize: 11, color: "#767676", transform: expTracks ? "rotate(180deg)" : "", transition: "transform .2s" }}>▾</span>
          </button>
          {expTracks && <div style={{ background: "#fff", border: "1px solid #E8E6E1", borderTop: "none", borderRadius: "0 0 10px 10px", padding: "14px 16px", marginBottom: 12 }}>
            <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 12 }}>Every item in a track must be checked off to earn that grade.</div>
            {["A", "B", "C", "D"].map(g => { const t = c.tracks[g]; const m = TM[g]; const isOn = grade === g;
              return <div key={g} style={{ marginBottom: 8, padding: "8px 12px", borderRadius: 8, border: isOn ? `2px solid ${m.c}` : "1px solid #F0EEEA", position: "relative" }}>
                {isOn && <span style={{ position: "absolute", top: 6, right: 10, fontFamily: F.b, fontSize: 11, fontWeight: 700, color: "#fff", background: m.c, padding: "2px 6px", borderRadius: 6 }}>YOUR TRACK</span>}
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <div style={{ width: 20, height: 20, borderRadius: "50%", background: m.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.d, fontSize: 11, fontWeight: 700, color: m.c }}>{g}</div>
                  <span style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#333" }}>{g} Track</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                  {(t.req || []).map(id => { const a = c.assignments.find(x => x.id === id); const ch = !!myChecks[id];
                    return <span key={id} style={{ padding: "2px 6px", borderRadius: 5, fontFamily: F.b, fontSize: 11, background: ch ? "#D4EDDA" : "#fff", border: `1px solid ${ch ? "#B7DFBF" : "#E8E6E1"}`, color: ch ? "#2D6A4F" : "#555" }}>{ch ? "✓ " : ""}{a?.name || id}</span>;
                  })}
                </div>
                {(t.pick || []).map((p, pi) => {
                  const doneCount = p.from.filter(id => !!myChecks[id]).length;
                  const needN = Math.min(p.need, p.from.length);
                  return <div key={pi} style={{ marginTop: 4 }}>
                    <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 2 }}>Any {needN} of {p.label || "the following"} ({doneCount}/{needN} done):</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                      {p.from.map(id => { const a = c.assignments.find(x => x.id === id); const ch = !!myChecks[id];
                        return <span key={id} style={{ padding: "2px 6px", borderRadius: 5, fontFamily: F.b, fontSize: 11, background: ch ? "#D4EDDA" : "#fff", border: `1px solid ${ch ? "#B7DFBF" : "#E8E6E1"}`, color: ch ? "#2D6A4F" : "#555" }}>{ch ? "✓ " : ""}{a?.name || id}</span>;
                      })}
                    </div>
                  </div>;
                })}
              </div>;
            })}
          </div>}

          {/* Tokens */}
          <button aria-expanded={expTokens} onClick={() => setExpTokens(!expTokens)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "12px 16px", background: "#fff", border: "1px solid #E8E6E1", borderRadius: expTokens ? "10px 10px 0 0" : 10, cursor: "pointer", marginBottom: 12 }}>
            <span style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#555" }}>Tokens ({tok.avail} available)</span>
            <span style={{ fontSize: 11, color: "#767676", transform: expTokens ? "rotate(180deg)" : "", transition: "transform .2s" }}>▾</span>
          </button>
          {expTokens && <div style={{ background: "#fff", border: "1px solid #E8E6E1", borderTop: "none", borderRadius: "0 0 10px 10px", padding: "14px 16px", marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 5, marginBottom: 8 }}>
              {Array.from({ length: tok.total }).map((_, i) => <div key={i} style={{ width: 22, height: 22, borderRadius: "50%", background: i < tok.avail ? "#CF202E" : "#E0DDD8", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: i < tok.avail ? "#fff" : "#767676", fontWeight: 700 }}>{i < tok.avail ? "✦" : "✕"}</div>)}
            </div>
            <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 6 }}>3 per course · {tok.used} used · {tok.avail} available</div>
            <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", lineHeight: 1.5 }}>
              Use tokens to <strong style={{ color: "#555" }}>revise</strong> or <strong style={{ color: "#555" }}>submit late work</strong>.
              {cutoff ? <><br /><strong style={{ color: "#C0392B" }}>Token period has ended ({cutoffLabelFor(ck)}).</strong></> : <><br /><span style={{ color: "#6B6B6B" }}>Cutoff: {cutoffLabelFor(ck)}</span></>}
            </div>
            {myToks.length > 0 && <div style={{ marginTop: 10 }}>
              <div style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em", color: "#767676", marginBottom: 4 }}>History</div>
              {myToks.map((t, i) => { const a = c.assignments.find(x => x.id === t.assignment_id) || (c.tokenGroups || {})[t.assignment_id]; return <div key={t.id} style={{ display: "flex", gap: 6, padding: "4px 0", borderBottom: i < myToks.length - 1 ? "1px solid #F5F3EF" : "none", fontFamily: F.b, fontSize: 11, color: "#777" }}><span style={{ color: "#767676" }}>✦</span>{t.token_type === "revision" ? "Revision" : "Late"}: {a?.name || t.assignment_id}<span style={{ marginLeft: "auto", fontSize: 11, color: "#767676" }}>{new Date(t.submitted_at).toLocaleDateString()}</span></div>; })}
            </div>}
          </div>}
        </main>
      </div>
    );
  }

  // ---- INSTRUCTOR VIEW ----
  const pending = fq.filter(f => !f.resolved);

  const handleInstrUpdate = async (pid, aid, val) => {
    // Capture only this field's prior value, for a surgical rollback.
    const prevVal = (courseData.iS[pid] || {})[aid];
    // Optimistic update — reflect immediately in UI
    setCourseData(prev => {
      const prevStudent = prev.iS[pid] || {};
      const updatedStudent = val === null
        ? Object.fromEntries(Object.entries(prevStudent).filter(([k]) => k !== aid))
        : { ...prevStudent, [aid]: val };
      return { ...prev, iS: { ...prev.iS, [pid]: updatedStudent } };
    });
    // Background DB write — on failure, reverse ONLY this field, functionally,
    // so any other marks made during the in-flight window are preserved.
    const { error } = await upsertInstrStatus(pid, ck, aid, val);
    if (error) {
      setCourseData(prev => {
        const cur = prev.iS[pid] || {};
        const reverted = prevVal === undefined
          ? Object.fromEntries(Object.entries(cur).filter(([k]) => k !== aid))
          : { ...cur, [aid]: prevVal };
        return { ...prev, iS: { ...prev.iS, [pid]: reverted } };
      });
      showToast('Failed to save — please try again.');
    }
  };
  // ---- PRACTICUM (SR1) HANDLERS -----------------------------------------
  // These call refreshSr1() rather than refresh(): practicum data is loaded
  // separately from courseData, so a full course reload would be wasted work.

  const handleAddSr1Building = async () => {
    const el = document.getElementById('sr1-new-building');
    const name = (el?.value || '').trim();
    if (!name) { showToast('Type a building name first.'); return; }
    if (sr1.buildings.some(b => b.name.toLowerCase() === name.toLowerCase())) {
      showToast('That building is already on the list.'); return;
    }
    setSr1Busy(true);
    const { error } = await addSr1Building(name);
    setSr1Busy(false);
    if (error) { showToast('Could not add that building — please try again.'); return; }
    if (el) el.value = '';
    showToast('Building added ✓', 'success');
    refreshSr1();
  };

  const handleDeleteSr1Building = async (b) => {
    if (!confirm(`Remove ${b.name} from this semester's building list?`)) return;
    const { error } = await deleteSr1Building(b.id);
    if (error) { showToast('Could not remove that building.'); return; }
    showToast('Building removed', 'success');
    refreshSr1();
  };

  const handleToggleSr1Supervision = async (student, currentlyOn) => {
    if (currentlyOn) {
      const has = sr1.bookings.some(bk => bk.profile_id === student.id && bk.status === 'booked');
      if (has && !confirm(`${student.first} ${student.last} has scheduled observations. Remove them from supervision anyway? Their bookings will remain but they will lose access to the scheduling page.`)) return;
      const { error } = await removeSr1Supervision(student.id);
      if (error) { showToast('Could not update the roster.'); return; }
    } else {
      const { error } = await upsertSr1Supervision(student.id, null, null);
      if (error) { showToast('Could not update the roster.'); return; }
    }
    refreshSr1();
  };

  // Building and CT name both live on the supervision row, so a change to
  // either is an upsert of the whole row.
  const handleSetSr1Field = async (profileId, field, value) => {
    const cur = sr1.roster.find(r => r.profile_id === profileId);
    if (!cur) return;
    const buildingId = field === 'building_id' ? value : cur.building_id;
    const ctName = field === 'ct_name' ? value : cur.ct_name;
    // Optimistic — the roster list re-renders immediately.
    const prev = sr1.roster;
    setSr1(s => ({ ...s, roster: s.roster.map(r => r.profile_id === profileId ? { ...r, building_id: buildingId, ct_name: ctName } : r) }));
    const { error } = await upsertSr1Supervision(profileId, buildingId, ctName);
    if (error) {
      setSr1(s => ({ ...s, roster: prev }));
      showToast('Could not save that change — please try again.');
      return;
    }
    if (field === 'building_id') {
      const future = sr1.bookings.filter(bk => bk.profile_id === profileId && bk.status === 'booked' && new Date(bk.lesson_start) > new Date());
      if (future.length > 0) {
        showToast(`Building changed. ${future.length} upcoming booking${future.length === 1 ? ' is' : 's are'} still at the old building — review them.`, 'error');
      }
    }
  };

  const handleCreateSr1Window = async (publish) => {
    const g = id => document.getElementById(id)?.value || '';
    const building_id = g('sr1-w-building'), window_date = g('sr1-w-date');
    const start_time = g('sr1-w-start'), end_time = g('sr1-w-end');
    const reflection_minutes = parseInt(g('sr1-w-refl'), 10);
    const buffer_minutes = parseInt(g('sr1-w-buffer'), 10);
    const note = g('sr1-w-note');
    if (!building_id) { showToast('Choose a building.'); return; }
    if (!window_date) { showToast('Choose a date.'); return; }
    if (!start_time || !end_time) { showToast('Set both an opening and closing time.'); return; }
    if (end_time <= start_time) { showToast('The closing time must be after the opening time.'); return; }
    if (!Number.isFinite(reflection_minutes) || reflection_minutes < 0 || reflection_minutes > 120) { showToast('Reflection minutes must be between 0 and 120.'); return; }
    if (!Number.isFinite(buffer_minutes) || buffer_minutes < 0 || buffer_minutes > 120) { showToast('Buffer minutes must be between 0 and 120.'); return; }
    setSr1Busy(true);
    const { error } = await createSr1Window({ building_id, window_date, start_time, end_time, reflection_minutes, buffer_minutes, note, published: publish });
    setSr1Busy(false);
    if (error) { showToast('Could not create that window — please try again.'); return; }
    ['sr1-w-date', 'sr1-w-note'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    showToast(publish ? 'Window published ✓' : 'Window saved (hidden)', 'success');
    refreshSr1();
  };

  const handleToggleSr1Window = async (w) => {
    const prev = sr1.windows;
    setSr1(s => ({ ...s, windows: s.windows.map(x => x.id === w.id ? { ...x, published: !x.published } : x) }));
    const { error } = await setSr1WindowPublished(w.id, !w.published);
    if (error) { setSr1(s => ({ ...s, windows: prev })); showToast('Could not change that window.'); }
  };

  // The FK is ON DELETE RESTRICT, so a window with bookings cannot be deleted
  // out from under a candidate. Cancel the bookings first, deliberately.
  const handleDeleteSr1Window = async (w, bookedCount) => {
    if (bookedCount > 0) {
      showToast(`That window has ${bookedCount} booking${bookedCount === 1 ? '' : 's'}. Cancel them first, then delete it.`);
      return;
    }
    if (!confirm(`Delete the ${fmtDateOnly(w.window_date)} window?`)) return;
    const { error } = await deleteSr1Window(w.id);
    if (error) { showToast('Could not delete that window.'); return; }
    showToast('Window deleted', 'success');
    refreshSr1();
  };

  // Opens the edit modal with the booking's current values, pre-split into the
  // date/time pieces the form needs.
  const openSr1Edit = (bk) => {
    const dateOf = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: SR1_TZ }); // yyyy-mm-dd
    const timeOf = ts => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: SR1_TZ });
    setSr1EditBooking({
      booking: bk,
      date: dateOf(bk.lesson_start),
      lessonStart: timeOf(bk.lesson_start),
      lessonEnd: timeOf(bk.lesson_end),
      reflStart: timeOf(bk.reflection_start),
      reflEnd: timeOf(bk.reflection_end),
      topic: bk.topic || '',
      overrideNote: bk.override_note || '',
      acknowledged: false,
      notify: true
    });
  };

  const handleInstrCancelSr1 = async (bk, name) => {
    if (!confirm(`Cancel ${name}'s observation on ${fmtDay(bk.lesson_start)} at ${fmtTime(bk.lesson_start)}?\n\nThey will see a notice the next time they sign in.`)) return;
    const { error } = await instrCancelSr1Booking(bk);
    if (error) { showToast('Could not cancel that observation.'); return; }
    showToast('Observation cancelled — candidate notified', 'success');
    refreshSr1();
  };

  const handleInstrNote = async (pid, aid, note) => {
    await upsertInstrNote(pid, ck, aid, note);
    refresh();
  };
  const handleToggleRel = async (aid) => {
    await toggleReleased(ck, aid);
    refresh();
  };
  const handleResolve = async (qId, pid, aid, res) => {
    await resolveQueueItem(qId, pid, ck, aid, res);
    refresh();
  };
  const handleReturn = async (qId, pid, aid) => {
    if (confirm('Return this token to the student? This will delete the submission.')) {
      await returnToken(qId, pid, ck, aid);
      refresh();
    }
  };
  const markAllInstr = async (aid, val) => {
    // Capture each student's prior value for THIS assignment only.
    const prevVals = {};
    students.forEach(s => { prevVals[s.id] = (courseData.iS[s.id] || {})[aid]; });
    // Optimistic update — apply to all students at once
    setCourseData(prev => {
      const updatedIS = { ...prev.iS };
      students.forEach(s => {
        const prevStudent = updatedIS[s.id] || {};
        updatedIS[s.id] = val === null
          ? Object.fromEntries(Object.entries(prevStudent).filter(([k]) => k !== aid))
          : { ...prevStudent, [aid]: val };
      });
      return { ...prev, iS: updatedIS };
    });
    // Parallel DB writes — on failure, reverse ONLY this assignment column per
    // student, functionally, so marks on other assignments made during the
    // in-flight window are preserved.
    const results = await Promise.all(students.map(s => upsertInstrStatus(s.id, ck, aid, val)));
    const anyError = results.some(r => r?.error);
    if (anyError) {
      setCourseData(prev => {
        const updatedIS = { ...prev.iS };
        students.forEach(s => {
          const cur = updatedIS[s.id] || {};
          const pv = prevVals[s.id];
          updatedIS[s.id] = pv === undefined
            ? Object.fromEntries(Object.entries(cur).filter(([k]) => k !== aid))
            : { ...cur, [aid]: pv };
        });
        return { ...prev, iS: updatedIS };
      });
      showToast('Some saves failed — please try again.');
    }
  };

  // Section filtering — null-safe for Spring 2026 courses
  const courseSections = getCourseSections(ck);
  const hasSections = students.some(s => s.section);
  const sectionKeys = hasSections ? [...new Set(students.map(s => s.section).filter(Boolean))] : [];
  // Test accounts (colleague sign-ins used to check the student view) are excluded
  // from grade distribution, the student grid, counts, Tracks, and CSV export so
  // they never skew what the instructor is looking at. They remain in `students`
  // and are managed from the Settings tab.
  const realStudents = students.filter(s => !s.isTest);
  const testCount = students.length - realStudents.length;
  const filteredStudents = sectionFilter === 'all' ? realStudents : realStudents.filter(s => s.section === sectionFilter);

  // ── Instructor grade helper ──────────────────────────────────────
  // Rules (per assignment, regardless of eval type):
  //   M marked             → done
  //   R marked             → in calc, not done
  //   No mark, due passed  → in calc, not done (missing)
  //   No mark, due not yet → invisible (not in calc)
  const calcInstrGrade = (instrStatuses, relIds) => {
    // INSTRUCTOR VIEW ONLY. The grade reflects exactly what the instructor has
    // evaluated — nothing else. An item the instructor has not marked is invisible
    // to the calc, regardless of whether its due date has passed. This means being
    // behind on grading never produces an F: blank items neither help nor hurt.
    //   M               -> done (helps)
    //   R / NS           -> in calc, not done (hurts)
    //   blank (any date) -> invisible
    // To register a genuine miss on an overdue item, the instructor marks it NS.
    // (This is separate from calcStudentGrade, which is governed by the spec's
    // dual-gate rules and is not affected by this function.)
    const done = new Set();
    const relevant = new Set();
    for (const id of relIds) {
      const st = instrStatuses[id];
      if (st === "mastery") { relevant.add(id); done.add(id); }
      else if (st === "revision" || st === "not_submitted") { relevant.add(id); }
      // blank: not added to relevant — invisible to the instructor calc
    }
    // No items evaluated yet -> ungraded.
    if (relevant.size === 0) return "early";
    if (done.size === 0) return "F";
    const relArr = [...relevant];
    for (const g of ["A", "B", "C", "D"]) {
      const t = c.tracks[g]; if (!t) continue;
      const hasReq = (t.req || []).some(id => relArr.includes(id));
      const hasPick = (t.pick || []).some(p => p.from.some(id => relArr.includes(id)));
      const hasPickGroup = (t.pickGroup || []).some(pg => pg.from.some(gr => gr.some(id => relArr.includes(id))));
      if (!hasReq && !hasPick && !hasPickGroup) continue;
      const reqMet = (t.req || []).filter(id => relArr.includes(id)).every(id => done.has(id));
      const pickMet = (t.pick || []).every(p => {
        const avail = p.from.filter(id => relArr.includes(id));
        if (avail.length === 0) return true;
        return avail.filter(id => done.has(id)).length >= Math.min(p.need, avail.length);
      });
      const pickGroupMet = (t.pickGroup || []).every(pg => {
        const anyAvail = pg.from.some(gr => gr.some(id => relArr.includes(id)));
        if (!anyAvail) return true;
        let completed = 0;
        for (const gr of pg.from) { if (gr.filter(id => relArr.includes(id)).every(id => done.has(id))) completed++; }
        return completed >= pg.need;
      });
      if (g === "D" && t.isOr) {
        const mOk = (t.req || []).filter(id => relArr.includes(id)).every(id => done.has(id));
        const aOk = (t.alt || []).filter(id => relArr.includes(id)).every(id => done.has(id));
        if (((t.req || []).some(id => relArr.includes(id)) && mOk) || (t.alt && t.alt.some(id => relArr.includes(id)) && aOk)) return g;
      } else {
        if (reqMet && pickMet && pickGroupMet) return g;
      }
    }
    return "F";
  };

  // ── Instructor blockers for email ────────────────────────────────
  // Returns what a student still needs to reach a given target track, based
  // ONLY on what the instructor has evaluated — matching calcInstrGrade.
  // An item the instructor has not marked is invisible here (not listed as a
  // blocker), regardless of due date. Only items marked R or NS (evaluated,
  // not done) appear as outstanding. M counts as done. This keeps the email's
  // to-do list consistent with the instructor-side grade.
  const getInstrBlockers = (instrStatuses, relIds, targetGrade) => {
    const t = c.tracks[targetGrade]; if (!t) return [];
    const done = new Set();
    const relevant = new Set();
    for (const id of relIds) {
      const st = instrStatuses[id];
      if (st === "mastery") { relevant.add(id); done.add(id); }
      else if (st === "revision" || st === "not_submitted") { relevant.add(id); }
      // blank: invisible — not a blocker until the instructor evaluates it
    }
    const rel = (id) => relevant.has(id);
    const blockers = [];
    (t.req || []).filter(id => rel(id) && !done.has(id)).forEach(id => blockers.push(id));
    (t.pick || []).forEach(p => {
      const avail = p.from.filter(id => rel(id));
      const need = p.need - avail.filter(id => done.has(id)).length;
      if (need > 0) avail.filter(id => !done.has(id)).slice(0, need).forEach(id => { if (!blockers.includes(id)) blockers.push(id); });
    });
    (t.pickGroup || []).forEach(pg => {
      let completed = 0;
      for (const gr of pg.from) { if (gr.filter(id => rel(id)).length > 0 && gr.filter(id => rel(id)).every(id => done.has(id))) completed++; }
      const need = pg.need - completed;
      if (need > 0) { for (const gr of pg.from) { const grAvail = gr.filter(id => rel(id)); if (grAvail.length > 0 && !grAvail.every(id => done.has(id))) { grAvail.filter(id => !done.has(id)).forEach(id => { if (!blockers.includes(id)) blockers.push(id); }); break; } } }
    });
    return blockers;
  };

  // ── Progress email builder ───────────────────────────────────────
  const copyProgressEmail = (student) => {
    const instrSt = iS[student.id] || {};
    const grade = calcInstrGrade(instrSt, relAssignments);
    const sToks = toks[student.id] || [];
    const tok = tokBal(sToks.length, 0);
    const aName = (id) => c.assignments.find(a => a.id === id)?.name || id;
    const order = ["A", "B", "C", "D", "F"];
    const idx = order.indexOf(grade);

    let body = `Hi ${student.first},\n\nHere's a quick update on your current grade track in ${c.short}.\n\n`;
    body += `📊 Current track (based on my records): ${grade === "early" ? "Not yet established" : grade + " Track"}\n`;

    if (grade === "early") {
      body += `\nI haven't recorded any completed work yet. If you believe this is an error, please reach out.\n`;
    } else if (grade === "A") {
      body += `\nYou're on the A track — great work! Keep it up through the end of the semester.\n`;
    } else {
      const targets = idx > 0 ? [order[idx - 1]] : [];
      if (idx > 1) targets.push(order[idx - 2]);
      targets.forEach(target => {
        const blockers = getInstrBlockers(instrSt, relAssignments, target);
        body += `\n📌 To reach ${target} Track:\n`;
        if (blockers.length === 0) {
          body += `  You may already have what you need — double-check your checkoffs.\n`;
        } else {
          blockers.forEach(id => { body += `  • ${aName(id)}\n`; });
        }
      });
    }

    if (tok.avail > 0) {
      body += `\n🎟 You have ${tok.avail} token${tok.avail !== 1 ? "s" : ""} remaining. These can be used for late submissions or revisions.\n`;
    } else {
      body += `\n🎟 You have no tokens remaining.\n`;
    }

    body += `\nIf you have questions about your grade or need to discuss your work, feel free to reach out or schedule a meeting.\n\nDr. Beggs`;

    navigator.clipboard.writeText(body).then(() => {
      showToast(`Email copied for ${student.first} ${student.last}`, 'success');
    }).catch(() => {
      showToast('Copy failed — try again', 'error');
    });
  };

  const sorted = [...filteredStudents].sort((a, b) => {
    if (sortBy === "first") return (a.first || "").localeCompare(b.first || "");
    if (sortBy === "last") return (a.last || "").localeCompare(b.last || "");
    const o = { A: 0, B: 1, C: 2, D: 3, F: 4, early: 5 };
    return (o[calcInstrGrade(iS[a.id] || {}, relAssignments)] || 5) - (o[calcInstrGrade(iS[b.id] || {}, relAssignments)] || 5);
  });

  const dist = { A: 0, B: 0, C: 0, D: 0, F: 0, early: 0 };
  filteredStudents.forEach(s => { const g = calcInstrGrade(iS[s.id] || {}, relAssignments); dist[g] = (dist[g] || 0) + 1; });

  const insights = relAssignments.map(id => { const a = c.assignments.find(x => x.id === id); const rc = filteredStudents.filter(s => (iS[s.id] || {})[id] === "revision").length; const nsc = filteredStudents.filter(s => (iS[s.id] || {})[id] === "not_submitted").length; const mc = filteredStudents.filter(s => (iS[s.id] || {})[id] === "mastery").length; return { ...a, rc, nsc, mc, ns: filteredStudents.length - rc - nsc - mc }; }).filter(a => a.rc > 0 || a.nsc > 0).sort((a, b) => (b.rc + b.nsc) - (a.rc + a.nsc));
  const cpSum = (c.classPrep || []).map(cp => ({ ...cp, done: filteredStudents.filter(s => (cP[s.id] || {})[cp.id]).length }));

  const exportCSV = () => {
    const exportable = students.filter(s => !s.isTest);
    const filteredStudents = sectionFilter === 'all' ? exportable : exportable.filter(s => s.section === sectionFilter);
    const allA = c.assignments.filter(x => relAssignments.includes(x.id)); const cpI = c.classPrep || [];
    const hasSections = students.some(s => s.section);
    const header = ["Term", "Last", "First", "Email", ...(hasSections ? ["Section"] : []), ...allA.map(x => x.name + " (Instr)"), ...allA.map(x => x.name + " (Student)"), ...cpI.map(x => x.name + " (Prep)"), "Tokens Used", "Tokens Avail", "Instr Track", "Student Track"].join(",");
    const rows = filteredStudents.map(st => {
      const si = iS[st.id] || {}; const sc = sC[st.id] || {}; const cp2 = cP[st.id] || {}; const tk = (toks[st.id] || []).length;
      const ig = calcInstrGrade(si, relAssignments); const sg = calcStudentGrade(sc, si, relAssignments, ck, dueDates); const tok = tokBal(tk, 0);
      return [activeTerm(), st.last, st.first, st.email, ...(hasSections ? [st.section || ''] : []), ...allA.map(x => si[x.id] === "mastery" ? "M" : si[x.id] === "revision" ? "R" : si[x.id] === "not_submitted" ? "NS" : ""), ...allA.map(x => sc[x.id] ? "Y" : ""), ...cpI.map(x => cp2[x.id] ? "Y" : ""), tok.used, tok.avail, ig === "early" ? "" : ig, sg === "early" ? "" : sg].map(v => `"${v}"`).join(",");
    });
    const csvContent = header + "\n" + rows.join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" }); const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `${ck.replace(/\s/g, "_")}_${activeTerm()}_${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
  };

  // Token history — one row per submission. This is the record that exists ONLY
  // in Lumos: Brightspace has submission dates and feedback, but nothing there
  // records that a student spent a token to submit late, or how it was resolved.
  // Kept as a separate file rather than a column, because a student may have
  // several submissions or none, which does not fit the one-row-per-student grid.
  const exportTokensCSV = () => {
    const exportable = students.filter(s => !s.isTest);
    const roster = sectionFilter === 'all' ? exportable : exportable.filter(s => s.section === sectionFilter);
    const byId = {}; roster.forEach(s => { byId[s.id] = s; });
    const nameOf = id => byId[id] ? `${byId[id].last}, ${byId[id].first}` : '';
    const asgName = aid => (c.assignments.find(a => a.id === aid) || {}).name || aid;
    const fmt = d => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';

    const rows = (fq || [])
      .filter(q => byId[q.profile_id])
      .sort((a, b) => new Date(a.submitted_at || 0) - new Date(b.submitted_at || 0))
      .map(q => [
        activeTerm(), nameOf(q.profile_id), byId[q.profile_id]?.email || '',
        asgName(q.assignment_id), q.token_type || '', fmt(q.submitted_at),
        q.resolved ? (q.resolution || '') : 'pending', fmt(q.resolved_at),
        (q.note || '').replace(/"/g, "'"), q.link || ''
      ].map(v => `"${v}"`).join(","));

    if (rows.length === 0) { showToast('No token submissions to export for this course.', 'success'); return; }

    const header = ["Term", "Student", "Email", "Assignment", "Type", "Submitted", "Resolution", "Resolved", "Note", "Link"].join(",");
    const blob = new Blob([header + "\n" + rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `${ck.replace(/\s/g, "_")}_${activeTerm()}_tokens_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click(); URL.revokeObjectURL(url);
  };

  // BATCH GRADING VIEW
  if (batch) {
    const ba = c.assignments.find(x => x.id === batchAsgn);
    const bAll = [...students].sort((a, b) => sortBy === "first" ? (a.first || "").localeCompare(b.first || "") : (a.last || "").localeCompare(b.last || ""));
    const bq = batchSearch.toLowerCase();
    const bSorted = bq ? bAll.filter(s => `${s.first} ${s.last}`.toLowerCase().includes(bq) || `${s.last}, ${s.first}`.toLowerCase().includes(bq)) : bAll;
    return (
      <div>
        <a href="#main-content" className="skip-link">Skip to main content</a>
        <main id="main-content" style={{ maxWidth: 900, margin: "0 auto", padding: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => { setBatch(false); setBatchSearch(''); }} aria-label="Back to overview" style={{ background: "none", border: "none", cursor: "pointer", fontFamily: F.b, fontSize: 12, color: "#6B6B6B" }}>← Overview</button>
            <h1 style={{ fontFamily: F.b, fontSize: 13, fontWeight: 600, color: "#555", margin: 0 }}>Grade by Assignment</h1>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input value={batchSearch} onChange={e => setBatchSearch(e.target.value)} placeholder="Filter..." aria-label="Filter students" style={{ padding: "4px 8px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, background: "#fff", width: 80, outline: "none" }} />
            <select aria-label="Sort order" value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ padding: "4px 8px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, background: "#fff" }}><option value="first">First</option><option value="last">Last</option></select>
          </div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <select aria-label="Select assignment" value={batchAsgn} onChange={e => setBatchAsgn(e.target.value)} style={{ width: "100%", padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13, background: "#fff" }}>
            {relAssignments.map(id => { const x = c.assignments.find(a => a.id === id); return <option key={id} value={id}>{x?.name || id}</option>; })}
          </select>
        </div>
        {ba && <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontFamily: F.d, fontSize: 17, fontWeight: 600 }}>{ba.name}</span>
            {ba.eval === "mastery" ? <Pill t="Mastery" bg="#FFF0F0" c="#C0392B" /> : <Pill t="Completion" bg="#F0F8FF" c="#1565C0" />}
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <button onClick={() => markAllInstr(batchAsgn, "mastery")} style={{ padding: "6px 14px", background: "#D4EDDA", border: "1px solid #B7DFBF", borderRadius: 6, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#2D6A4F", cursor: "pointer" }}>{ba.eval === "completion" ? "Mark All Complete" : "Mark All Mastered"}</button>
            <button onClick={() => markAllInstr(batchAsgn, null)} style={{ padding: "6px 14px", background: "#F5F4F0", border: "1px solid #E8E6E1", borderRadius: 6, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#6B6B6B", cursor: "pointer" }}>Reset All</button>
          </div>
          <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
            {bSorted.map((s, si) => {
              const st = (iS[s.id] || {})[batchAsgn] || ""; const note = (iN[s.id] || {})[batchAsgn]; const isEN = noteFor === s.id;
              const studentChecked = !!(sC[s.id] || {})[batchAsgn];
              const opts = ba.eval === "completion"
                ? [{ v: "mastery", l: "✓ Complete", bg: "#D4EDDA", c: "#2D6A4F" }, { v: "not_submitted", l: "NS", bg: "#FCE8E8", c: "#C0392B" }, { v: "", l: "—", bg: "#F5F4F0", c: "#767676" }]
                : [{ v: "mastery", l: "Mastered", bg: "#D4EDDA", c: "#2D6A4F" }, { v: "revision", l: "Revise", bg: "#FFF3CD", c: "#856404" }, { v: "not_submitted", l: "NS", bg: "#FCE8E8", c: "#C0392B" }, { v: "", l: "—", bg: "#F5F4F0", c: "#767676" }];
              return <div key={s.id} style={{ borderBottom: si < bSorted.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px" }}>
                  <div style={{ fontFamily: F.b, fontSize: 13, fontWeight: 500, width: 120, flexShrink: 0 }}>{sortBy === "last" ? `${s.last}, ${s.first}` : `${s.first} ${s.last}`}</div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {opts.map(o => <button key={o.v} aria-label={`${sortBy === "last" ? s.last + " " + s.first : s.first + " " + s.last}: ${o.l}`} onClick={() => handleInstrUpdate(s.id, batchAsgn, o.v || null)} style={{ padding: "5px 10px", borderRadius: 6, fontFamily: F.b, fontSize: 11, fontWeight: 600, cursor: "pointer", background: st === o.v ? o.bg : "#F8F7F4", color: st === o.v ? o.c : "#767676", border: st === o.v ? `2px solid ${o.c}` : "1px solid #E8E6E1" }}>{o.l}</button>)}
                  </div>
                  <button onClick={() => { setNoteFor(isEN ? null : s.id); setNoteVal(note || ""); }} style={{ padding: "3px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, color: note ? "#856404" : "#767676", cursor: "pointer", background: "#fff", flexShrink: 0 }}>{note ? "✎ Note" : "+ Note"}</button>
                  <div style={{ width: 60, flexShrink: 0, textAlign: "right" }}>
                    {studentChecked && <Pill t="Self ✓" bg="#E8F5E9" c="#2D6A4F" />}
                  </div>
                </div>
                {note && !isEN && <div style={{ padding: "2px 16px 6px 136px", fontFamily: F.b, fontSize: 11, color: "#666", fontStyle: "italic" }}>Note: {note}</div>}
                {isEN && <div style={{ padding: "4px 16px 8px 136px", display: "flex", gap: 6 }}>
                  <input value={noteVal} onChange={e => setNoteVal(e.target.value)} placeholder="Feedback note..." aria-label="Feedback note" autoFocus style={{ flex: 1, padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, outline: "none" }} onKeyDown={e => { if (e.key === "Enter") { handleInstrNote(s.id, batchAsgn, noteVal); setNoteFor(null); } }} />
                  <button onClick={() => { handleInstrNote(s.id, batchAsgn, noteVal); setNoteFor(null); }} style={{ padding: "5px 10px", background: c.color, color: "#fff", border: "none", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Save</button>
                </div>}
              </div>;
            })}
          </div>
        </div>}
      </main>
      </div>
    );
  }

  // TRACK CLASS PREP VIEW
  if (prepView) {
    const cpItems = c.classPrep || [];
    const currentPrep = cpItems.find(x => x.id === prepItem);
    const pSorted = [...students].sort((a, b) => sortBy === "first" ? (a.first || "").localeCompare(b.first || "") : (a.last || "").localeCompare(b.last || ""));
    const markAllPrep = async (checked) => {
      for (const s of pSorted) {
        const done = !!(cP[s.id] || {})[prepItem];
        if (checked && !done) await toggleClassPrep(s.id, ck, prepItem);
        if (!checked && done) await toggleClassPrep(s.id, ck, prepItem);
      }
      refresh();
    };
    const doneCount = students.filter(s => (cP[s.id] || {})[prepItem]).length;
    return (
      <div>
        <a href="#main-content" className="skip-link">Skip to main content</a>
        <main id="main-content" style={{ maxWidth: 900, margin: "0 auto", padding: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => setPrepView(false)} aria-label="Back to overview" style={{ background: "none", border: "none", cursor: "pointer", fontFamily: F.b, fontSize: 12, color: "#6B6B6B" }}>← Overview</button>
            <h1 style={{ fontFamily: F.b, fontSize: 13, fontWeight: 600, color: "#555", margin: 0 }}>Track Class Prep</h1>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <select aria-label="Sort order" value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ padding: "4px 8px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, background: "#fff" }}><option value="first">First</option><option value="last">Last</option></select>
            <select aria-label="Select class prep item" value={prepItem} onChange={e => setPrepItem(e.target.value)} style={{ padding: "5px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12, background: "#fff" }}>
              {cpItems.map(cp => <option key={cp.id} value={cp.id}>{cp.name}</option>)}
            </select>
          </div>
        </div>
        {currentPrep && <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontFamily: F.d, fontSize: 17, fontWeight: 600 }}>{currentPrep.name}</span>
            <Pill t={`${doneCount} of ${students.length}`} bg={doneCount === students.length ? "#D4EDDA" : "#F5F4F0"} c={doneCount === students.length ? "#2D6A4F" : "#767676"} />
            {(dueDates[prepItem]?.date || dueDates[prepItem]?.label) && <span style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>Due: {dueDates[prepItem].date ? new Date(dueDates[prepItem].date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : ''}{dueDates[prepItem].date && dueDates[prepItem].label ? ' · ' : ''}{dueDates[prepItem].label || ''}</span>}
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <button onClick={() => markAllPrep(true)} style={{ padding: "6px 14px", background: "#D4EDDA", border: "1px solid #B7DFBF", borderRadius: 6, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#2D6A4F", cursor: "pointer" }}>Mark All Complete</button>
            <button onClick={() => markAllPrep(false)} style={{ padding: "6px 14px", background: "#F5F4F0", border: "1px solid #E8E6E1", borderRadius: 6, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#6B6B6B", cursor: "pointer" }}>Reset All</button>
          </div>
          <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
            {pSorted.map((s, si) => {
              const done = !!(cP[s.id] || {})[prepItem];
              const sLabel = sortBy === "last" ? `${s.last}, ${s.first}` : `${s.first} ${s.last}`;
              return <div key={s.id} role="checkbox" aria-checked={done} aria-label={`${sLabel}: ${currentPrep?.name || ''}`} tabIndex={0} onClick={async () => { await toggleClassPrep(s.id, ck, prepItem); refresh(); }}
                onKeyDown={async e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); await toggleClassPrep(s.id, ck, prepItem); refresh(); } }}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", borderBottom: si < pSorted.length - 1 ? "1px solid #F5F3EF" : "none", cursor: "pointer" }}
                onMouseEnter={e => e.currentTarget.style.background = "#FAFAF7"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <div style={{ width: 22, height: 22, borderRadius: 6, border: done ? "none" : "2px solid #D0CEC9", background: done ? "#2D6A4F" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {done && <span style={{ color: "#fff", fontSize: 13, fontWeight: 700 }}>✓</span>}
                </div>
                <span style={{ fontFamily: F.b, fontSize: 13, fontWeight: 500, color: done ? "#767676" : "#1A1A1A" }}>{sortBy === "last" ? `${s.last}, ${s.first}` : `${s.first} ${s.last}`}</span>
              </div>;
            })}
          </div>
        </div>}
      </main>
      </div>
    );
  }

  // MAIN INSTRUCTOR VIEW
  return (
    <div style={{ overflowX: "hidden" }}>
      <a href="#main-content" className="skip-link">Skip to main content</a>
      {toast && (
        <div role="alert" aria-live="assertive" style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 1000, background: toast.type === 'success' ? "#2D6A4F" : "#C0392B", color: "#fff", fontFamily: F.b, fontSize: 13, fontWeight: 600, padding: "10px 20px", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,.18)", pointerEvents: "none" }}>
          {toast.msg}
        </div>
      )}
      <header style={{ borderBottom: "1px solid #E8E6E1", background: "#fff", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={handleLogout} aria-label="Sign out" style={{ background: "none", border: "none", cursor: "pointer", fontFamily: F.b, fontSize: 12, color: "#6B6B6B" }}>← Sign out</button>
            <div style={{ width: 1, height: 14, background: "#E0DDD8" }} aria-hidden="true" />
            <select aria-label="Select course" value={ck} onChange={e => { setCk(e.target.value); setSectionFilter('all'); }} style={{ fontFamily: F.d, fontSize: 14, fontWeight: 600, border: "none", background: "none", cursor: "pointer", outline: "none" }}>{user.courses.filter(co => co.active).map(({ key: k }) => <option key={k} value={k}>{COURSES[k]?.short || k}</option>)}</select>
            {hasSections && <select aria-label="Filter by section" value={sectionFilter} onChange={e => setSectionFilter(e.target.value)} style={{ fontFamily: F.b, fontSize: 11, border: "1px solid #E0DDD8", borderRadius: 5, padding: "3px 8px", background: "#fff", cursor: "pointer", color: sectionFilter === 'all' ? "#6B6B6B" : c.color, fontWeight: sectionFilter === 'all' ? 400 : 600 }}>
              <option value="all">All sections</option>
              {sectionKeys.map(s => <option key={s} value={s}>{courseSections?.[s]?.name || s}</option>)}
            </select>}
            <span style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>{filteredStudents.length} student{filteredStudents.length !== 1 ? 's' : ''}{sectionFilter !== 'all' ? ` (${sectionFilter})` : ''}</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {pending.length > 0 && tab !== "queue" && <button onClick={() => setTab("queue")} aria-label={`${pending.length} pending token submissions`} style={{ padding: "3px 10px", background: "#FFF3CD", border: "1px solid #FFECB5", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#856404", cursor: "pointer" }}>{pending.length} token{pending.length !== 1 ? "s" : ""}</button>}
            <button onClick={() => { setBatch(true); setBatchAsgn(relAssignments[0] || ""); }} aria-label="Grade by assignment" style={{ padding: "5px 12px", background: c.color, color: "#fff", border: "none", borderRadius: 6, fontFamily: F.b, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Grade by Assignment</button>
            {(c.classPrep && c.classPrep.length > 0) && <button onClick={() => { setPrepView(true); setPrepItem((c.classPrep || [])[0]?.id || ""); }} aria-label="Track class prep" style={{ padding: "5px 12px", background: "#fff", color: c.color, border: `1px solid ${c.color}`, borderRadius: 6, fontFamily: F.b, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Track Class Prep</button>}
          </div>
        </div>
      </header>

      <main id="main-content" style={{ maxWidth: 1100, margin: "0 auto", padding: "18px 20px" }}>
        <nav role="tablist" aria-label="Dashboard sections" style={{ display: "flex", gap: 0, marginBottom: 18, borderBottom: "2px solid #F0EEEA" }}>
          {[{ k: "overview", l: "Overview" }, { k: "settings", l: "Settings" }, { k: "queue", l: "Tokens" }, { k: "tracks", l: "Tracks" }, { k: "practicum", l: "Practicum" }].map(t => <button role="tab" aria-selected={tab === t.k} key={t.k} onClick={() => setTab(t.k)} style={{ padding: "8px 14px", border: "none", cursor: "pointer", fontFamily: F.b, fontSize: 12, fontWeight: 600, color: tab === t.k ? c.color : "#767676", background: "none", borderBottom: tab === t.k ? `2px solid ${c.color}` : "2px solid transparent", marginBottom: -2, position: "relative" }}>{t.l}{t.k === "queue" && pending.length > 0 && <span aria-label={`${pending.length} pending`} style={{ position: "absolute", top: 4, right: 2, minWidth: 16, height: 16, borderRadius: 8, background: "#CF202E", color: "#fff", fontFamily: F.b, fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px" }}>{pending.length}</span>}</button>)}
        </nav>

        {/* OVERVIEW */}
        {tab === "overview" && <div>
          {/* Upcoming Due Dates Feed — Assignment-level summary */}
          {(() => {
            const today = new Date(); today.setHours(0,0,0,0);
            const sevenOut = new Date(today); sevenOut.setDate(sevenOut.getDate() + 7);
            const formatFeedDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            const feedItems = [];
            // Assignment + class prep due dates (from real date column)
            const allItemIds = [...c.assignments.map(a => a.id), ...(c.classPrep || []).map(cp => cp.id)];
            allItemIds.forEach(id => {
              const dd = dueDates[id];
              if (dd?.date) {
                const dDate = new Date(dd.date + 'T00:00:00');
                if (dDate >= today && dDate <= sevenOut) {
                  const a = c.assignments.find(x => x.id === id);
                  const cp = (c.classPrep || []).find(x => x.id === id);
                  feedItems.push({ date: dd.date, name: a?.name || cp?.name || id, label: dd.label, type: a ? (a.eval === 'mastery' ? 'mastery' : 'completion') : 'prep' });
                }
              }
            });
            // Teaching plan due dates — aggregate by assignment + teach_date
            const teachAgg = {};
            teachSel.forEach(ts => {
              if (ts.plan_due_date) {
                const pDate = new Date(ts.plan_due_date + 'T00:00:00');
                if (pDate >= today && pDate <= sevenOut) {
                  if (sectionFilter === 'all' || filteredStudents.some(s => s.id === ts.profile_id)) {
                    const key = ts.assignment_id + '|' + ts.teach_date;
                    if (!teachAgg[key]) teachAgg[key] = { aid: ts.assignment_id, teachDate: ts.teach_date, planDue: ts.plan_due_date, count: 0 };
                    teachAgg[key].count++;
                  }
                }
              }
            });
            Object.values(teachAgg).forEach(g => {
              const a = c.assignments.find(x => x.id === g.aid);
              feedItems.push({ date: g.planDue, name: a?.name || g.aid, teachDate: g.teachDate, count: g.count, type: 'teaching' });
            });
            feedItems.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
            if (feedItems.length === 0) return null;
            // Group by due date
            const dateGroups = {};
            feedItems.forEach(item => {
              if (!dateGroups[item.date]) dateGroups[item.date] = [];
              dateGroups[item.date].push(item);
            });
            const groupedDates = Object.keys(dateGroups).sort();
            return <div role="region" aria-label="Upcoming due dates" style={{ marginBottom: 18, background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
              <div style={{ padding: "10px 16px", background: "#FAFAF7", borderBottom: "1px solid #F0EEEA", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <h2 style={{ fontFamily: F.b, fontSize: 12, fontWeight: 700, color: "#555", margin: 0 }}>📋 Due This Week</h2>
                <span style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>{feedItems.length} item{feedItems.length !== 1 ? 's' : ''}</span>
              </div>
              {groupedDates.map((dateStr, di) => {
                const items = dateGroups[dateStr];
                const dDate = new Date(dateStr + 'T00:00:00');
                const daysUntil = Math.floor((dDate - today) / (1000 * 60 * 60 * 24));
                const urgency = daysUntil <= 0 ? { bg: "#FFF3CD", c: "#856404", label: "Today" } : daysUntil === 1 ? { bg: "#FAEEDA", c: "#633806", label: "Tomorrow" } : { bg: "#F5F4F0", c: "#666", label: formatFeedDate(dateStr) };
                return <div key={dateStr} style={{ padding: "8px 16px", borderBottom: di < groupedDates.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <Pill t={urgency.label} bg={urgency.bg} c={urgency.c} />
                  </div>
                  {items.map((item, ii) => <div key={ii} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: item.type === 'teaching' ? "#1565C0" : item.type === 'mastery' ? "#C0392B" : "#1565C0", flexShrink: 0 }} aria-hidden="true" />
                    <span style={{ fontFamily: F.b, fontSize: 12, fontWeight: 500, color: "#1A1A1A", flex: 1 }}>{item.name}</span>
                    {item.type === 'teaching' && <span style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>teaching {formatFeedDate(item.teachDate)} · {item.count} student{item.count !== 1 ? 's' : ''}</span>}
                    {item.label && item.type !== 'teaching' && <span style={{ fontFamily: F.b, fontSize: 11, color: "#767676" }}>{item.label}</span>}
                    {item.type === 'teaching' && <Pill t="Plan" bg="#DCEEFB" c="#1565C0" />}
                    {item.type === 'mastery' && <Pill t="Mastery" bg="#FFF0F0" c="#C0392B" />}
                    {item.type === 'completion' && <Pill t="Completion" bg="#F0F8FF" c="#1565C0" />}
                    {item.type === 'prep' && <Pill t="Prep" bg="#F0F8FF" c="#1565C0" />}
                  </div>)}
                </div>;
              })}
            </div>;
          })()}

          {/* Teaching Schedule — right after Due This Week */}
          {teachDates.length > 0 && (() => {
            const formatDate = (d) => { const dt = new Date(d + 'T12:00:00'); return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); };
            const openAids = [...new Set(teachDates.filter(td => !td.closed).map(td => td.assignment_id))];
            const today = new Date(); today.setHours(0,0,0,0);
            const sevenDays = new Date(today); sevenDays.setDate(sevenDays.getDate() + 7);

            // At a glance cards
            const allAids = [...new Set(teachDates.map(td => td.assignment_id))];
            const glance = allAids.map(aid => {
              const a = c.assignments.find(x => x.id === aid);
              const scheduled = teachSel.filter(ts => ts.assignment_id === aid && (sectionFilter === 'all' || filteredStudents.some(s => s.id === ts.profile_id))).length;
              const closed = teachDates.filter(td => td.assignment_id === aid).every(d => d.closed);
              return { aid, name: a?.name || aid, scheduled, closed };
            });

            // All selections (section-filtered)
            const allSel = teachSel.filter(ts => openAids.includes(ts.assignment_id) && (sectionFilter === 'all' || filteredStudents.some(s => s.id === ts.profile_id))).sort((a, b) => new Date(a.teach_date) - new Date(b.teach_date));
            const allTeachDates = [...new Set(allSel.map(ts => ts.teach_date))].sort();

            // Group all selections by teach_date + assignment
            const buildGroups = (sels) => {
              const dateMap = {};
              sels.forEach(ts => {
                const key = ts.teach_date + '|' + ts.assignment_id;
                if (!dateMap[key]) dateMap[key] = { teachDate: ts.teach_date, aid: ts.assignment_id, planDue: ts.plan_due_date, students: [] };
                dateMap[key].students.push(ts);
              });
              return Object.values(dateMap).sort((a, b) => a.teachDate === b.teachDate ? a.aid.localeCompare(b.aid) : a.teachDate.localeCompare(b.teachDate));
            };

            // Determine which selections to show
            const isSearching = teachDateFilter !== 'all' || teachSearch.length > 0;
            let visibleSels = allSel;

            // Apply date filter
            if (teachDateFilter !== 'all') {
              visibleSels = visibleSels.filter(ts => ts.teach_date === teachDateFilter);
            }

            // Apply name search
            if (teachSearch.length > 0) {
              const sq = teachSearch.toLowerCase();
              visibleSels = visibleSels.filter(ts => {
                const nm = `${ts.profiles?.first_name || ''} ${ts.profiles?.last_name || ''}`.toLowerCase();
                return nm.includes(sq) || `${ts.profiles?.last_name || ''}, ${ts.profiles?.first_name || ''}`.toLowerCase().includes(sq);
              });
            }

            // If not searching, show: (a) any past lessons with ungraded students, (b) upcoming lessons in next 7 days
            if (!isSearching) {
              visibleSels = visibleSels.filter(ts => {
                const due = new Date(ts.plan_due_date + 'T00:00:00');
                const isUpcoming = due >= today && due <= sevenDays;
                const isPastUngraded = due < today && (iS[ts.profile_id] || {})[ts.assignment_id] !== 'mastery';
                return isUpcoming || isPastUngraded;
              });
            }

            const groups = buildGroups(visibleSels);

            // For default view: hide groups where ALL students are mastered
            const visibleGroups = isSearching ? groups : groups.filter(grp => grp.students.some(ts => (iS[ts.profile_id] || {})[grp.aid] !== 'mastery'));

            // Not yet scheduled
            const scheduledStudentIds = new Set(teachSel.map(ts => ts.profile_id + '_' + ts.assignment_id));
            const unscheduled = [];
            openAids.forEach(aid => {
              filteredStudents.forEach(s => {
                if (!scheduledStudentIds.has(s.id + '_' + aid)) unscheduled.push({ ...s, aid });
              });
            });

            return <div style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
                <Lbl s={{ marginBottom: 0, flex: 1 }} onClick={() => setExpTeachSched(!expTeachSched)} expanded={expTeachSched}>Teaching Schedule</Lbl>
                {expTeachSched && <div style={{ display: "flex", gap: 4 }}>
                  <input value={teachSearch} onChange={e => setTeachSearch(e.target.value)} placeholder="Search student..." aria-label="Search teaching schedule by student name" style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: "#666", background: "#fff", width: 100, outline: "none" }} />
                  <select aria-label="Filter by teaching date" value={teachDateFilter} onChange={e => setTeachDateFilter(e.target.value)} style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, background: "#fff", cursor: "pointer" }}>
                    <option value="all">Upcoming</option>
                    {allTeachDates.map(d => <option key={d} value={d}>{formatDate(d)}</option>)}
                  </select>
                </div>}
              </div>
              {expTeachSched && <>
                {/* At a glance */}
                <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                  {glance.map(g => <div key={g.aid} style={{ flex: 1, minWidth: 100, background: g.closed ? "#F5F4F0" : "#F0F8FF", padding: "10px 12px", borderRadius: 8, border: `1px solid ${g.closed ? "#E8E6E1" : "#DCEEFB"}` }}>
                    <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 2 }}>{g.name}</div>
                    <div style={{ fontFamily: F.d, fontSize: 18, fontWeight: 600, color: g.closed ? "#767676" : "#1565C0" }}>{g.scheduled}/{filteredStudents.length}</div>
                    <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>{g.closed ? "closed" : "scheduled"}</div>
                  </div>)}
                </div>

                {/* Scheduled Lessons */}
                {visibleGroups.length > 0 && <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 6 }}>{isSearching ? `Results${teachDateFilter !== 'all' ? ' for ' + formatDate(teachDateFilter) : ''}${teachSearch ? ' matching "' + teachSearch + '"' : ''}` : 'Scheduled Lessons'}</div>
                  {visibleGroups.map((grp, gi) => {
                    const a = c.assignments.find(x => x.id === grp.aid);
                    const dueDate = new Date(grp.planDue + 'T00:00:00');
                    const daysUntil = Math.floor((dueDate - today) / (1000 * 60 * 60 * 24));
                    const isPast = daysUntil < 0;
                    const badgeColor = isPast ? { bg: "#F5F4F0", c: "#767676" } : daysUntil <= 0 ? { bg: "#FFF3CD", c: "#856404" } : daysUntil <= 2 ? { bg: "#FAEEDA", c: "#633806" } : { bg: "#F5F4F0", c: "#666" };
                    const dueLabel = isPast ? formatDate(grp.planDue) : daysUntil === 0 ? "Plans due tonight" : daysUntil === 1 ? "Plans due tomorrow" : `Plans due ${formatDate(grp.planDue)}`;
                    return <div key={gi} style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden", marginBottom: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", background: "#FAFAF7", borderBottom: "1px solid #F0EEEA" }}>
                        <div>
                          <span style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600 }}>{a?.name || grp.aid}</span>
                          <span style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginLeft: 8 }}>Teaching {formatDate(grp.teachDate)}</span>
                        </div>
                        <Pill t={dueLabel} bg={badgeColor.bg} c={badgeColor.c} />
                      </div>
                      {grp.students.map((ts, si) => {
                        const sName = `${ts.profiles?.first_name || ''} ${ts.profiles?.last_name || ''}`.trim();
                        const initials = `${(ts.profiles?.first_name || '')[0] || ''}${(ts.profiles?.last_name || '')[0] || ''}`;
                        const st = (iS[ts.profile_id] || {})[ts.assignment_id] || '';
                        const circBg = st === 'mastery' ? '#D4EDDA' : st === 'revision' ? '#FFF3CD' : st === 'not_submitted' ? '#FCE8E8' : '#DCEEFB';
                        const circColor = st === 'mastery' ? '#2D6A4F' : st === 'revision' ? '#856404' : st === 'not_submitted' ? '#C0392B' : '#1565C0';
                        const noteKey = `teach_${ts.profile_id}_${ts.assignment_id}`;
                        const isEditingNote = noteFor === noteKey;
                        const existingNote = (iN[ts.profile_id] || {})[ts.assignment_id];
                        return <div key={ts.id} style={{ borderBottom: si < grp.students.length - 1 ? "1px solid #F5F3EF" : "none", opacity: st === 'mastery' ? 0.5 : 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px" }}>
                            <div style={{ width: 32, height: 32, borderRadius: "50%", background: circBg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: circColor, flexShrink: 0 }}>{st === 'mastery' ? '✓' : st === 'revision' ? 'R' : st === 'not_submitted' ? 'NS' : initials}</div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontFamily: F.b, fontSize: 13, fontWeight: 500, textDecoration: st === 'mastery' ? 'line-through' : 'none', color: st === 'mastery' ? '#767676' : '#1A1A1A' }}>{sName}</div>
                              <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>Teaching {formatDate(ts.teach_date)}{st ? ` · ${st === 'mastery' ? 'Mastered' : st === 'revision' ? 'Needs revision' : 'Not submitted'}` : ''}</div>
                            </div>
                            {!st && <div style={{ display: "flex", gap: 4 }}>
                              <button aria-label={`Mark ${sName} mastered`} onClick={async () => { await upsertInstrStatus(ts.profile_id, ck, ts.assignment_id, 'mastery'); refresh(); }} style={{ padding: "4px 10px", background: "#D4EDDA", border: "1px solid #B7DFBF", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#2D6A4F", cursor: "pointer" }}>M</button>
                              <button aria-label={`Mark ${sName} revision`} onClick={async () => { await upsertInstrStatus(ts.profile_id, ck, ts.assignment_id, 'revision'); refresh(); }} style={{ padding: "4px 10px", background: "#FFF3CD", border: "1px solid #FFECB5", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#856404", cursor: "pointer" }}>R</button>
                              <button aria-label={`Mark ${sName} not submitted`} onClick={async () => { await upsertInstrStatus(ts.profile_id, ck, ts.assignment_id, 'not_submitted'); refresh(); }} style={{ padding: "4px 10px", background: "#FCE8E8", border: "1px solid #F5B7B7", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#C0392B", cursor: "pointer" }}>NS</button>
                              <button aria-label={`Add note for ${sName}`} onClick={() => { setNoteFor(isEditingNote ? null : noteKey); setNoteVal(existingNote || ''); }} style={{ padding: "4px 8px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, color: existingNote ? "#856404" : "#767676", cursor: "pointer", background: "#fff" }}>{existingNote ? "✎" : "+"}</button>
                            </div>}
                            {st === 'revision' && <div style={{ display: "flex", gap: 4 }}>
                              <button aria-label={`Mark ${sName} mastered`} onClick={async () => { await upsertInstrStatus(ts.profile_id, ck, ts.assignment_id, 'mastery'); refresh(); }} style={{ padding: "4px 10px", background: "#D4EDDA", border: "1px solid #B7DFBF", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#2D6A4F", cursor: "pointer" }}>→ M</button>
                              <button aria-label={`Mark ${sName} not submitted`} onClick={async () => { await upsertInstrStatus(ts.profile_id, ck, ts.assignment_id, 'not_submitted'); refresh(); }} style={{ padding: "4px 10px", background: "#FCE8E8", border: "1px solid #F5B7B7", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#C0392B", cursor: "pointer" }}>NS</button>
                              <button aria-label={`Add note for ${sName}`} onClick={() => { setNoteFor(isEditingNote ? null : noteKey); setNoteVal(existingNote || ''); }} style={{ padding: "4px 8px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, color: existingNote ? "#856404" : "#767676", cursor: "pointer", background: "#fff" }}>{existingNote ? "✎" : "+"}</button>
                            </div>}
                            {st === 'not_submitted' && <div style={{ display: "flex", gap: 4 }}>
                              <button aria-label={`Mark ${sName} mastered`} onClick={async () => { await upsertInstrStatus(ts.profile_id, ck, ts.assignment_id, 'mastery'); refresh(); }} style={{ padding: "4px 10px", background: "#D4EDDA", border: "1px solid #B7DFBF", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#2D6A4F", cursor: "pointer" }}>→ M</button>
                              <button aria-label={`Mark ${sName} revision needed`} onClick={async () => { await upsertInstrStatus(ts.profile_id, ck, ts.assignment_id, 'revision'); refresh(); }} style={{ padding: "4px 10px", background: "#FFF3CD", border: "1px solid #FFECB5", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#856404", cursor: "pointer" }}>→ R</button>
                              <button aria-label={`Add note for ${sName}`} onClick={() => { setNoteFor(isEditingNote ? null : noteKey); setNoteVal(existingNote || ''); }} style={{ padding: "4px 8px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, color: existingNote ? "#856404" : "#767676", cursor: "pointer", background: "#fff" }}>{existingNote ? "✎" : "+"}</button>
                            </div>}
                          </div>
                          {existingNote && !isEditingNote && <div style={{ padding: "0 16px 6px 58px", fontFamily: F.b, fontSize: 11, color: "#666", fontStyle: "italic" }}>Note: {existingNote}</div>}
                          {isEditingNote && <div style={{ padding: "0 16px 8px 58px", display: "flex", gap: 6 }}>
                            <input value={noteVal} onChange={e => setNoteVal(e.target.value)} placeholder="Feedback note..." aria-label="Feedback note" autoFocus style={{ flex: 1, padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, outline: "none" }} onKeyDown={async e => { if (e.key === "Enter") { await handleInstrNote(ts.profile_id, ts.assignment_id, noteVal); setNoteFor(null); } }} />
                            <button onClick={async () => { await handleInstrNote(ts.profile_id, ts.assignment_id, noteVal); setNoteFor(null); }} style={{ padding: "4px 10px", background: c.color, color: "#fff", border: "none", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Save</button>
                          </div>}
                        </div>;
                      })}
                    </div>;
                  })}
                </div>}
                {visibleGroups.length === 0 && isSearching && <div style={{ padding: "14px", textAlign: "center", fontFamily: F.b, fontSize: 11, color: "#767676", background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", marginBottom: 14 }}>No results found.</div>}
                {visibleGroups.length === 0 && !isSearching && <div style={{ padding: "14px", textAlign: "center", fontFamily: F.b, fontSize: 12, color: "#2D6A4F", background: "#D4EDDA", borderRadius: 10, marginBottom: 14 }}>✓ All upcoming plans graded!</div>}

                {/* Not yet scheduled */}
                {unscheduled.length > 0 && <div>
                  <div style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 8 }}>Not yet scheduled</div>
                  {openAids.map(aid => {
                    const a = c.assignments.find(x => x.id === aid);
                    const unsched = unscheduled.filter(u => u.aid === aid);
                    if (unsched.length === 0) return null;
                    return <div key={aid} style={{ marginBottom: 10 }}>
                      <div style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#6B6B6B", marginBottom: 4 }}>{a?.name || aid} ({unsched.length})</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {unsched.map((s, i) => <span key={i} style={{ padding: "3px 8px", background: "#FFF3E0", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: "#E65100" }}>{s.last}, {s.first}</span>)}
                      </div>
                    </div>;
                  })}
                </div>}
              </>}
            </div>;
          })()}

          <div style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap" }}>
            {["A", "B", "C", "D", "F"].map(g => <div key={g} style={{ flex: 1, minWidth: 55, background: TM[g].bg, borderRadius: 8, padding: "10px", textAlign: "center" }}>
              <div style={{ fontSize: 20, fontWeight: 700, fontFamily: F.d, color: TM[g].c }}>{dist[g] || 0}</div>
              <div style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, color: TM[g].c, opacity: .7 }}>{g}</div>
            </div>)}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
            <Lbl s={{ marginBottom: 0, flex: 1 }} onClick={() => setExpStudents(!expStudents)} expanded={expStudents}>Students (Your Records)</Lbl>
            {expStudents && <div style={{ display: "flex", gap: 4 }}>
              <input value={gridSearch} onChange={e => setGridSearch(e.target.value)} placeholder="Filter..." aria-label="Filter students" style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: "#666", background: "#fff", width: 80, outline: "none" }} />
              <select aria-label="Sort order" value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ padding: "2px 6px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: "#666", background: "#fff", cursor: "pointer" }}><option value="first">First</option><option value="last">Last</option><option value="grade">Track</option></select>
              <button aria-label="Export grades CSV" onClick={exportCSV} style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: "#666", background: "#fff", cursor: "pointer" }}>📥 CSV</button>
              <button aria-label="Export token history CSV" onClick={exportTokensCSV} style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: "#666", background: "#fff", cursor: "pointer", marginLeft: 6 }}>📥 Tokens</button>
              <button aria-label="Refresh data" onClick={refresh} style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: "#666", background: "#fff", cursor: "pointer" }}>↻ Refresh</button>
            </div>}
          </div>

          {expStudents && <><div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
            <div style={{ minWidth: 400 }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8, padding: "8px 16px 6px", borderBottom: "2px solid #F0EEEA", background: "#FAFAF7" }}>
              <div style={{ width: 22, flexShrink: 0 }} aria-hidden="true" />
              <div style={{ width: 130, flexShrink: 0, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#767676" }}>Student</div>
              <div style={{ width: 22, flexShrink: 0 }} aria-hidden="true" />
              <div style={{ flex: 1, display: "flex", gap: 3 }}>{relAssignments.map(id => { const x = c.assignments.find(a => a.id === id);
                const words = (x?.name || "").split(' ');
                const abbr = words.length >= 3 ? words.filter(w => w.length > 1).map(w => w[0]).join('').substring(0, 5) : (x?.name || "").substring(0, 6);
                return <div key={id} style={{ flex: 1, minWidth: 28, maxWidth: 40, display: "flex", alignItems: "flex-end", justifyContent: "center" }} title={x?.name} aria-label={x?.name}>
                  <div style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", fontFamily: F.b, fontSize: 10, fontWeight: 600, color: "#555", textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", maxHeight: 72, lineHeight: 1.2, paddingBottom: 2 }}>{x?.name || ""}</div>
                </div>; })}</div>
              <div style={{ width: 50, flexShrink: 0, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#767676", textAlign: "right" }}>Self</div>
            </div>
            {(() => { const gq = gridSearch.toLowerCase(); const gridFiltered = gq ? sorted.filter(s => `${s.first} ${s.last}`.toLowerCase().includes(gq) || `${s.last}, ${s.first}`.toLowerCase().includes(gq)) : sorted; return gridFiltered.map((s, si) => {
              const ig = calcInstrGrade(iS[s.id] || {}, relAssignments); const sg = calcStudentGrade(sC[s.id] || {}, iS[s.id] || {}, relAssignments, ck, dueDates);
              const m = TM[ig] || TM.F; const mm = ig !== sg && ig !== "early" && sg !== "early";
              return <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 16px", borderBottom: si < sorted.length - 1 ? "1px solid #F5F3EF" : "none", background: mm ? "#FFF8F0" : "transparent" }}>
                <div style={{ width: 22, height: 22, borderRadius: "50%", background: m.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.d, fontSize: 11, fontWeight: 700, color: m.c, flexShrink: 0 }}>{ig === "early" ? "—" : ig}</div>
                <button onClick={() => setPreviewStudent({ id: s.id, name: s.name })} aria-label={`Preview ${s.name}'s student view`} style={{ width: 130, flexShrink: 0, fontFamily: F.b, fontSize: 12, fontWeight: 500, color: "#1565C0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 2 }}>{sortBy === "last" ? `${s.last}, ${s.first}` : s.name}</button>
                <button onClick={() => copyProgressEmail(s)} aria-label={`Copy progress email for ${s.name}`} title={`Copy progress email for ${s.name}`} style={{ flexShrink: 0, width: 22, height: 22, borderRadius: 4, background: "none", border: "1px solid #E0DDD8", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#767676", padding: 0 }}>✉</button>
                <div style={{ flex: 1, display: "flex", gap: 3 }}>
                  {relAssignments.map(id => { const st = (iS[s.id] || {})[id] || "";
                    const aName = c.assignments.find(a => a.id === id)?.name || id;
                    const isMastery = c.assignments.find(a => a.id === id)?.eval === "mastery";
                    const nextVal = st === "" ? "mastery" : st === "mastery" ? (isMastery ? "revision" : "not_submitted") : st === "revision" ? "not_submitted" : null;
                    const cycleLabel = st === "" ? `Mark ${aName} mastered` : st === "mastery" ? (isMastery ? `Change ${aName} to needs revision` : `Change ${aName} to not submitted`) : st === "revision" ? `Change ${aName} to not submitted` : `Clear ${aName}`;
                    return <button key={id} title={aName} aria-label={cycleLabel} onClick={() => handleInstrUpdate(s.id, id, nextVal)} style={{ flex: 1, minWidth: 28, maxWidth: 40, height: 22, borderRadius: 4, background: st === "mastery" ? "#D4EDDA" : st === "revision" ? "#FFF3CD" : st === "not_submitted" ? "#FCE8E8" : "#F5F4F0", border: !st ? "1.5px dashed #E8E6E1" : "1.5px solid transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: st === "mastery" ? "#2D6A4F" : st === "revision" ? "#856404" : st === "not_submitted" ? "#C0392B" : "transparent", cursor: "pointer", padding: 0 }}>{st === "mastery" ? "M" : st === "revision" ? "R" : st === "not_submitted" ? "NS" : ""}</button>;
                  })}
                </div>
                <div style={{ width: 50, flexShrink: 0, textAlign: "right", fontFamily: F.b, fontSize: 11, color: mm ? "#E65100" : "#767676" }}>{sg === "early" ? "—" : sg}{mm ? " ⚠" : ""}</div>
              </div>;
            }); })()}
            </div>{/* end minWidth scroll inner */}
          </div>
          <div style={{ fontFamily: F.b, fontSize: 11, color: "#767676", marginTop: 8 }}>"Self" = student self-reported track. ⚠ = mismatch.{gridSearch && ` Showing ${gridSearch} filter.`}{testCount > 0 ? ` ${testCount} test account${testCount === 1 ? '' : 's'} hidden.` : ''}</div>
          </>}

          <div style={{ marginTop: 20 }}>
            <Lbl s={{ marginBottom: 8 }} onClick={() => setExpTokLookup(!expTokLookup)} expanded={expTokLookup}>Token Lookup</Lbl>
            {expTokLookup && <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", padding: "12px 16px" }}>
              <input value={tokSearch} onChange={e => { setTokSearch(e.target.value); setTokExpand(null); }} placeholder="Search student name..." aria-label="Search student by name" 
                style={{ width: "100%", padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12, boxSizing: "border-box", outline: "none", marginBottom: tokSearch.length > 0 ? 8 : 0 }} />
              {tokSearch.length > 0 && (() => {
                const q = tokSearch.toLowerCase();
                const matches = [...students].filter(s => `${s.first} ${s.last}`.toLowerCase().includes(q) || `${s.last} ${s.first}`.toLowerCase().includes(q) || `${s.last}, ${s.first}`.toLowerCase().includes(q)).sort((a, b) => (a.last || "").localeCompare(b.last || ""));
                if (matches.length === 0) return <div style={{ fontFamily: F.b, fontSize: 11, color: "#767676", padding: "4px 0" }}>No students found.</div>;
                return matches.map((s, si) => {
                  const sToks = toks[s.id] || [];
                  const tok = tokBal(sToks.length, 0);
                  const expanded = tokExpand === s.id;
                  return <div key={s.id} style={{ borderBottom: si < matches.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                    <div role="button" tabIndex={0} aria-expanded={expanded} aria-label={`${s.last}, ${s.first} - ${tok.avail} tokens left`} onClick={() => setTokExpand(expanded ? null : s.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTokExpand(expanded ? null : s.id); } }} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", cursor: "pointer" }}>
                      <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 500, flex: 1 }}>{s.last}, {s.first}</div>
                      <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
                        {Array.from({ length: tok.total }).map((_, i) => <div key={i} style={{ width: 12, height: 12, borderRadius: "50%", background: i < tok.avail ? "#CF202E" : "#E0DDD8" }} />)}
                      </div>
                      <div style={{ fontFamily: F.b, fontSize: 11, color: tok.avail === 0 ? "#C0392B" : "#6B6B6B", width: 70, textAlign: "right", flexShrink: 0 }}>{tok.avail} left</div>
                      {sToks.length > 0 && <span style={{ fontSize: 11, color: "#767676", transform: expanded ? "rotate(180deg)" : "", transition: "transform .2s" }}>▾</span>}
                    </div>
                    {expanded && sToks.length > 0 && <div style={{ padding: "2px 0 8px", borderTop: "1px solid #F5F3EF" }}>
                      {sToks.map((t, ti) => { const a = c.assignments.find(x => x.id === t.assignment_id) || (c.tokenGroups || {})[t.assignment_id]; return <div key={ti} style={{ display: "flex", gap: 8, padding: "4px 0", fontFamily: F.b, fontSize: 11, color: "#666" }}>
                        <span style={{ color: "#767676" }}>✦</span>
                        <span style={{ flex: 1 }}>{t.token_type === "revision" ? "Revision" : "Late"}: {a?.name || t.assignment_id}{t.note ? ` — "${t.note}"` : ""}</span>
                        <span style={{ color: "#767676", fontSize: 10 }}>{new Date(t.submitted_at).toLocaleDateString()}</span>
                      </div>; })}
                    </div>}
                    {expanded && sToks.length === 0 && <div style={{ padding: "4px 0 8px", fontFamily: F.b, fontSize: 11, color: "#767676" }}>No tokens used.</div>}
                  </div>;
                });
              })()}
            </div>}
          </div>

          {cpSum.length > 0 && <div style={{ marginTop: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
              <Lbl s={{ marginBottom: 0, flex: 1 }} onClick={() => setExpClassPrep(!expClassPrep)} expanded={expClassPrep}>Class Preparation</Lbl>
              {expClassPrep && <div style={{ display: "flex", gap: 4 }}>
                <input value={cpGridSearch} onChange={e => setCpGridSearch(e.target.value)} placeholder="Filter..." aria-label="Filter class prep students" style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: "#666", background: "#fff", width: 80, outline: "none" }} />
              </div>}
            </div>
            {expClassPrep && <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
              <div style={{ minWidth: 400 }}>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 8, padding: "8px 16px 6px", borderBottom: "2px solid #F0EEEA", background: "#FAFAF7" }}>
                <div style={{ width: 140, flexShrink: 0, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#767676" }}>Student</div>
                <div style={{ flex: 1, display: "flex", gap: 3 }}>{(c.classPrep || []).map(cp => {
                  return <div key={cp.id} style={{ flex: 1, minWidth: 28, maxWidth: 40, display: "flex", alignItems: "flex-end", justifyContent: "center" }} title={cp.name} aria-label={cp.name}>
                    <div style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", fontFamily: F.b, fontSize: 10, fontWeight: 600, color: "#555", textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", maxHeight: 72, lineHeight: 1.2, paddingBottom: 2 }}>{cp.name}</div>
                  </div>;
                })}</div>
                <div style={{ width: 50, flexShrink: 0, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#767676", textAlign: "right" }}>{cpSum.map(cp => `${cp.done}`).join('/')}</div>
              </div>
              {(() => { const cpq = cpGridSearch.toLowerCase(); const cpFiltered = cpq ? sorted.filter(s => `${s.first} ${s.last}`.toLowerCase().includes(cpq) || `${s.last}, ${s.first}`.toLowerCase().includes(cpq)) : sorted; return cpFiltered.map((s, si) => {
                const sCp = cP[s.id] || {};
                const doneCount = (c.classPrep || []).filter(cp => !!sCp[cp.id]).length;
                const allDone = doneCount === (c.classPrep || []).length;
                return <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 16px", borderBottom: si < cpFiltered.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                  <div style={{ width: 140, flexShrink: 0, fontFamily: F.b, fontSize: 12, fontWeight: 500, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.last}, {s.first}</div>
                  <div style={{ flex: 1, display: "flex", gap: 3 }}>
                    {(c.classPrep || []).map(cp => { const done = !!sCp[cp.id];
                      return <div key={cp.id} title={`${cp.name}: ${done ? 'Complete' : 'Not complete'}`} style={{ flex: 1, minWidth: 28, maxWidth: 40, height: 22, borderRadius: 4, background: done ? "#D4EDDA" : "#F5F4F0", border: done ? "1.5px solid #B7DFBF" : "1.5px dashed #E8E6E1", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: done ? "#2D6A4F" : "transparent" }}>{done ? "✓" : ""}</div>;
                    })}
                  </div>
                  <div style={{ width: 50, flexShrink: 0, textAlign: "right", fontFamily: F.b, fontSize: 11, color: allDone ? "#2D6A4F" : "#767676" }}>{doneCount}/{(c.classPrep || []).length}</div>
                </div>;
              }); })()}
              </div>{/* end minWidth scroll inner */}
            </div>}
          </div>}

        </div>}

        {/* SETTINGS — Due dates for assignments and class prep */}
        {tab === "settings" && <div>
          {/* ---- SEMESTER ---- */}
          <Lbl onClick={() => setExpSemester(!expSemester)} expanded={expSemester}>Semester · {termNow}</Lbl>
          {expSemester && <>
          <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 12, lineHeight: 1.5, padding: "8px 12px", background: "#F9F8F5", borderRadius: 8 }}>
            Lumos shows one semester at a time. Changing this hides the previous semester's students and coursework from every view — nothing is deleted, and switching back brings it all straight back. Export your grades before you move on.
          </div>
          <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", padding: "14px 16px", marginBottom: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <label htmlFor="term-select" style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#555" }}>Current semester</label>
              <select
                id="term-select"
                aria-label="Current semester"
                value={termNow}
                onChange={e => { const v = e.target.value; if (v !== termNow) { setTermCourses(Object.keys(COURSES)); setTermPending(v); } }}
                style={{ padding: "6px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13, background: "#fff", cursor: "pointer", outline: "none" }}>
                {termOptions().map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <span style={{ fontFamily: F.b, fontSize: 11, color: "#767676" }}>Showing {termNow}</span>
            </div>
          </div>
          </>}

          {/* ---- START-OF-SEMESTER SETUP ---- */}
          <Lbl onClick={() => setExpSetup(!expSetup)} expanded={expSetup}>Start-of-Semester Setup</Lbl>
          {expSetup && <>
          <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 12, lineHeight: 1.5, padding: "8px 12px", background: "#F9F8F5", borderRadius: 8 }}>
            Copy last semester's due dates into this one as a starting point, then adjust the dates below. Assignments that already have a date this semester are left alone.
          </div>
          <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", padding: "14px 16px", marginBottom: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <label htmlFor="copy-from-term" style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#555" }}>Copy due dates from</label>
              <select id="copy-from-term" aria-label="Copy due dates from semester" defaultValue=""
                style={{ padding: "6px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13, background: "#fff", cursor: "pointer", outline: "none" }}>
                <option value="">Choose a semester…</option>
                {termOptions().filter(o => o.value !== termNow).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <button
                aria-label="Copy due dates from the selected semester"
                disabled={copyBusy}
                onClick={() => { const el = document.getElementById('copy-from-term'); if (el && el.value) handleCopyDueDates(el.value); else showToast('Choose a semester to copy from first.'); }}
                style={{ padding: "6px 14px", background: copyBusy ? "#F5F4F0" : "#fff", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#555", cursor: copyBusy ? "default" : "pointer" }}>
                {copyBusy ? "Copying…" : "Copy"}
              </button>
            </div>
          </div>

          {/* Token cutoff — per course, per semester. Stored in term_settings. */}
          <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 12, lineHeight: 1.5, padding: "8px 12px", background: "#F9F8F5", borderRadius: 8 }}>
            After the token cutoff, students can no longer submit tokens for late work or revisions in this course. Leave it empty to use the course's built-in date.
          </div>
          <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", padding: "14px 16px", marginBottom: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <label htmlFor="cutoff-date" style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#555" }}>Token cutoff for {c.short}</label>
              <input id="cutoff-date" type="date" aria-label={`Token cutoff date for ${c.short}`}
                value={cutoffDraft} onChange={e => setCutoffDraft(e.target.value)}
                style={{ padding: "6px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13, outline: "none" }} />
              <button aria-label="Save token cutoff" disabled={cutoffBusy} onClick={handleSaveCutoff}
                style={{ padding: "6px 14px", background: cutoffBusy ? "#F5F4F0" : "#fff", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#555", cursor: cutoffBusy ? "default" : "pointer" }}>
                {cutoffBusy ? "Saving…" : "Save"}
              </button>
              <span role="status" style={{ fontFamily: F.b, fontSize: 11, color: "#767676" }}>
                Currently: {cutoffLabelFor(ck) || "not set"}
              </span>
            </div>
          </div>
          </>}

          {/* ---- COURSE CODES ---- */}
          <Lbl onClick={() => { const nx = !expCodes; setExpCodes(nx); if (nx && !courseCodes.length) openCourseCodes(); }} expanded={expCodes}>Course Codes</Lbl>
          {expCodes && courseCodes.length > 0 && <div style={{ marginBottom: 18 }}>
            <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 10, lineHeight: 1.5, padding: "8px 12px", background: "#F9F8F5", borderRadius: 8 }}>
              Students use these codes to sign up. Turn a code off when you no longer want new students joining with it.
            </div>
            <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
              {courseCodes.map((cc, i) => <div key={cc.code} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: i < courseCodes.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600 }}>{cc.code}</div>
                  <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginTop: 1 }}>{cc.label || cc.course_key}{cc.section ? ` · ${cc.section}` : ''}</div>
                </div>
                <span style={{ fontFamily: F.b, fontSize: 11, color: cc.active ? "#2D6A4F" : "#767676", minWidth: 52, textAlign: "right" }}>{cc.active ? "Active" : "Off"}</span>
                <button role="switch" aria-checked={!!cc.active} aria-label={`${cc.code} sign-ups ${cc.active ? 'active' : 'off'}`}
                  onClick={() => toggleCourseCode(cc.code, !cc.active)}
                  style={{ width: 40, height: 22, borderRadius: 11, border: cc.active ? "none" : "1px solid #D0CEC9", background: cc.active ? "#2D6A4F" : "#F0EEEA", cursor: "pointer", padding: 0, position: "relative", flexShrink: 0 }}>
                  <span aria-hidden="true" style={{ position: "absolute", top: 2, left: cc.active ? 20 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left .15s", boxShadow: "0 1px 2px rgba(0,0,0,.2)" }} />
                </button>
              </div>)}
            </div>
          </div>}
          {expCodes && codesLoading && <div role="status" style={{ fontFamily: F.b, fontSize: 11, color: "#767676", marginBottom: 18 }}>Loading course codes…</div>}

          <Lbl onClick={() => setExpManageStudents(!expManageStudents)} expanded={expManageStudents}>Manage Students</Lbl>
          {expManageStudents && <>
          <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 12, lineHeight: 1.5, padding: "8px 12px", background: "#F9F8F5", borderRadius: 8 }}>
            Fix a misspelled name, or remove a student who dropped the course. Removing a student hides her from your roster and grade views — her records are kept, and you can restore her later if needed. Mark an account as Test to keep it out of your grade distribution, counts, and exports (useful for colleague sign-ins you use to check the student view).
          </div>
          <div style={{ marginBottom: 8 }}>
            <input value={studentMgmtSearch} onChange={e => setStudentMgmtSearch(e.target.value)} placeholder="Filter students..." aria-label="Filter students to manage" style={{ padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, outline: "none", width: 160 }} />
          </div>
          <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
            {(() => {
              const q = studentMgmtSearch.trim().toLowerCase();
              const list = [...students]
                .filter(s => !q || `${s.first} ${s.last}`.toLowerCase().includes(q) || `${s.last} ${s.first}`.toLowerCase().includes(q) || (s.email || '').toLowerCase().includes(q))
                .sort((a, b) => (a.last || "").localeCompare(b.last || ""));
              if (list.length === 0) return <div style={{ padding: "12px 16px", fontFamily: F.b, fontSize: 11, color: "#767676" }}>No students found.</div>;
              return list.map((s, i) => {
                const isEditing = editStudentId === s.id;
                return <div key={s.id} style={{ borderBottom: i < list.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {!isEditing && <>
                        <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 500 }}>{s.first} {s.last}{s.section ? ` · ${s.section}` : ''}</div>
                        <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{s.email}</div>
                      </>}
                      {isEditing && <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <input value={editFirstName} onChange={e => setEditFirstName(e.target.value)} placeholder="First name" aria-label={`First name for ${s.first} ${s.last}`} autoFocus style={{ padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, outline: "none", width: 110 }} />
                        <input value={editLastName} onChange={e => setEditLastName(e.target.value)} placeholder="Last name" aria-label={`Last name for ${s.first} ${s.last}`} style={{ padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, outline: "none", width: 110 }}
                          onKeyDown={async e => { if (e.key === "Enter") { document.getElementById(`save-name-${s.id}`)?.click(); } }} />
                      </div>}
                    </div>
                    {!isEditing && <>
                      <button onClick={() => { setEditStudentId(s.id); setEditFirstName(s.first || ''); setEditLastName(s.last || ''); }} aria-label={`Edit name for ${s.first} ${s.last}`} style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: "#856404", cursor: "pointer", background: "#fff", flexShrink: 0 }}>✎ Edit name</button>
                      <button role="switch" aria-checked={!!s.isTest} aria-label={`${s.first} ${s.last} is ${s.isTest ? '' : 'not '}a test account`} onClick={() => toggleTestAccount(s.id, !s.isTest)} style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: s.isTest ? "#856404" : "#767676", background: s.isTest ? "#FFFCF5" : "#fff", cursor: "pointer", flexShrink: 0, marginRight: 6 }}>{s.isTest ? "Test ✓" : "Test"}</button>
                      <button onClick={() => setRemoveConfirm({ id: s.id, name: `${s.first} ${s.last}` })} aria-label={`Remove ${s.first} ${s.last} from course`} style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: "#C0392B", cursor: "pointer", background: "#fff", flexShrink: 0 }}>Remove</button>
                    </>}
                    {isEditing && <>
                      <button id={`save-name-${s.id}`} onClick={async () => {
                        const first = editFirstName.trim(), last = editLastName.trim();
                        if (!first || !last) { showToast('First and last name are required', 'error'); return; }
                        const prevFirst = s.first, prevLast = s.last;
                        setCourseData(prev => ({ ...prev, students: prev.students.map(st => st.id === s.id ? { ...st, first, last, name: `${first} ${last}` } : st) }));
                        setEditStudentId(null);
                        const { error } = await updateStudentName(s.id, first, last);
                        if (error) {
                          setCourseData(prev => ({ ...prev, students: prev.students.map(st => st.id === s.id ? { ...st, first: prevFirst, last: prevLast, name: `${prevFirst} ${prevLast}` } : st) }));
                          showToast('Save failed — please try again', 'error');
                        } else {
                          showToast('Name updated ✓', 'success');
                        }
                      }} style={{ padding: "5px 10px", background: c.color, color: "#fff", border: "none", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Save</button>
                      <button onClick={() => setEditStudentId(null)} style={{ padding: "5px 8px", background: "#F5F4F0", color: "#6B6B6B", border: "1px solid #E8E6E1", borderRadius: 5, fontFamily: F.b, fontSize: 11, cursor: "pointer" }}>Cancel</button>
                    </>}
                  </div>
                </div>;
              });
            })()}
          </div>

          <div style={{ marginTop: 10 }}>
            <button onClick={async () => {
              const next = !showDropped;
              setShowDropped(next);
              if (next && droppedStudents.length === 0) {
                setDroppedLoading(true);
                const d = await loadInactiveStudentsForCourse(ck);
                setDroppedStudents(d);
                setDroppedLoading(false);
              }
            }} aria-expanded={showDropped} style={{ padding: "4px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: "#666", background: "#fff", cursor: "pointer" }}>
              {showDropped ? "▾" : "▸"} Dropped students
            </button>
            {showDropped && <div style={{ marginTop: 8, background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
              {droppedLoading && <div style={{ padding: "12px 16px", fontFamily: F.b, fontSize: 11, color: "#767676" }}>Loading...</div>}
              {!droppedLoading && droppedStudents.length === 0 && <div style={{ padding: "12px 16px", fontFamily: F.b, fontSize: 11, color: "#767676" }}>No dropped students.</div>}
              {!droppedLoading && droppedStudents.map((s, i) => <div key={s.id} style={{ borderBottom: i < droppedStudents.length - 1 ? "1px solid #F5F3EF" : "none", display: "flex", alignItems: "center", gap: 10, padding: "10px 16px" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 500 }}>{s.first} {s.last}</div>
                  <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{s.email}</div>
                </div>
                <button onClick={async () => {
                  setDroppedStudents(prev => prev.filter(x => x.id !== s.id));
                  setCourseData(prev => ({ ...prev, students: [...prev.students, s] }));
                  const { error } = await restoreStudentToCourse(s.id, ck);
                  if (error) {
                    setCourseData(prev => ({ ...prev, students: prev.students.filter(x => x.id !== s.id) }));
                    setDroppedStudents(prev => [...prev, s]);
                    showToast('Restore failed — please try again', 'error');
                  } else {
                    showToast(`${s.first} ${s.last} restored ✓`, 'success');
                  }
                }} style={{ padding: "5px 10px", background: c.color, color: "#fff", border: "none", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Restore</button>
              </div>)}
            </div>}
          </div>
          </>}

          {/* Term switch confirmation. Focus is moved to the dialog on open and the
              Escape key cancels; both handled by TermSwitchDialog below. */}
          {termPending && <TermSwitchDialog
            from={termNow}
            to={termPending}
            busy={termSwitching}
            selected={termCourses}
            onToggleCourse={(k) => setTermCourses(cs => cs.includes(k) ? cs.filter(x => x !== k) : [...cs, k])}
            onCancel={() => setTermPending(null)}
            onConfirm={confirmTermSwitch}
          />}

          {removeConfirm && <div role="dialog" aria-modal="true" aria-label={`Remove ${removeConfirm.name}`} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={() => setRemoveConfirm(null)}>
            <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 10, padding: 20, maxWidth: 340, width: "90%" }}>
              <div style={{ fontFamily: F.b, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Remove {removeConfirm.name}?</div>
              <div style={{ fontFamily: F.b, fontSize: 12, color: "#6B6B6B", lineHeight: 1.5, marginBottom: 16 }}>
                She'll be hidden from your roster, grade grid, and CSV export. Her records are kept — you can restore her from "Dropped students" below if needed.
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setRemoveConfirm(null)} style={{ padding: "6px 12px", background: "#F5F4F0", color: "#6B6B6B", border: "1px solid #E8E6E1", borderRadius: 5, fontFamily: F.b, fontSize: 12, cursor: "pointer" }}>Cancel</button>
                <button onClick={async () => {
                  const target = removeConfirm;
                  setRemoveConfirm(null);
                  const removedStudent = students.find(s => s.id === target.id);
                  setCourseData(prev => ({ ...prev, students: prev.students.filter(s => s.id !== target.id) }));
                  const { error } = await removeStudentFromCourse(target.id, ck);
                  if (error) {
                    setCourseData(prev => ({ ...prev, students: removedStudent ? [...prev.students, removedStudent] : prev.students }));
                    showToast('Remove failed — please try again', 'error');
                  } else {
                    if (removedStudent) setDroppedStudents(prev => [...prev, removedStudent]);
                    showToast(`${target.name} removed from course`, 'success');
                  }
                }} style={{ padding: "6px 12px", background: "#C0392B", color: "#fff", border: "none", borderRadius: 5, fontFamily: F.b, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Remove</button>
              </div>
            </div>
          </div>}

          <Lbl s={{ marginTop: 20 }}>Assignment Due Dates</Lbl>
          <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 12, lineHeight: 1.5, padding: "8px 12px", background: "#F9F8F5", borderRadius: 8 }}>
            Set due dates and notes for each assignment. Students see these on their checklist and in the "Due This Week" feed.
          </div>
          {c.groups.map((grp, gi) => <div key={gi} style={{ marginBottom: 14 }}>
            {grp.name && <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: c.color, marginBottom: 4 }}>{grp.name}</div>}
            <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
              {grp.ids.map((id, i) => { const a = c.assignments.find(x => x.id === id); if (!a) return null; const ddObj = dueDates[id]; const ddLabel = ddObj?.label; const ddDate = ddObj?.date; const isEditingDue = editDue === id; const summary = dueSummary(id, courseSections);
                return <div key={id} style={{ borderBottom: i < grp.ids.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px" }}
                    onMouseEnter={e => e.currentTarget.style.background = "#FAFAF7"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 500 }}>{a.name}</div>
                      {summary && !isEditingDue && <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginTop: 1 }}>{summary}</div>}
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); if (isEditingDue) { setEditDue(null); } else { openDueEditor(id, courseSections); } }} aria-label={`${(ddLabel || ddDate) ? 'Edit' : 'Add'} due date for ${a.name}`} style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: (ddLabel || ddDate) ? "#856404" : "#767676", cursor: "pointer", background: "#fff", flexShrink: 0 }}>{ddDate ? "✎ Due" : ddLabel ? "✎ Note" : "+ Due date"}</button>
                    {a.eval === "mastery" ? <Pill t="Mastery" bg="#FFF0F0" c="#C0392B" /> : <Pill t="Completion" bg="#F0F8FF" c="#1565C0" />}
                  </div>
                  {isEditingDue && renderDueEditor(id, a.name, courseSections, c.color)}
                </div>;
              })}
            </div>
          </div>)}

          {(c.classPrep && c.classPrep.length > 0) && <>
          <Lbl s={{ marginTop: 20 }}>Class Preparation Due Dates</Lbl>
          <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
            {c.classPrep.map((cp, i) => { const ddObj = dueDates[cp.id]; const ddLabel = ddObj?.label; const ddDate = ddObj?.date; const isEditingDue = editDue === cp.id; const summary = dueSummary(cp.id, courseSections);
              return <div key={cp.id} style={{ borderBottom: i < c.classPrep.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#FAFAF7"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 500 }}>{cp.name}</div>
                    {summary && !isEditingDue && <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginTop: 1 }}>{summary}</div>}
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); if (isEditingDue) { setEditDue(null); } else { openDueEditor(cp.id, courseSections); } }} aria-label={`${(ddLabel || ddDate) ? 'Edit' : 'Add'} due date for ${cp.name}`} style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: (ddLabel || ddDate) ? "#856404" : "#767676", cursor: "pointer", background: "#fff", flexShrink: 0 }}>{ddDate ? "✎ Due" : ddLabel ? "✎ Note" : "+ Due date"}</button>
                  <Pill t="Completion" bg="#F0F8FF" c="#1565C0" />
                </div>
                {isEditingDue && renderDueEditor(cp.id, cp.name, courseSections, c.color)}
              </div>;
            })}
          </div>
          </>}

          {c.assignments.some(a => a.id === 'les1') && <>
          <Lbl s={{ marginTop: 20 }}>Teaching Dates</Lbl>
          <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 12, lineHeight: 1.5, padding: "8px 12px", background: "#F9F8F5", borderRadius: 8 }}>
            Dates when TCs may teach their lesson. Students pick from these dates; their lesson plan is due 3 days before their chosen date. Dates default to both sections — use the selector to add a date for just one section when they differ.
          </div>
          {['les1', 'les2'].map(aid => {
            const a = c.assignments.find(x => x.id === aid);
            if (!a) return null;
            const dates = teachDates.filter(td => td.assignment_id === aid);
            return <div key={aid} style={{ marginBottom: 14 }}>
              <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: c.color, marginBottom: 4 }}>{a.name}</div>
              <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
                {dates.length === 0 && <div style={{ padding: "12px 16px", fontFamily: F.b, fontSize: 11, color: "#767676" }}>No dates added yet.</div>}
                {dates.map((td, i) => {
                  const isEditing = editTeachDate?.id === td.id;
                  const secName = td.section ? (courseSections?.[td.section]?.name || td.section) : null;
                  return <div key={td.id || td.teach_date} style={{ borderBottom: "1px solid #F5F3EF" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px" }}
                      onMouseEnter={e => e.currentTarget.style.background = "#FAFAF7"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <div style={{ flex: 1, fontFamily: F.b, fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
                        {new Date(td.teach_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                        {courseSections && (secName
                          ? <Pill t={secName} bg="#FFF0F0" c={c.color} />
                          : <Pill t="Both sections" bg="#F0F8FF" c="#1565C0" />)}
                      </div>
                      <button onClick={() => { setEditTeachDate(isEditing ? null : { id: td.id }); setEditTeachDateVal(td.teach_date); }}
                        aria-label={`Edit teaching date ${td.teach_date} for ${a.name}`}
                        style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: "#856404", cursor: "pointer", background: "#fff", flexShrink: 0 }}>
                        ✎ Edit
                      </button>
                      <button onClick={async () => { const ok = await deleteTeachingDate(td.id); if (ok) { showToast('Teaching date removed', 'success'); refresh(); } else { showToast('Remove failed — please try again', 'error'); } }}
                        aria-label={`Remove teaching date ${td.teach_date} for ${a.name}`}
                        style={{ padding: "2px 8px", border: "1px solid #F5B7B7", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: "#C0392B", cursor: "pointer", background: "#fff", flexShrink: 0 }}>
                        Remove
                      </button>
                    </div>
                    {isEditing && <div style={{ padding: "4px 16px 10px 16px", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      <input type="date" value={editTeachDateVal} onChange={e => setEditTeachDateVal(e.target.value)}
                        aria-label={`New date for ${a.name} teaching date`}
                        autoFocus
                        style={{ padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, outline: "none" }} />
                      <button onClick={async () => {
                        if (!editTeachDateVal) return;
                        await updateTeachingDate(td.id, ck, aid, td.teach_date, editTeachDateVal);
                        setEditTeachDate(null);
                        showToast('Teaching date saved ✓', 'success');
                        refresh();
                      }} style={{ padding: "5px 10px", background: c.color, color: "#fff", border: "none", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Save</button>
                      <button onClick={() => setEditTeachDate(null)}
                        style={{ padding: "5px 8px", background: "#F5F4F0", color: "#6B6B6B", border: "1px solid #E8E6E1", borderRadius: 5, fontFamily: F.b, fontSize: 11, cursor: "pointer" }}>Cancel</button>
                    </div>}
                  </div>;
                })}
                <div style={{ padding: "10px 16px", borderTop: dates.length > 0 ? "1px solid #F5F3EF" : "none", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <input type="date" value={newTeachDate[aid] || ''} onChange={e => setNewTeachDate(prev => ({ ...prev, [aid]: e.target.value }))}
                    aria-label={`New teaching date to add for ${a.name}`}
                    style={{ padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, outline: "none" }} />
                  {courseSections && <select value={newTeachSection[aid] || ''} onChange={e => setNewTeachSection(prev => ({ ...prev, [aid]: e.target.value }))}
                    aria-label={`Which section this date is for, for ${a.name}`}
                    style={{ padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, background: "#fff", cursor: "pointer" }}>
                    <option value="">Both sections</option>
                    {Object.keys(courseSections).map(sk => <option key={sk} value={sk}>{courseSections[sk]?.name || sk} only</option>)}
                  </select>}
                  <button onClick={async () => {
                    const d = newTeachDate[aid];
                    if (!d) return;
                    const ok = await addTeachingDate(ck, aid, d, newTeachSection[aid] || null);
                    if (ok) { setNewTeachDate(prev => ({ ...prev, [aid]: '' })); setNewTeachSection(prev => ({ ...prev, [aid]: '' })); refresh(); }
                  }} style={{ padding: "5px 10px", background: c.color, color: "#fff", border: "none", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>+ Add Date</button>
                </div>
              </div>
            </div>;
          })}
          </>}
        </div>}
        {tab === "queue" && <div>
          <div style={{ fontFamily: F.b, fontSize: 11, color: "#777", lineHeight: 1.5, marginBottom: 14, padding: "8px 12px", background: "#F9F8F5", borderRadius: 8 }}>
            Students submit tokens for revisions or late work. Review in Brightspace, then update here.
          </div>
          <div style={{ display: "flex", gap: 0, marginBottom: 12, background: "#F5F4F0", borderRadius: 8, padding: 3 }}>
            {[{ k: "pending", l: `Pending (${pending.length})` }, { k: "resolved", l: "Resolved" }, { k: "all", l: "All" }].map(f => <button aria-pressed={queueFilter === f.k} key={f.k} onClick={() => setQueueFilter(f.k)} style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "none", fontFamily: F.b, fontSize: 11, fontWeight: 600, cursor: "pointer", background: queueFilter === f.k ? "#fff" : "transparent", color: queueFilter === f.k ? "#1A1A1A" : "#767676", boxShadow: queueFilter === f.k ? "0 1px 3px rgba(0,0,0,.1)" : "none" }}>{f.l}</button>)}
          </div>
          {queueFilter === "pending" && pending.length === 0 && <div style={{ background: "#D4EDDA", borderRadius: 10, padding: "24px", textAlign: "center", marginBottom: 16 }}><div style={{ fontSize: 22, marginBottom: 4 }}>✓</div><div style={{ fontFamily: F.b, fontSize: 13, fontWeight: 600, color: "#2D6A4F" }}>All caught up!</div></div>}
          {(() => {
            const filtered = queueFilter === "pending" ? fq.filter(f => !f.resolved) : queueFilter === "resolved" ? fq.filter(f => f.resolved) : fq;
            return <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
              {filtered.map((item, i) => {
                const a = c.assignments.find(x => x.id === item.assignment_id) || (c.tokenGroups || {})[item.assignment_id];
                return <div key={item.id} style={{ padding: "12px 16px", borderBottom: i < filtered.length - 1 ? "1px solid #F5F3EF" : "none", opacity: item.resolved ? .7 : 1, background: item.resolved ? "#FAFAF7" : "transparent" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: item.resolved ? 0 : 8 }}>
                    <div style={{ width: 26, height: 26, borderRadius: 6, background: item.token_type === "late" ? "#F3E8FF" : "#FFF3CD", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 }}>{item.token_type === "late" ? "📥" : "↻"}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 500 }}><strong>{item.sName}</strong> — {a?.name || item.assignment_id}</div>
                      <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>{item.token_type === "late" ? "Late submission" : "Revision"} · {new Date(item.submitted_at).toLocaleDateString()}{item.note ? ` · "${item.note}"` : ""}</div>
                      {item.link && <a href={item.link} target="_blank" rel="noopener noreferrer" style={{ fontFamily: F.b, fontSize: 11, color: "#1565C0", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 3, marginTop: 2 }} onMouseEnter={e => e.currentTarget.style.textDecoration = "underline"} onMouseLeave={e => e.currentTarget.style.textDecoration = "none"}>🔗 View submission</a>}
                    </div>
                    {item.resolved && <Pill t={`→ ${item.resolution}`} bg={item.resolution === "M" ? "#D4EDDA" : "#FFF3CD"} c={item.resolution === "M" ? "#2D6A4F" : "#856404"} />}
                  </div>
                  {!item.resolved && <div style={{ display: "flex", gap: 6, marginLeft: 36 }}>
                    <button onClick={() => handleResolve(item.id, item.profile_id, item.assignment_id, "M")} style={{ padding: "6px 14px", background: "#2D6A4F", color: "#fff", border: "none", borderRadius: 5, cursor: "pointer", fontFamily: F.b, fontSize: 11, fontWeight: 600 }}>Reviewed → Mastered</button>
                    <button onClick={() => handleResolve(item.id, item.profile_id, item.assignment_id, "R")} style={{ padding: "6px 14px", background: "#fff", color: "#856404", border: "1px solid #FFECB5", borderRadius: 5, cursor: "pointer", fontFamily: F.b, fontSize: 11, fontWeight: 600 }}>Reviewed → Still Needs Revision</button>
                    <button onClick={() => handleReturn(item.id, item.profile_id, item.assignment_id)} style={{ padding: "6px 10px", background: "#fff", color: "#C0392B", border: "1px solid #F5B7B7", borderRadius: 5, cursor: "pointer", fontFamily: F.b, fontSize: 11, fontWeight: 600 }}>Return Token</button>
                  </div>}
                  {item.resolved && <div style={{ display: "flex", gap: 6, marginLeft: 36, marginTop: 4 }}>
                    <button onClick={() => handleReturn(item.id, item.profile_id, item.assignment_id)} style={{ padding: "3px 8px", background: "#fff", color: "#C0392B", border: "1px solid #F5B7B7", borderRadius: 4, cursor: "pointer", fontFamily: F.b, fontSize: 9 }}>↩ Return Token</button>
                  </div>}
                </div>;
              })}
              {filtered.length === 0 && <div style={{ padding: "18px", textAlign: "center", fontFamily: F.b, fontSize: 11, color: "#767676" }}>{queueFilter === "resolved" ? "No resolved tokens yet." : "No submissions yet."}</div>}
            </div>;
          })()}
        </div>}

        {/* TRACKS */}
        {tab === "tracks" && <div>
          <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 14 }}>Based on <strong>your</strong> records.{sectionFilter !== 'all' ? ` Showing ${courseSections?.[sectionFilter]?.name || sectionFilter} section.` : ''}</div>
          {["A", "B", "C", "D"].map(g => { const t = c.tracks[g]; const m = TM[g]; const on = filteredStudents.filter(s => calcInstrGrade(iS[s.id] || {}, relAssignments) === g);
            return <div key={g} style={{ marginBottom: 12, background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid #F0EEEA" }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: m.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.d, fontSize: 14, fontWeight: 700, color: m.c }}>{g}</div>
                <div style={{ flex: 1 }}><div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600 }}>{g} Track — {on.length}</div><div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>{[...(t.req || []).map(id => c.assignments.find(a => a.id === id)?.name), ...((t.pick || []).map(p => `any ${Math.min(p.need, p.from.length)} of ${p.label || p.from.map(id => c.assignments.find(a => a.id === id)?.name).join("/")}`))].filter(Boolean).join(", ")}</div></div>
              </div>
              <div style={{ padding: "6px 16px 10px" }}>{on.length === 0 ? <div style={{ fontFamily: F.b, fontSize: 11, color: "#767676" }}>None</div> :
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>{on.map(s => <span key={s.id} style={{ padding: "2px 8px", background: m.bg, borderRadius: 4, fontFamily: F.b, fontSize: 11, fontWeight: 500, color: m.c }}>{s.name}</span>)}</div>}</div>
            </div>;
          })}
          <div style={{ marginTop: 16 }}>
            <Lbl s={{ marginBottom: 8 }} onClick={() => setExpFinalGrades(!expFinalGrades)} expanded={expFinalGrades}>Final Grades Summary</Lbl>
            {expFinalGrades && <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
              {[...filteredStudents].sort((a, b) => (a.last || "").localeCompare(b.last || "")).map((s, i) => {
                const g = calcInstrGrade(iS[s.id] || {}, relAssignments); const m = TM[g] || TM.F;
                return <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px", borderBottom: i < filteredStudents.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                  <div style={{ width: 26, height: 26, borderRadius: "50%", background: m.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.d, fontSize: 12, fontWeight: 700, color: m.c }}>{g === "early" ? "—" : g}</div>
                  <div style={{ fontFamily: F.b, fontSize: 13, fontWeight: 500 }}>{s.last}, {s.first}</div>
                </div>;
              })}
            </div>}
          </div>
        </div>}

        {/* PRACTICUM — SR1 field observation scheduling.
            Role-gated only, never course-gated: the roster spans the term, and
            the course selector above has no bearing on it. Empty in a term with
            no supervised candidates, which is the honest state. */}
        {tab === "practicum" && <div>
          <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 14, lineHeight: 1.5, padding: "8px 12px", background: "#F9F8F5", borderRadius: 8 }}>
            Field observations for the candidates you supervise this semester. Publish a window for a building on a day you will be there, and candidates carve their own lesson time out of it after checking with their cooperating teacher. Two candidates can never hold overlapping times.
          </div>

          {/* ---- AVAILABILITY WINDOWS (collapsed by default) ---- */}
          <Lbl onClick={() => setExpSr1Windows(!expSr1Windows)} expanded={expSr1Windows}>Availability Windows</Lbl>
          {expSr1Windows && <>
            {sr1.buildings.length === 0
              ? <div style={{ fontFamily: F.b, fontSize: 12, color: "#6B6B6B", padding: "12px 16px", background: "#fff", border: "1px solid #E8E6E1", borderRadius: 10, marginBottom: 18 }}>
                  Add at least one building in Roster Setup below before creating a window.
                </div>
              : <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", padding: "14px 16px", marginBottom: 14 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
                    <div>
                      <label htmlFor="sr1-w-building" style={{ display: "block", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>Building</label>
                      <select id="sr1-w-building" defaultValue="" style={{ padding: "6px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12, background: "#fff" }}>
                        <option value="">Choose…</option>
                        {sr1.buildings.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="sr1-w-date" style={{ display: "block", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>Date</label>
                      <input id="sr1-w-date" type="date" style={{ padding: "6px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12 }} />
                    </div>
                    <div>
                      <label htmlFor="sr1-w-start" style={{ display: "block", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>Opens</label>
                      <input id="sr1-w-start" type="time" defaultValue="09:00" style={{ padding: "6px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12 }} />
                    </div>
                    <div>
                      <label htmlFor="sr1-w-end" style={{ display: "block", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>Closes</label>
                      <input id="sr1-w-end" type="time" defaultValue="14:30" style={{ padding: "6px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12 }} />
                    </div>
                    <div>
                      <label htmlFor="sr1-w-refl" style={{ display: "block", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>Reflection (min)</label>
                      <input id="sr1-w-refl" type="number" min="0" max="120" defaultValue="25" style={{ width: 72, padding: "6px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12 }} />
                    </div>
                    <div>
                      <label htmlFor="sr1-w-buffer" style={{ display: "block", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>Buffer (min)</label>
                      <input id="sr1-w-buffer" type="number" min="0" max="120" defaultValue="10" style={{ width: 72, padding: "6px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12 }} />
                    </div>
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <label htmlFor="sr1-w-note" style={{ display: "block", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>Note for candidates (optional)</label>
                    <input id="sr1-w-note" type="text" placeholder="e.g. Available after 12:45" style={{ width: "100%", maxWidth: 420, padding: "6px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12, boxSizing: "border-box" }} />
                  </div>
                  <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <button disabled={sr1Busy} onClick={() => handleCreateSr1Window(true)}
                      style={{ padding: "7px 14px", background: sr1Busy ? "#B0ADA8" : c.color, color: "#fff", border: "none", borderRadius: 6, fontFamily: F.b, fontSize: 12, fontWeight: 600, cursor: sr1Busy ? "default" : "pointer" }}>
                      {sr1Busy ? "Saving…" : "Create & publish"}
                    </button>
                    <button disabled={sr1Busy} onClick={() => handleCreateSr1Window(false)}
                      style={{ padding: "7px 14px", background: "#fff", color: "#555", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12, fontWeight: 600, cursor: sr1Busy ? "default" : "pointer" }}>
                      Save unpublished
                    </button>
                    <span style={{ fontFamily: F.b, fontSize: 11, color: "#767676" }}>Unpublished windows are invisible to candidates.</span>
                  </div>
                </div>}

            {(() => {
              const todayStr = new Date().toISOString().slice(0, 10);
              const upcoming = sr1.windows.filter(w => w.window_date >= todayStr)
                .sort((a, b) => a.window_date.localeCompare(b.window_date) || a.start_time.localeCompare(b.start_time));
              if (upcoming.length === 0) return <div style={{ fontFamily: F.b, fontSize: 12, color: "#6B6B6B", marginBottom: 18 }}>No upcoming windows.</div>;
              return <div style={{ marginBottom: 18 }}>
                {upcoming.map(w => {
                  const bn = sr1.buildings.find(b => b.id === w.building_id)?.name || "—";
                  const booked = sr1.bookings.filter(bk => bk.window_id === w.id && bk.status === 'booked');
                  return <div key={w.id} style={{ background: "#fff", border: "1px solid #E8E6E1", borderRadius: 10, padding: "10px 14px", marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontFamily: F.b, fontSize: 13, fontWeight: 600 }}>{fmtDateOnly(w.window_date)} · {bn}</div>
                      <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>
                        {fmtTime(centralISO(w.window_date, w.start_time))} – {fmtTime(centralISO(w.window_date, w.end_time))}
                        {` · ${w.reflection_minutes} min reflection · ${w.buffer_minutes} min buffer`}
                        {w.note ? ` · ${w.note}` : ''}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <Pill t={`${booked.length} booked`} bg={booked.length ? "#DCEEFB" : "#F8F7F4"} c={booked.length ? "#1565C0" : "#767676"} />
                      <Pill t={w.published ? "Published" : "Hidden"} bg={w.published ? "#D4EDDA" : "#F5F4F0"} c={w.published ? "#2D6A4F" : "#767676"} />
                      <button onClick={() => handleToggleSr1Window(w)} aria-label={`${w.published ? 'Unpublish' : 'Publish'} window on ${fmtDateOnly(w.window_date)} at ${bn}`}
                        style={{ padding: "3px 9px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, background: "#fff", color: "#555", cursor: "pointer" }}>
                        {w.published ? "Unpublish" : "Publish"}
                      </button>
                      <button onClick={() => handleDeleteSr1Window(w, booked.length)} aria-label={`Delete window on ${fmtDateOnly(w.window_date)} at ${bn}`}
                        style={{ padding: "3px 9px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, background: "#fff", color: "#C0392B", cursor: "pointer" }}>
                        Delete
                      </button>
                    </div>
                  </div>;
                })}
              </div>;
            })()}
          </>}

          {/* ---- CANDIDATES — the page's main content ---- */}
          <Lbl s={{ marginTop: 4 }}>Candidates</Lbl>
          {sr1.roster.length === 0
            ? <div style={{ fontFamily: F.b, fontSize: 12, color: "#6B6B6B", padding: "14px 16px", background: "#fff", border: "1px solid #E8E6E1", borderRadius: 10, marginBottom: 18 }}>
                No supervised candidates this semester. Add them in Roster Setup below.
              </div>
            : <div style={{ marginBottom: 18 }}>
                {sr1.roster.slice()
                  .sort((a, b) => (a.profiles?.last_name || '').localeCompare(b.profiles?.last_name || ''))
                  .map(r => {
                    const nm = `${r.profiles?.first_name || ''} ${r.profiles?.last_name || ''}`.trim() || 'Unknown';
                    const bn = sr1.buildings.find(b => b.id === r.building_id)?.name || "No building set";
                    const active = sr1.bookings.filter(bk => bk.profile_id === r.profile_id && bk.status === 'booked');
                    const now = Date.now();
                    const upcoming = active.filter(bk => new Date(bk.lesson_start).getTime() >= now)
                      .sort((a, b) => new Date(a.lesson_start) - new Date(b.lesson_start));
                    const past = active.filter(bk => new Date(bk.lesson_start).getTime() < now)
                      .sort((a, b) => new Date(b.lesson_start) - new Date(a.lesson_start));
                    const next = upcoming[0] || null;
                    const open = sr1OpenCandidate === r.profile_id;
                    return <div key={r.id} style={{ background: "#fff", border: "1px solid #E8E6E1", borderRadius: 10, marginBottom: 8, overflow: "hidden" }}>
                      <button aria-expanded={open} onClick={() => setSr1OpenCandidate(open ? null : r.profile_id)}
                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "12px 16px", background: "none", border: "none", cursor: "pointer", textAlign: "left", gap: 10 }}>
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: "block", fontFamily: F.b, fontSize: 13, fontWeight: 600, color: "#1A1A1A" }}>{nm}</span>
                          <span style={{ display: "block", fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>
                            {bn}{r.ct_name ? ` · CT: ${r.ct_name}` : ''}
                          </span>
                        </span>
                        <span style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                          <span style={{ fontFamily: F.b, fontSize: 11, color: next ? "#1A1A1A" : "#767676", fontWeight: next ? 600 : 400 }}>
                            {next ? `Next: ${fmtDay(next.lesson_start)}, ${fmtTime(next.lesson_start)}` : "No upcoming"}
                          </span>
                          <Pill t={`${active.length} total`} />
                          <span aria-hidden="true" style={{ fontSize: 12, color: "#767676", transform: open ? "rotate(180deg)" : "", transition: "transform .2s" }}>▾</span>
                        </span>
                      </button>

                      {open && <div style={{ padding: "0 16px 14px", borderTop: "1px solid #F0EEEA" }}>
                        {active.length === 0 && <div style={{ fontFamily: F.b, fontSize: 12, color: "#6B6B6B", paddingTop: 12 }}>No observations scheduled.</div>}

                        {upcoming.length > 0 && <div style={{ paddingTop: 12 }}>
                          {upcoming.map((bk, i) => {
                            const isNext = i === 0;
                            return <div key={bk.id} style={{ padding: "10px 12px", marginBottom: 6, borderRadius: 8, background: isNext ? "#F0F8FF" : "#F9F8F5", borderLeft: isNext ? `3px solid ${c.color}` : "3px solid transparent" }}>
                              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                                <div>
                                  <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600 }}>
                                    {isNext && <span aria-hidden="true" style={{ marginRight: 5 }}>●</span>}
                                    {isNext && <span className="sr-only">Next scheduled. </span>}
                                    {fmtDay(bk.lesson_start)}
                                    {bk.instructor_override && <span style={{ marginLeft: 6 }}><Pill t="Adjusted" bg="#FFF3CD" c="#856404" /></span>}
                                  </div>
                                  <div style={{ fontFamily: F.b, fontSize: 11, color: "#555", marginTop: 2 }}>
                                    Lesson {fmtTimeRange(bk.lesson_start, bk.lesson_end)} · Reflection {fmtTimeRange(bk.reflection_start, bk.reflection_end)}
                                  </div>
                                  <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginTop: 2 }}>{bk.topic}</div>
                                  {bk.override_note && <div style={{ fontFamily: F.b, fontSize: 11, color: "#856404", marginTop: 2 }}>Note: {bk.override_note}</div>}
                                </div>
                                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                                  <button onClick={() => openSr1Edit(bk)} aria-label={`Edit observation for ${nm} on ${fmtDay(bk.lesson_start)}`}
                                    style={{ padding: "3px 9px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, background: "#fff", color: "#555", cursor: "pointer" }}>✎ Edit</button>
                                  <button onClick={() => handleInstrCancelSr1(bk, nm)} aria-label={`Cancel observation for ${nm} on ${fmtDay(bk.lesson_start)}`}
                                    style={{ padding: "3px 9px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, background: "#fff", color: "#C0392B", cursor: "pointer" }}>Cancel</button>
                                </div>
                              </div>
                            </div>;
                          })}
                        </div>}

                        {past.length > 0 && <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #F0EEEA" }}>
                          <div style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#767676", marginBottom: 6 }}>Completed</div>
                          {past.map(bk => <div key={bk.id} style={{ padding: "6px 12px", marginBottom: 4 }}>
                            <div style={{ fontFamily: F.b, fontSize: 12, color: "#767676" }}>
                              {fmtDay(bk.lesson_start)} · Lesson {fmtTimeRange(bk.lesson_start, bk.lesson_end)}
                            </div>
                            <div style={{ fontFamily: F.b, fontSize: 11, color: "#909090" }}>{bk.topic}</div>
                          </div>)}
                        </div>}
                      </div>}
                    </div>;
                  })}
              </div>}

          {/* ---- ROSTER SETUP (collapsed) ---- */}
          <Lbl onClick={() => setExpSr1Roster(!expSr1Roster)} expanded={expSr1Roster}>Roster Setup</Lbl>
          {expSr1Roster && <>
            <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 12, lineHeight: 1.5, padding: "8px 12px", background: "#F9F8F5", borderRadius: 8 }}>
              Set up once a semester. Add your buildings first, then check the candidates you supervise and give each one a building and cooperating teacher.
            </div>

            <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", padding: "14px 16px", marginBottom: 14 }}>
              <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#555", marginBottom: 8 }}>Buildings this semester</div>
              {sr1.buildings.length > 0 && <div style={{ marginBottom: 10 }}>
                {sr1.buildings.map(b => {
                  const inUse = sr1.roster.some(r => r.building_id === b.id) || sr1.windows.some(w => w.building_id === b.id);
                  return <div key={b.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #F5F4F0" }}>
                    <span style={{ fontFamily: F.b, fontSize: 12 }}>{b.name}</span>
                    {inUse
                      ? <span style={{ fontFamily: F.b, fontSize: 11, color: "#767676" }}>In use</span>
                      : <button onClick={() => handleDeleteSr1Building(b)} aria-label={`Remove building ${b.name}`}
                          style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, background: "#fff", color: "#C0392B", cursor: "pointer" }}>Remove</button>}
                  </div>;
                })}
              </div>}
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                <div>
                  <label htmlFor="sr1-new-building" style={{ display: "block", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>Add a building</label>
                  <input id="sr1-new-building" type="text" placeholder="e.g. Lee's Summit North"
                    onKeyDown={e => { if (e.key === 'Enter') handleAddSr1Building(); }}
                    style={{ width: 260, padding: "6px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12 }} />
                </div>
                <button onClick={handleAddSr1Building} disabled={sr1Busy}
                  style={{ padding: "6px 14px", background: "#fff", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#555", cursor: "pointer" }}>Add</button>
              </div>
            </div>

            <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", padding: "14px 16px", marginBottom: 18 }}>
              <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#555", marginBottom: 4 }}>Supervised candidates</div>
              <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 10 }}>
                {SR1_COURSES.includes(ck)
                  ? "Check the candidates you supervise in the field, then set each one's building and cooperating teacher. Candidates from any course appear together in the list above."
                  : `Switch the course selector at the top to ${SR1_COURSES.filter(k => COURSES[k]).join(" or ")} to see a roster.`}
              </div>
              {SR1_COURSES.includes(ck) && (filteredStudents.length === 0
                ? <div style={{ fontFamily: F.b, fontSize: 12, color: "#6B6B6B" }}>No students enrolled.</div>
                : filteredStudents.slice().sort((a, b) => (a.last || '').localeCompare(b.last || '')).map(s => {
                    const sup = sr1.roster.find(r => r.profile_id === s.id);
                    const on = !!sup;
                    return <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: "1px solid #F5F4F0", flexWrap: "wrap" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", minWidth: 190 }}>
                        <input type="checkbox" checked={on} onChange={() => handleToggleSr1Supervision(s, on)}
                          aria-label={`${on ? 'Remove' : 'Add'} ${s.first} ${s.last} ${on ? 'from' : 'to'} practicum supervision`}
                          style={{ width: 16, height: 16, cursor: "pointer", accentColor: c.color }} />
                        <span style={{ fontFamily: F.b, fontSize: 12 }}>{s.last}, {s.first}</span>
                      </label>
                      {on && <>
                        <select aria-label={`Placement building for ${s.first} ${s.last}`} value={sup.building_id || ''}
                          onChange={e => handleSetSr1Field(s.id, 'building_id', e.target.value || null)}
                          style={{ padding: "4px 8px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, background: "#fff" }}>
                          <option value="">Choose building…</option>
                          {sr1.buildings.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                        <input type="text" defaultValue={sup.ct_name || ''} placeholder="Cooperating teacher"
                          aria-label={`Cooperating teacher for ${s.first} ${s.last}`}
                          onBlur={e => { if (e.target.value !== (sup.ct_name || '')) handleSetSr1Field(s.id, 'ct_name', e.target.value); }}
                          style={{ padding: "4px 8px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, width: 170 }} />
                      </>}
                    </div>;
                  }))}

              {/* Candidates supervised from a course other than the one
                  currently selected. Without this, a 3820 candidate would be
                  invisible (and so un-editable) while the selector sits on
                  4850 — supervision spans courses, but this picker cannot. */}
              {SR1_COURSES.includes(ck) && (() => {
                const shownIds = new Set(filteredStudents.map(s => s.id));
                const elsewhere = sr1.roster.filter(r => !shownIds.has(r.profile_id));
                if (elsewhere.length === 0) return null;
                return <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #F0EEEA" }}>
                  <div style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#767676", marginBottom: 6 }}>
                    Also supervised, from another course
                  </div>
                  {elsewhere
                    .slice()
                    .sort((a, b) => (a.profiles?.last_name || '').localeCompare(b.profiles?.last_name || ''))
                    .map(r => {
                      const first = r.profiles?.first_name || '';
                      const last = r.profiles?.last_name || '';
                      const nm = `${last}, ${first}`.replace(/^, |, $/, '') || 'Unknown';
                      return <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: "1px solid #F5F4F0", flexWrap: "wrap" }}>
                        <span style={{ fontFamily: F.b, fontSize: 12, minWidth: 190, color: "#555" }}>{nm}</span>
                        <select aria-label={`Placement building for ${first} ${last}`} value={r.building_id || ''}
                          onChange={e => handleSetSr1Field(r.profile_id, 'building_id', e.target.value || null)}
                          style={{ padding: "4px 8px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, background: "#fff" }}>
                          <option value="">Choose building…</option>
                          {sr1.buildings.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                        <input type="text" defaultValue={r.ct_name || ''} placeholder="Cooperating teacher"
                          aria-label={`Cooperating teacher for ${first} ${last}`}
                          onBlur={e => { if (e.target.value !== (r.ct_name || '')) handleSetSr1Field(r.profile_id, 'ct_name', e.target.value); }}
                          style={{ padding: "4px 8px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, width: 170 }} />
                        <button onClick={() => handleToggleSr1Supervision({ id: r.profile_id, first, last }, true)}
                          aria-label={`Remove ${first} ${last} from practicum supervision`}
                          style={{ padding: "3px 9px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, background: "#fff", color: "#C0392B", cursor: "pointer" }}>Remove</button>
                      </div>;
                    })}
                </div>;
              })()}
            </div>
          </>}
        </div>}
      </main>

      {/* Practicum booking edit — the manual-adjustment path.
          Overlaps are not blocked here; they are surfaced and require an
          explicit acknowledgement, which sets instructor_override. That flag
          exempts the row from the exclusion constraint while a database
          trigger still stops candidates booking on top of it. */}
      {sr1EditBooking && (() => {
        const E = sr1EditBooking;
        const bk = E.booking;
        const who = sr1.roster.find(r => r.profile_id === bk.profile_id);
        const nm = `${who?.profiles?.first_name || ''} ${who?.profiles?.last_name || ''}`.trim() || 'Candidate';
        const set = (patch) => setSr1EditBooking(v => ({ ...v, ...patch }));

        const lsISO = centralISO(E.date, E.lessonStart);
        const leISO = centralISO(E.date, E.lessonEnd);
        const rsISO = centralISO(E.date, E.reflStart);
        const reISO = centralISO(E.date, E.reflEnd);
        const valid = lsISO && leISO && rsISO && reISO
          && new Date(leISO) > new Date(lsISO) && new Date(reISO) >= new Date(rsISO);

        // Does this land on anyone else's time? Compare against every other
        // active booking. Computed from the plain timestamp columns plus that
        // booking's own buffer, rather than parsing the tstzrange text — the
        // range's quoting is a Postgres serialization detail, not an API.
        const bufferMin = bk.buffer_minutes ?? 10;
        const spanEnd = valid ? new Date(new Date(reISO).getTime() + bufferMin * 60000) : null;
        const clashes = !valid ? [] : sr1.bookings.filter(o => {
          if (o.id === bk.id || o.status !== 'booked') return false;
          const oS = new Date(o.lesson_start);
          const oE = new Date(new Date(o.reflection_end).getTime() + (o.buffer_minutes ?? 10) * 60000);
          return new Date(lsISO) < oE && oS < spanEnd;
        });
        const needsAck = clashes.length > 0;

        return (
          <div role="dialog" aria-modal="true" aria-labelledby="sr1-edit-title"
            onClick={e => { if (e.target === e.currentTarget) setSr1EditBooking(null); }}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}>
            <div style={{ background: "#fff", borderRadius: 12, padding: "20px 22px", maxWidth: 520, width: "100%", maxHeight: "88vh", overflowY: "auto" }}>
              <h2 id="sr1-edit-title" style={{ fontFamily: F.d, fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Edit observation</h2>
              <div style={{ fontFamily: F.b, fontSize: 12, color: "#6B6B6B", marginBottom: 14 }}>{nm}{who?.ct_name ? ` · CT: ${who.ct_name}` : ''}</div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
                <div>
                  <label htmlFor="sr1-e-date" style={{ display: "block", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>Date</label>
                  <input id="sr1-e-date" type="date" value={E.date} onChange={e => set({ date: e.target.value })}
                    style={{ padding: "6px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12 }} />
                </div>
                <div>
                  <label htmlFor="sr1-e-ls" style={{ display: "block", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>Lesson starts</label>
                  <input id="sr1-e-ls" type="time" value={E.lessonStart}
                    onChange={e => set({ lessonStart: e.target.value })}
                    style={{ padding: "6px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12 }} />
                </div>
                <div>
                  <label htmlFor="sr1-e-le" style={{ display: "block", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>Lesson ends</label>
                  <input id="sr1-e-le" type="time" value={E.lessonEnd}
                    onChange={e => {
                      // Keep reflection glued to the end of the lesson unless it
                      // has been deliberately detached (reflStart !== lessonEnd).
                      const wasAttached = E.reflStart === E.lessonEnd;
                      const patch = { lessonEnd: e.target.value };
                      if (wasAttached) {
                        patch.reflStart = e.target.value;
                        const mins = bk.reflection_minutes ?? 25;
                        const rs = centralISO(E.date, e.target.value);
                        if (rs) patch.reflEnd = new Date(new Date(rs).getTime() + mins * 60000)
                          .toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: SR1_TZ });
                      }
                      set(patch);
                    }}
                    style={{ padding: "6px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12 }} />
                </div>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
                <div>
                  <label htmlFor="sr1-e-rs" style={{ display: "block", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>Reflection starts</label>
                  <input id="sr1-e-rs" type="time" value={E.reflStart} onChange={e => set({ reflStart: e.target.value })}
                    style={{ padding: "6px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12 }} />
                </div>
                <div>
                  <label htmlFor="sr1-e-re" style={{ display: "block", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>Reflection ends</label>
                  <input id="sr1-e-re" type="time" value={E.reflEnd} onChange={e => set({ reflEnd: e.target.value })}
                    style={{ padding: "6px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12 }} />
                </div>
              </div>
              <div style={{ fontFamily: F.b, fontSize: 11, color: "#767676", marginBottom: 12 }}>
                Reflection normally follows the lesson. Set a later start to move it elsewhere in the day.
              </div>

              <div style={{ marginBottom: 10 }}>
                <label htmlFor="sr1-e-topic" style={{ display: "block", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>Topic</label>
                <input id="sr1-e-topic" type="text" value={E.topic} onChange={e => set({ topic: e.target.value })}
                  style={{ width: "100%", padding: "6px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12, boxSizing: "border-box" }} />
              </div>

              <div style={{ marginBottom: 12 }}>
                <label htmlFor="sr1-e-note" style={{ display: "block", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 3 }}>Note to yourself (optional)</label>
                <input id="sr1-e-note" type="text" value={E.overrideNote} onChange={e => set({ overrideNote: e.target.value })}
                  placeholder="e.g. Cut reflection to 15 to fit Jordan's 1:30 lesson"
                  style={{ width: "100%", padding: "6px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12, boxSizing: "border-box" }} />
              </div>

              {valid && <div style={{ fontFamily: F.b, fontSize: 12, color: "#555", background: "#F9F8F5", borderRadius: 6, padding: "8px 10px", marginBottom: 12 }} role="status" aria-live="polite">
                Lesson {fmtTimeRange(lsISO, leISO)} · Reflection {fmtTimeRange(rsISO, reISO)}
              </div>}

              {!valid && <div role="alert" style={{ fontFamily: F.b, fontSize: 12, color: "#C0392B", background: "#FDF2F2", border: "1px solid #F5C6CB", borderRadius: 6, padding: "8px 10px", marginBottom: 12 }}>
                End times must come after start times.
              </div>}

              {needsAck && <div role="alert" style={{ fontFamily: F.b, fontSize: 12, color: "#856404", background: "#FFF3CD", border: "1px solid #FFECB5", borderRadius: 6, padding: "10px 12px", marginBottom: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>⚠ This overlaps {clashes.length} other booking{clashes.length === 1 ? '' : 's'}.</div>
                {clashes.map(o => {
                  const on = sr1.roster.find(r => r.profile_id === o.profile_id);
                  const onm = `${on?.profiles?.first_name || ''} ${on?.profiles?.last_name || ''}`.trim() || 'another candidate';
                  return <div key={o.id} style={{ marginBottom: 2 }}>{onm}: {fmtTimeRange(o.lesson_start, o.reflection_end)}</div>;
                })}
                <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={E.acknowledged} onChange={() => set({ acknowledged: !E.acknowledged })}
                    style={{ width: 16, height: 16, cursor: "pointer", accentColor: "#856404" }} />
                  <span style={{ fontWeight: 600 }}>I know — save anyway</span>
                </label>
              </div>}

              <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, cursor: "pointer" }}>
                <input type="checkbox" checked={E.notify} onChange={() => set({ notify: !E.notify })}
                  style={{ width: 16, height: 16, cursor: "pointer", accentColor: c.color }} />
                <span style={{ fontFamily: F.b, fontSize: 12, color: "#555" }}>Tell {nm.split(' ')[0]} the time changed</span>
              </label>

              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setSr1EditBooking(null)}
                  style={{ padding: "7px 14px", background: "#F0EEEA", color: "#555", border: "none", borderRadius: 6, fontFamily: F.b, fontSize: 12, cursor: "pointer" }}>Cancel</button>
                <button disabled={sr1Busy || !valid || (needsAck && !E.acknowledged)}
                  onClick={async () => {
                    setSr1Busy(true);
                    const moved = lsISO !== bk.lesson_start || leISO !== bk.lesson_end || reISO !== bk.reflection_end;
                    const { error } = await instrUpdateSr1Booking(bk, {
                      lesson_start: lsISO, lesson_end: leISO,
                      reflection_start: rsISO, reflection_end: reISO,
                      topic: E.topic.trim() || bk.topic,
                      reflection_minutes: Math.round((new Date(reISO) - new Date(rsISO)) / 60000),
                      buffer_minutes: bufferMin,
                      instructor_override: needsAck ? true : bk.instructor_override,
                      override_note: E.overrideNote
                    }, E.notify && moved);
                    setSr1Busy(false);
                    if (error) { showToast('Could not save that change — please try again.'); return; }
                    setSr1EditBooking(null);
                    showToast(E.notify && moved ? 'Saved ✓ — candidate notified' : 'Saved ✓', 'success');
                    refreshSr1();
                  }}
                  style={{ padding: "7px 14px", background: (sr1Busy || !valid || (needsAck && !E.acknowledged)) ? "#B0ADA8" : c.color, color: "#fff", border: "none", borderRadius: 6, fontFamily: F.b, fontSize: 12, fontWeight: 600, cursor: (sr1Busy || !valid || (needsAck && !E.acknowledged)) ? "default" : "pointer" }}>
                  {sr1Busy ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Student Preview Modal */}
      {previewStudent && (() => {
        const ps = previewStudent;
        const pvChecks = sC[ps.id] || {};
        const pvInstrSt = iS[ps.id] || {};
        const pvToks = toks[ps.id] || [];
        const pvGrade = calcStudentGrade(pvChecks, pvInstrSt, relAssignments, ck, dueDates);
        const { target: pvTarget, blockers: pvBlockers } = getBlockers(pvChecks, relAssignments, ck, pvInstrSt, dueDates);
        const pvTok = tokBal(pvToks.length, 0);
        return (
          <div role="dialog" aria-modal="true" aria-label={`Student view preview: ${ps.name}`}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 200, overflowY: "auto", padding: "20px 16px" }}
            onClick={() => setPreviewStudent(null)}>
            <div onClick={e => e.stopPropagation()} style={{ background: "#F7F6F2", borderRadius: 14, width: "100%", maxWidth: 680, boxShadow: "0 16px 48px rgba(0,0,0,.2)", overflow: "hidden", marginBottom: 20 }}>
              {/* Preview header banner */}
              <div style={{ background: "#1A1A2E", padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: F.b, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".1em", color: "#A0AEC0" }}>Preview</span>
                  <span style={{ width: 1, height: 12, background: "#4A5568" }} aria-hidden="true" />
                  <span style={{ fontFamily: F.b, fontSize: 13, fontWeight: 600, color: "#fff" }}>{ps.name}</span>
                  <span style={{ fontFamily: F.b, fontSize: 11, color: "#718096", marginLeft: 2 }}>— student view (read-only)</span>
                </div>
                <button onClick={() => setPreviewStudent(null)} aria-label="Close student preview" style={{ background: "none", border: "none", cursor: "pointer", color: "#A0AEC0", fontSize: 18, lineHeight: 1, padding: "0 4px" }}>✕</button>
              </div>

              {/* Simulated student view */}
              <div style={{ padding: "20px 20px 24px" }}>
                {/* Grade card */}
                <div style={{ background: "#fff", border: `2px solid ${(TM[pvGrade] || TM.F).c}`, borderRadius: 14, padding: "20px", marginBottom: 16 }}>
                  <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                    <GradeRing grade={pvGrade} size={50} label={`${ps.name}'s grade track: ${pvGrade}`} />
                    <div style={{ flex: 1, minWidth: 160 }}>
                      <div style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em", color: "#6B6B6B", marginBottom: 2 }}>
                        {pvGrade === "early" ? "Status" : "Based on what's been assigned so far"}
                      </div>
                      <div style={{ fontFamily: F.d, fontSize: 20, fontWeight: 700, color: (TM[pvGrade] || TM.F).c }}>
                        {pvGrade === "early" ? "Getting Started" : pvGrade === "F" ? "You're on F track" : `You're on ${pvGrade} track`}
                      </div>
                      <div style={{ fontFamily: F.b, fontSize: 11, color: "#767676", marginTop: 1 }}>{relAssignments.filter(id => pvChecks[id]).length} of {relAssignments.length} checked off</div>
                    </div>
                    <div style={{ textAlign: "center", padding: "6px 12px", background: "#F9F8F5", borderRadius: 8 }}>
                      <div style={{ display: "flex", gap: 3, justifyContent: "center", marginBottom: 3 }} aria-hidden="true">
                        {Array.from({ length: pvTok.total }).map((_, i) => <div key={i} style={{ width: 12, height: 12, borderRadius: "50%", background: i < pvTok.avail ? "#CF202E" : "#E0DDD8" }} />)}
                      </div>
                      <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>{pvTok.avail} token{pvTok.avail !== 1 ? "s" : ""}</div>
                    </div>
                  </div>
                  {pvTarget && pvBlockers.length > 0 && <div style={{ marginTop: 12, padding: "10px 14px", background: "#FFFCF5", borderRadius: 8, borderLeft: `3px solid ${(TM[pvTarget] || TM.F).c}` }}>
                    <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: (TM[pvTarget] || TM.F).c, marginBottom: 3 }}>To reach {pvTarget} track:</div>
                    <div style={{ fontFamily: F.b, fontSize: 12, color: "#666", lineHeight: 1.6 }}>
                      {pvBlockers.map((id, i) => {
                        const a = c.assignments.find(x => x.id === id);
                        const isMastery = a?.eval === "mastery";
                        const st = pvInstrSt[id];
                        const verb = !isMastery ? "Submit late"
                          : st === "revision" ? "Revise"
                          : st === "not_submitted" ? "Submit late"
                          : "Complete";
                        return <span key={id}>{i > 0 ? " · " : ""}<span style={{ color: "#555", fontWeight: 600 }}>{verb}</span> <strong>{a?.name || id}</strong></span>;
                      })}
                    </div>
                  </div>}
                  {pvGrade === "early" && <div style={{ marginTop: 10, padding: "10px 14px", background: "#F3F4F6", borderRadius: 8, fontFamily: F.b, fontSize: 12, color: "#6B7280" }}>Check off your first assignment to see your grade track!</div>}
                  {pvGrade === "A" && <div style={{ marginTop: 10, padding: "10px 14px", background: "#D4EDDA", borderRadius: 8, fontFamily: F.b, fontSize: 12, color: "#2D6A4F" }}>You're on the highest track — keep it up!</div>}
                </div>

                {/* Assignment checklist — read-only */}
                <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginBottom: 10 }}>Assignment status as this student sees it.</div>
                {c.groups.map((grp, gi) => {
                  const grpA = grp.ids.map(id => c.assignments.find(a => a.id === id)).filter(Boolean);
                  return <div key={gi} style={{ marginBottom: 12 }}>
                    {grp.name && <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: c.color, marginBottom: 5, padding: "0 4px" }}>{grp.name}</div>}
                    <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
                      {grpA.map((a, i) => {
                        const isChecked = !!pvChecks[a.id];
                        const isMastery = a.eval === "mastery";
                        const pvInstr = pvInstrSt[a.id];
                        const isLocked = isMastery && (!pvInstr || pvInstr === 'not_submitted');
                        const isRevision = pvInstr === "revision";
                        const isNS = pvInstr === "not_submitted";

                        if (isLocked) return <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: i < grpA.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                          <div aria-hidden="true" style={{ width: 22, height: 22, borderRadius: 6, border: "2px solid #E0DDD8", background: "#F5F4F0", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                            <span style={{ fontSize: 10, color: "#B0ADA8" }}>🔒</span>
                          </div>
                          <div style={{ flex: 1 }}>
                            <span style={{ fontFamily: F.b, fontSize: 13, color: "#555" }}>{a.name}</span>
                            {(dueDates[a.id]?.date || dueDates[a.id]?.label) && <div style={{ fontFamily: F.b, fontSize: 11, color: "#767676", marginTop: 1 }}>{dueDates[a.id].date ? new Date(dueDates[a.id].date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : ''}{dueDates[a.id].date && dueDates[a.id].label ? ' · ' : ''}{dueDates[a.id].label || ''}</div>}
                            {isNS
                              ? <div style={{ fontFamily: F.b, fontSize: 11, color: "#C0392B", marginTop: 2, fontStyle: "italic" }}>No submission recorded. If you believe this is an error, contact Dr. Beggs.</div>
                              : <div style={{ fontFamily: F.b, fontSize: 11, color: "#767676", marginTop: 2, fontStyle: "italic" }}>Locked until Dr. Beggs reviews your work</div>
                            }
                          </div>
                          <Pill t="Mastery" bg="#FFF0F0" c="#C0392B" />
                        </div>;

                        return <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: i < grpA.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                          <div aria-hidden="true" style={{ width: 22, height: 22, borderRadius: 6, border: isChecked ? "none" : "2px solid #D0CEC9", background: isChecked ? "#CF202E" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                            {isChecked && <span style={{ color: "#fff", fontSize: 13, fontWeight: 700 }}>✓</span>}
                          </div>
                          <div style={{ flex: 1 }}>
                            <span style={{ fontFamily: F.b, fontSize: 13, fontWeight: 500, color: isChecked ? "#767676" : "#1A1A1A", textDecoration: isChecked ? "line-through" : "none", textDecorationColor: "#DDD" }}>{a.name}</span>
                            {(dueDates[a.id]?.date || dueDates[a.id]?.label) && <div style={{ fontFamily: F.b, fontSize: 11, color: isChecked ? "#767676" : "#6B6B6B", marginTop: 1 }}>{dueDates[a.id].date ? new Date(dueDates[a.id].date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : ''}{dueDates[a.id].date && dueDates[a.id].label ? ' · ' : ''}{dueDates[a.id].label || ''}</div>}
                            {isMastery && pvInstr && pvInstr !== 'not_submitted' && !isChecked && <div style={{ fontFamily: F.b, fontSize: 11, color: isRevision ? "#856404" : "#2D6A4F", marginTop: 2 }}>Dr. Beggs left feedback — please review it before checking off</div>}
                          </div>
                          {isMastery && <Pill t="Mastery" bg="#FFF0F0" c="#C0392B" />}
                          {a.eval === "completion" && <Pill t="Completion" bg="#F0F8FF" c="#1565C0" />}
                        </div>;
                      })}
                    </div>
                  </div>;
                })}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
