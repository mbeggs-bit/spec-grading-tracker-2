'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { COURSES, TM, CAL_LINK, BRAND, calcGrade, getBlockers, tokBal, pastCutoff, getTokenCutoff, getTokenTarget, getCourseSections } from '../lib/courses';

const F = { d: "'Source Serif 4',Georgia,serif", b: "'DM Sans',sans-serif" };

/* ================================================================
   DATA LAYER — Supabase reads/writes
   ================================================================ */
async function loadUserProfile(email) {
  const { data } = await supabase.from('profiles').select('*').eq('email', email).single();
  return data;
}

async function loadEnrollments(profileId) {
  const { data } = await supabase.from('enrollments').select('course_key').eq('profile_id', profileId);
  return (data || []).map(e => e.course_key);
}

async function loadReleasedAssignments(courseKey) {
  const { data } = await supabase.from('released_assignments').select('assignment_id').eq('course_key', courseKey);
  const ids = (data || []).map(r => r.assignment_id);
  return ids;
}

async function loadDueDates(courseKey) {
  const { data } = await supabase.from('assignment_due_dates').select('assignment_id, due_label, due_date').eq('course_key', courseKey);
  const map = {};
  (data || []).forEach(r => { map[r.assignment_id] = { label: r.due_label, date: r.due_date || null }; });
  return map;
}

async function upsertDueDate(courseKey, assignmentId, dueLabel, dueDate) {
  if (!dueLabel && !dueDate) {
    await supabase.from('assignment_due_dates').delete().match({ course_key: courseKey, assignment_id: assignmentId });
  } else {
    await supabase.from('assignment_due_dates').upsert({ course_key: courseKey, assignment_id: assignmentId, due_label: dueLabel || null, due_date: dueDate || null, updated_at: new Date().toISOString() }, { onConflict: 'course_key,assignment_id' });
  }
}

async function loadStudentsForCourse(courseKey) {
  const { data } = await supabase.from('enrollments').select('profile_id, section, profiles(id, email, first_name, last_name, role)').eq('course_key', courseKey);
  return (data || []).filter(e => e.profiles?.role === 'student').map(e => ({ id: e.profiles.id, first: e.profiles.first_name, last: e.profiles.last_name, email: e.profiles.email, name: `${e.profiles.first_name} ${e.profiles.last_name}`, section: e.section || null }));
}

async function loadInstrStatuses(courseKey) {
  const { data } = await supabase.from('instructor_statuses').select('*').eq('course_key', courseKey);
  const map = {};
  (data || []).forEach(r => { if (!map[r.profile_id]) map[r.profile_id] = {}; map[r.profile_id][r.assignment_id] = r.status; });
  return map;
}

async function loadInstrNotes(courseKey) {
  const { data } = await supabase.from('instructor_notes').select('*').eq('course_key', courseKey);
  const map = {};
  (data || []).forEach(r => { if (!map[r.profile_id]) map[r.profile_id] = {}; map[r.profile_id][r.assignment_id] = r.note; });
  return map;
}

async function loadStudentChecks(courseKey, profileId) {
  const q = supabase.from('student_checks').select('*').eq('course_key', courseKey);
  if (profileId) q.eq('profile_id', profileId);
  const { data } = await q;
  const map = {};
  (data || []).forEach(r => { if (!map[r.profile_id]) map[r.profile_id] = {}; map[r.profile_id][r.assignment_id] = r.checked; });
  return map;
}

async function loadClassPrep(courseKey, profileId) {
  const q = supabase.from('class_prep').select('*').eq('course_key', courseKey);
  if (profileId) q.eq('profile_id', profileId);
  const { data } = await q;
  const map = {};
  (data || []).forEach(r => { if (!map[r.profile_id]) map[r.profile_id] = {}; map[r.profile_id][r.prep_id] = r.checked; });
  return map;
}

async function loadTokens(courseKey, profileId) {
  const q = supabase.from('tokens').select('*').eq('course_key', courseKey);
  if (profileId) q.eq('profile_id', profileId);
  const { data } = await q;
  const map = {};
  (data || []).forEach(r => { if (!map[r.profile_id]) map[r.profile_id] = []; map[r.profile_id].push(r); });
  return map;
}

async function loadFeedbackQueue(courseKey) {
  const { data } = await supabase.from('feedback_queue').select('*, profiles(first_name, last_name)').eq('course_key', courseKey).order('submitted_at', { ascending: false });
  return (data || []).map(r => ({ ...r, sName: `${r.profiles?.first_name || ''} ${r.profiles?.last_name || ''}`.trim() }));
}

// WRITE OPERATIONS
async function upsertInstrStatus(profileId, courseKey, assignmentId, status) {
  if (!status) {
    await supabase.from('instructor_statuses').delete().match({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId });
  } else {
    await supabase.from('instructor_statuses').upsert({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, status, updated_at: new Date().toISOString() }, { onConflict: 'profile_id,course_key,assignment_id' });
  }
}

async function upsertInstrNote(profileId, courseKey, assignmentId, note) {
  await supabase.from('instructor_notes').upsert({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, note, updated_at: new Date().toISOString() }, { onConflict: 'profile_id,course_key,assignment_id' });
}

async function toggleStudentCheck(profileId, courseKey, assignmentId) {
  const { data: existing } = await supabase.from('student_checks').select('id').match({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId }).single();
  if (existing) {
    await supabase.from('student_checks').delete().eq('id', existing.id);
    return false;
  } else {
    await supabase.from('student_checks').insert({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, checked: true });
    return true;
  }
}

async function toggleClassPrep(profileId, courseKey, prepId) {
  const { data: existing } = await supabase.from('class_prep').select('id').match({ profile_id: profileId, course_key: courseKey, prep_id: prepId }).single();
  if (existing) {
    await supabase.from('class_prep').delete().eq('id', existing.id);
    return false;
  } else {
    await supabase.from('class_prep').insert({ profile_id: profileId, course_key: courseKey, prep_id: prepId, checked: true });
    return true;
  }
}

async function submitToken(profileId, courseKey, assignmentId, tokenType, note, link) {
  await supabase.from('tokens').insert({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, token_type: tokenType, note, link });
  await supabase.from('feedback_queue').insert({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, token_type: tokenType, note, link });
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
  const { data: tok } = await supabase.from('tokens').select('id').match({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId }).order('submitted_at', { ascending: false }).limit(1).single();
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
  const { data } = await supabase.from('teaching_dates').select('*').eq('course_key', courseKey).order('teach_date');
  return data || [];
}

async function loadTeachingSelections(courseKey, profileId) {
  const q = supabase.from('teaching_selections').select('*, profiles(first_name, last_name)').eq('course_key', courseKey);
  if (profileId) q.eq('profile_id', profileId);
  const { data } = await q;
  return data || [];
}

async function pickTeachingDate(profileId, courseKey, assignmentId, teachDate) {
  const planDue = new Date(teachDate);
  planDue.setDate(planDue.getDate() - 3);
  const planDueStr = planDue.toISOString().slice(0, 10);
  // Upsert — if they already picked a date for this assignment, replace it
  const { data: existing } = await supabase.from('teaching_selections').select('id').match({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId }).single();
  if (existing) {
    await supabase.from('teaching_selections').update({ teach_date: teachDate, plan_due_date: planDueStr }).eq('id', existing.id);
  } else {
    await supabase.from('teaching_selections').insert({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, teach_date: teachDate, plan_due_date: planDueStr });
  }
}

async function removeTeachingSelection(profileId, courseKey, assignmentId) {
  await supabase.from('teaching_selections').delete().match({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId });
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

  // Course data
  // Course data — single object to prevent multiple re-renders
  const [courseData, setCourseData] = useState({ rel: [], dueDates: {}, students: [], iS: {}, iN: {}, sC: {}, cP: {}, toks: {}, fq: [], teachDates: [], teachSel: [] });
  const [dataLoading, setDataLoading] = useState(false);
  const { rel, dueDates, students, iS, iN, sC, cP, toks, fq, teachDates, teachSel } = courseData;

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

  // Check auth on mount
  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      const profile = await loadUserProfile(session.user.email);
      if (profile) {
        const courses = await loadEnrollments(profile.id);
        setUser({ profile, courses });
        if (courses.length === 1) setCk(courses[0]);
      }
    }
    setLoading(false);
  }

  // Load course data when ck changes
  useEffect(() => {
    if (ck && user) loadCourseData();
  }, [ck, user]);

  async function loadCourseData(isInitial = true) {
    if (isInitial) setDataLoading(true);
    const [r, dd, s, is, inn, sc, cp, t, f, td, ts] = await Promise.all([
      loadReleasedAssignments(ck),
      loadDueDates(ck),
      user.profile.role === 'instructor' ? loadStudentsForCourse(ck) : Promise.resolve([]),
      user.profile.role === 'instructor' ? loadInstrStatuses(ck) : Promise.resolve({}),
      user.profile.role === 'instructor' ? loadInstrNotes(ck) : Promise.resolve({}),
      loadStudentChecks(ck, user.profile.role === 'student' ? user.profile.id : null),
      loadClassPrep(ck, user.profile.role === 'student' ? user.profile.id : null),
      loadTokens(ck, user.profile.role === 'student' ? user.profile.id : null),
      user.profile.role === 'instructor' ? loadFeedbackQueue(ck) : Promise.resolve([]),
      loadTeachingDates(ck),
      loadTeachingSelections(ck, user.profile.role === 'student' ? user.profile.id : null),
    ]);
    setCourseData({ rel: r, dueDates: dd, students: s, iS: is, iN: inn, sC: sc, cP: cp, toks: t, fq: f, teachDates: td, teachSel: ts });
    if (isInitial) setDataLoading(false);
  }

  const refresh = () => loadCourseData(false);

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
    if (error) { setLoginErr(error.message); return; }
    
    // Sign in immediately
    const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({ email, password: loginPass });
    if (signInErr) { setLoginErr('Account created! Please sign in.'); setIsSignup(false); return; }
    
    const authId = signInData.user.id;
    
    // Check if profile already exists (for students who were in the original pilot)
    const existingProfile = await loadUserProfile(email);
    
    if (!existingProfile) {
      // Create new profile with the auth ID
      await supabase.from('profiles').insert({ id: authId, email, first_name: signupFirst.trim(), last_name: signupLast.trim(), role: 'student' });
      // Create enrollment with section if course code has one
      await supabase.from('enrollments').insert({ profile_id: authId, course_key: courseCode.course_key, section: courseCode.section || null });
    } else if (existingProfile.id !== authId) {
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
        <div role="region" aria-label={isSignup ? "Create account" : "Sign in"} style={{ background: "#fff", border: "1px solid #E8E6E1", borderRadius: 10, padding: "20px" }}>
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
            style={{ width: "100%", padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13, marginBottom: isSignup ? 8 : 12, boxSizing: "border-box", outline: "none" }} />
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
        </div>
        <div style={{ marginTop: 20, padding: "12px 16px", background: "#F9F8F5", borderRadius: 8, border: "1px solid #E8E6E1" }}>
          <div style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 4 }}>Accessibility Statement</div>
          <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", lineHeight: 1.5 }}>Lumos is committed to ensuring digital accessibility for all users. This application conforms to WCAG 2.1 Level AA standards and is designed to work with screen readers, keyboard navigation, and assistive technologies. If you experience any accessibility barriers, please contact Dr. Beggs at <a href="mailto:mbeggs@ucmo.edu" style={{ color: "#1565C0" }}>mbeggs@ucmo.edu</a>.</div>
        </div>
      </div>
    </main>
  );

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
          {user.courses.map(k => {
            const co = COURSES[k]; if (!co) return null;
            return <button key={k} onClick={() => setCk(k)} aria-label={`${co.title} - ${co.assignments.length} assignments`} style={{ display: "block", width: "100%", padding: "16px 20px", marginBottom: 8, background: "#fff", border: "2px solid #E8E6E1", borderRadius: 10, cursor: "pointer", textAlign: "left", position: "relative", overflow: "hidden" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = co.color} onMouseLeave={e => e.currentTarget.style.borderColor = "#E8E6E1"}>
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, background: co.color }} aria-hidden="true" />
              <div style={{ fontFamily: F.d, fontSize: 16, fontWeight: 600 }}>{co.title}</div>
              <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>{co.assignments.length} assignments</div>
            </button>;
          })}
        </main>
      </div>
    );
  }

  if (dataLoading) return <Loading />;

  const c = COURSES[ck];
  const isInstr = user.profile.role === 'instructor';
  const assignmentIds = new Set(c.assignments.map(a => a.id));
  const relAssignments = rel.filter(id => assignmentIds.has(id));
  const relPrep = rel.filter(id => (c.classPrep || []).some(cp => cp.id === id));

  // ---- STUDENT VIEW ----
  if (!isInstr) {
    const myId = user.profile.id;
    const myChecks = sC[myId] || {};
    const myPrep = cP[myId] || {};
    const myToks = toks[myId] || [];
    const grade = calcGrade(myChecks, relAssignments, ck);
    const { target, blockers, msg: bMsg } = getBlockers(myChecks, relAssignments, ck);
    const tok = tokBal(myToks.length, 0);
    const cutoff = pastCutoff(ck);

    const handleCheck = async (aid) => {
      await toggleStudentCheck(myId, ck, aid);
      refresh();
    };
    const handlePrep = async (pid) => {
      await toggleClassPrep(myId, ck, pid);
      refresh();
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
    const showTokenBtn = (a) => !cutoff && tok.avail > 0 && !myChecks[a.id] && relAssignments.includes(a.id) && !(a.tokenGroup && hasGroupToken(a.tokenGroup));

    return (
      <div>
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
                  {grade === "early" ? "Status" : grade === "F" ? "Current Track" : "On Track For"}
                </div>
                <div style={{ fontFamily: F.d, fontSize: 22, fontWeight: 700, color: (TM[grade] || TM.F).c }}>
                  {grade === "early" ? "Getting Started" : grade === "F" ? "Check off assignments to build your track" : `${grade} Track`}
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
                {blockers.map((id, i) => { const a = c.assignments.find(x => x.id === id); return <span key={id}>{i > 0 ? " · " : ""}<strong>{a?.name || id}</strong>{a?.eval === "mastery" ? <span style={{ fontSize: 11, color: "#C0392B", marginLeft: 2 }}>(mastery)</span> : <span style={{ fontSize: 11, color: "#1565C0", marginLeft: 2 }}>(completion)</span>}</span>; })}
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
            <strong style={{ color: "#555" }}>Mastery items:</strong> Wait for Dr. Beggs's feedback — only check off if you've met the specs.
          </div>

          {c.groups.map((grp, gi) => {
            const grpA = grp.ids.map(id => c.assignments.find(a => a.id === id)).filter(Boolean);
            return <div key={gi} style={{ marginBottom: 14 }}>
              {grp.name && <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: c.color, marginBottom: 5, padding: "0 4px" }}>{grp.name}{grp.tokenGroup ? <span style={{ fontWeight: 400, color: "#6B6B6B", fontSize: 11, marginLeft: 6 }}>(1 token covers entire project)</span> : ""}</div>}
              <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
                {grpA.map((a, i) => {
                  const isRel = relAssignments.includes(a.id); const isChecked = !!myChecks[a.id];
                  if (!isRel) return <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", borderBottom: i < grpA.length - 1 ? "1px solid #F5F3EF" : "none", opacity: .5 }}>
                    <div style={{ width: 22, height: 22, borderRadius: 6, border: "2px dashed #E0DDD8", flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <span style={{ fontFamily: F.b, fontSize: 13, color: "#767676" }}>{a.name}</span>
                      {(dueDates[a.id]?.date || dueDates[a.id]?.label) && <div style={{ fontFamily: F.b, fontSize: 11, color: "#767676", marginTop: 1 }}>{dueDates[a.id].date ? new Date(dueDates[a.id].date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : ''}{dueDates[a.id].date && dueDates[a.id].label ? ' · ' : ''}{dueDates[a.id].label || ''}</div>}
                    </div>
                    <span style={{ fontFamily: F.b, fontSize: 11, color: "#767676" }}>Coming soon</span>
                  </div>;
                  return <div key={a.id} style={{ borderBottom: i < grpA.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                    <div role="checkbox" aria-checked={isChecked} aria-label={`${a.name} - ${a.eval}`} tabIndex={0} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", cursor: "pointer" }}
                      onClick={() => handleCheck(a.id)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCheck(a.id); } }}
                      onMouseEnter={e => e.currentTarget.style.background = "#FAFAF7"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <div style={{ width: 22, height: 22, borderRadius: 6, border: isChecked ? "none" : "2px solid #D0CEC9", background: isChecked ? "#CF202E" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .2s", flexShrink: 0 }}>
                        {isChecked && <span style={{ color: "#fff", fontSize: 13, fontWeight: 700 }}>✓</span>}
                      </div>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontFamily: F.b, fontSize: 13, fontWeight: 500, color: isChecked ? "#767676" : "#1A1A1A", textDecoration: isChecked ? "line-through" : "none", textDecorationColor: "#DDD" }}>{a.name}</span>
                        {(dueDates[a.id]?.date || dueDates[a.id]?.label) && <div style={{ fontFamily: F.b, fontSize: 11, color: isChecked ? "#767676" : "#6B6B6B", marginTop: 1 }}>{dueDates[a.id].date ? new Date(dueDates[a.id].date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : ''}{dueDates[a.id].date && dueDates[a.id].label ? ' · ' : ''}{dueDates[a.id].label || ''}</div>}
                      </div>
                      {a.eval === "mastery" && <Pill t="Mastery" bg="#FFF0F0" c="#C0392B" />}
                      {a.eval === "completion" && <Pill t="Completion" bg="#F0F8FF" c="#1565C0" />}
                    </div>
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
              return assignmentIds.map(aid => {
                const a = c.assignments.find(x => x.id === aid);
                const dates = teachDates.filter(td => td.assignment_id === aid);
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
                      {dates.filter(d => !d.closed).map(d => <button key={d.teach_date} aria-label={`Pick teaching date: ${formatDate(d.teach_date)}`} onClick={async () => { await pickTeachingDate(myId, ck, aid, d.teach_date); refresh(); }}
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
                  {t.req.map(id => { const a = c.assignments.find(x => x.id === id); const ch = !!myChecks[id]; const r = rel.includes(id);
                    return <span key={id} style={{ padding: "2px 6px", borderRadius: 5, fontFamily: F.b, fontSize: 11, background: !r ? "#F5F4F0" : ch ? "#D4EDDA" : "#fff", border: `1px solid ${!r ? "#E8E6E1" : ch ? "#B7DFBF" : "#E8E6E1"}`, color: !r ? "#767676" : ch ? "#2D6A4F" : "#555" }}>{ch ? "✓ " : ""}{a?.name || id}</span>;
                  })}
                </div>
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
              {cutoff ? <><br /><strong style={{ color: "#C0392B" }}>Token period has ended ({getTokenCutoff(ck)}).</strong></> : <><br /><span style={{ color: "#6B6B6B" }}>Cutoff: {getTokenCutoff(ck)}</span></>}
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
    await upsertInstrStatus(pid, ck, aid, val);
    refresh();
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
    for (const s of students) { await upsertInstrStatus(s.id, ck, aid, val); }
    refresh();
  };

  // Section filtering — null-safe for Spring 2026 courses
  const courseSections = getCourseSections(ck);
  const hasSections = students.some(s => s.section);
  const sectionKeys = hasSections ? [...new Set(students.map(s => s.section).filter(Boolean))] : [];
  const filteredStudents = sectionFilter === 'all' ? students : students.filter(s => s.section === sectionFilter);

  const sorted = [...filteredStudents].sort((a, b) => {
    if (sortBy === "first") return (a.first || "").localeCompare(b.first || "");
    if (sortBy === "last") return (a.last || "").localeCompare(b.last || "");
    const o = { A: 0, B: 1, C: 2, D: 3, F: 4, early: 5 };
    return (o[calcGrade(iS[a.id] || {}, relAssignments, ck)] || 5) - (o[calcGrade(iS[b.id] || {}, relAssignments, ck)] || 5);
  });

  const dist = { A: 0, B: 0, C: 0, D: 0, F: 0, early: 0 };
  filteredStudents.forEach(s => { const g = calcGrade(iS[s.id] || {}, relAssignments, ck); dist[g] = (dist[g] || 0) + 1; });

  const insights = relAssignments.map(id => { const a = c.assignments.find(x => x.id === id); const rc = filteredStudents.filter(s => (iS[s.id] || {})[id] === "revision").length; const mc = filteredStudents.filter(s => (iS[s.id] || {})[id] === "mastery").length; return { ...a, rc, mc, ns: filteredStudents.length - rc - mc }; }).filter(a => a.rc > 0).sort((a, b) => b.rc - a.rc);
  const cpSum = (c.classPrep || []).map(cp => ({ ...cp, done: filteredStudents.filter(s => (cP[s.id] || {})[cp.id]).length }));

  const exportCSV = () => {
    const filteredStudents = sectionFilter === 'all' ? students : students.filter(s => s.section === sectionFilter);
    const allA = c.assignments.filter(x => relAssignments.includes(x.id)); const cpI = c.classPrep || [];
    const hasSections = students.some(s => s.section);
    const header = ["Last", "First", "Email", ...(hasSections ? ["Section"] : []), ...allA.map(x => x.name + " (Instr)"), ...allA.map(x => x.name + " (Student)"), ...cpI.map(x => x.name + " (Prep)"), "Tokens Used", "Tokens Avail", "Instr Track", "Student Track"].join(",");
    const rows = filteredStudents.map(st => {
      const si = iS[st.id] || {}; const sc = sC[st.id] || {}; const cp2 = cP[st.id] || {}; const tk = (toks[st.id] || []).length;
      const ig = calcGrade(si, rel, ck); const sg = calcGrade(sc, rel, ck); const tok = tokBal(tk, 0);
      return [st.last, st.first, st.email, ...(hasSections ? [st.section || ''] : []), ...allA.map(x => si[x.id] === "mastery" ? "M" : si[x.id] === "revision" ? "R" : ""), ...allA.map(x => sc[x.id] ? "Y" : ""), ...cpI.map(x => cp2[x.id] ? "Y" : ""), tok.used, tok.avail, ig === "early" ? "" : ig, sg === "early" ? "" : sg].map(v => `"${v}"`).join(",");
    });
    const csvContent = header + "\n" + rows.join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" }); const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `${ck.replace(/\s/g, "_")}_${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
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
                ? [{ v: "mastery", l: "✓ Complete", bg: "#D4EDDA", c: "#2D6A4F" }, { v: "", l: "—", bg: "#F5F4F0", c: "#767676" }]
                : [{ v: "mastery", l: "Mastered", bg: "#D4EDDA", c: "#2D6A4F" }, { v: "revision", l: "Revise", bg: "#FFF3CD", c: "#856404" }, { v: "", l: "—", bg: "#F5F4F0", c: "#767676" }];
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
    <div>
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <header style={{ borderBottom: "1px solid #E8E6E1", background: "#fff", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: 1000, margin: "0 auto", padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={handleLogout} aria-label="Sign out" style={{ background: "none", border: "none", cursor: "pointer", fontFamily: F.b, fontSize: 12, color: "#6B6B6B" }}>← Sign out</button>
            <div style={{ width: 1, height: 14, background: "#E0DDD8" }} aria-hidden="true" />
            <select aria-label="Select course" value={ck} onChange={e => { setCk(e.target.value); setSectionFilter('all'); }} style={{ fontFamily: F.d, fontSize: 14, fontWeight: 600, border: "none", background: "none", cursor: "pointer", outline: "none" }}>{user.courses.map(k => <option key={k} value={k}>{COURSES[k]?.short || k}</option>)}</select>
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

      <main id="main-content" style={{ maxWidth: 1000, margin: "0 auto", padding: "18px 20px" }}>
        <nav role="tablist" aria-label="Dashboard sections" style={{ display: "flex", gap: 0, marginBottom: 18, borderBottom: "2px solid #F0EEEA" }}>
          {[{ k: "overview", l: "Overview" }, { k: "manage", l: "Manage" }, { k: "queue", l: "Tokens" }, { k: "tracks", l: "Tracks" }].map(t => <button role="tab" aria-selected={tab === t.k} key={t.k} onClick={() => setTab(t.k)} style={{ padding: "8px 14px", border: "none", cursor: "pointer", fontFamily: F.b, fontSize: 12, fontWeight: 600, color: tab === t.k ? c.color : "#767676", background: "none", borderBottom: tab === t.k ? `2px solid ${c.color}` : "2px solid transparent", marginBottom: -2, position: "relative" }}>{t.l}{t.k === "queue" && pending.length > 0 && <span aria-label={`${pending.length} pending`} style={{ position: "absolute", top: 4, right: 2, minWidth: 16, height: 16, borderRadius: 8, background: "#CF202E", color: "#fff", fontFamily: F.b, fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px" }}>{pending.length}</span>}</button>)}
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
                        const circBg = st === 'mastery' ? '#D4EDDA' : st === 'revision' ? '#FFF3CD' : '#DCEEFB';
                        const circColor = st === 'mastery' ? '#2D6A4F' : st === 'revision' ? '#856404' : '#1565C0';
                        const noteKey = `teach_${ts.profile_id}_${ts.assignment_id}`;
                        const isEditingNote = noteFor === noteKey;
                        const existingNote = (iN[ts.profile_id] || {})[ts.assignment_id];
                        return <div key={ts.id} style={{ borderBottom: si < grp.students.length - 1 ? "1px solid #F5F3EF" : "none", opacity: st === 'mastery' ? 0.5 : 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px" }}>
                            <div style={{ width: 32, height: 32, borderRadius: "50%", background: circBg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.b, fontSize: 11, fontWeight: 600, color: circColor, flexShrink: 0 }}>{st === 'mastery' ? '✓' : st === 'revision' ? 'R' : initials}</div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontFamily: F.b, fontSize: 13, fontWeight: 500, textDecoration: st === 'mastery' ? 'line-through' : 'none', color: st === 'mastery' ? '#767676' : '#1A1A1A' }}>{sName}</div>
                              <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>Teaching {formatDate(ts.teach_date)}{st ? ` · ${st === 'mastery' ? 'Mastered' : 'Needs revision'}` : ''}</div>
                            </div>
                            {!st && <div style={{ display: "flex", gap: 4 }}>
                              <button aria-label={`Mark ${sName} mastered`} onClick={async () => { await upsertInstrStatus(ts.profile_id, ck, ts.assignment_id, 'mastery'); refresh(); }} style={{ padding: "4px 10px", background: "#D4EDDA", border: "1px solid #B7DFBF", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#2D6A4F", cursor: "pointer" }}>M</button>
                              <button aria-label={`Mark ${sName} revision`} onClick={async () => { await upsertInstrStatus(ts.profile_id, ck, ts.assignment_id, 'revision'); refresh(); }} style={{ padding: "4px 10px", background: "#FFF3CD", border: "1px solid #FFECB5", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#856404", cursor: "pointer" }}>R</button>
                              <button aria-label={`Add note for ${sName}`} onClick={() => { setNoteFor(isEditingNote ? null : noteKey); setNoteVal(existingNote || ''); }} style={{ padding: "4px 8px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, color: existingNote ? "#856404" : "#767676", cursor: "pointer", background: "#fff" }}>{existingNote ? "✎" : "+"}</button>
                            </div>}
                            {st === 'revision' && <div style={{ display: "flex", gap: 4 }}>
                              <button aria-label={`Mark ${sName} mastered`} onClick={async () => { await upsertInstrStatus(ts.profile_id, ck, ts.assignment_id, 'mastery'); refresh(); }} style={{ padding: "4px 10px", background: "#D4EDDA", border: "1px solid #B7DFBF", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#2D6A4F", cursor: "pointer" }}>→ M</button>
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
              <button aria-label="Export CSV" onClick={exportCSV} style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: "#666", background: "#fff", cursor: "pointer" }}>📥 CSV</button>
              <button aria-label="Refresh data" onClick={refresh} style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: "#666", background: "#fff", cursor: "pointer" }}>↻ Refresh</button>
            </div>}
          </div>

          {expStudents && <><div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 16px", borderBottom: "2px solid #F0EEEA", background: "#FAFAF7" }}>
              <div style={{ width: 24 }} />
              <div style={{ width: 120, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#767676" }}>Student</div>
              <div style={{ flex: 1, display: "flex", gap: 2 }}>{relAssignments.map(id => { const x = c.assignments.find(a => a.id === id); return <div key={id} style={{ flex: 1, minWidth: 12, maxWidth: 22, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#767676", textAlign: "center", overflow: "hidden" }} title={x?.name}>{(x?.name || "").substring(0, 4)}</div>; })}</div>
              <div style={{ width: 50, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#767676", textAlign: "right" }}>Self</div>
            </div>
            {(() => { const gq = gridSearch.toLowerCase(); const gridFiltered = gq ? sorted.filter(s => `${s.first} ${s.last}`.toLowerCase().includes(gq) || `${s.last}, ${s.first}`.toLowerCase().includes(gq)) : sorted; return gridFiltered.map((s, si) => {
              const ig = calcGrade(iS[s.id] || {}, relAssignments, ck); const sg = calcGrade(sC[s.id] || {}, relAssignments, ck);
              const m = TM[ig] || TM.F; const mm = ig !== sg && ig !== "early" && sg !== "early";
              return <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 16px", borderBottom: si < sorted.length - 1 ? "1px solid #F5F3EF" : "none", background: mm ? "#FFF8F0" : "transparent" }}>
                <div style={{ width: 22, height: 22, borderRadius: "50%", background: m.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.d, fontSize: 11, fontWeight: 700, color: m.c, flexShrink: 0 }}>{ig === "early" ? "—" : ig}</div>
                <div style={{ width: 120, flexShrink: 0, fontFamily: F.b, fontSize: 12, fontWeight: 500, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sortBy === "last" ? `${s.last}, ${s.first}` : s.name}</div>
                <div style={{ flex: 1, display: "flex", gap: 2 }}>
                  {relAssignments.map(id => { const st = (iS[s.id] || {})[id] || "";
                    return <div key={id} title={c.assignments.find(a => a.id === id)?.name} style={{ flex: 1, minWidth: 12, maxWidth: 22, height: 16, borderRadius: 3, background: st === "mastery" ? "#D4EDDA" : st === "revision" ? "#FFF3CD" : "#F5F4F0", border: !st ? "1.5px dashed #E8E6E1" : "1.5px solid transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: st === "mastery" ? "#2D6A4F" : st === "revision" ? "#856404" : "transparent" }}>{st === "mastery" ? "M" : st === "revision" ? "R" : ""}</div>;
                  })}
                </div>
                <div style={{ width: 50, textAlign: "right", fontFamily: F.b, fontSize: 11, color: mm ? "#E65100" : "#767676" }}>{sg === "early" ? "—" : sg}{mm ? " ⚠" : ""}</div>
              </div>;
            }); })()}
          </div>
          <div style={{ fontFamily: F.b, fontSize: 11, color: "#767676", marginTop: 8 }}>"Self" = student self-reported track. ⚠ = mismatch.{gridSearch && ` Showing ${gridSearch} filter.`}</div>
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
            {expClassPrep && <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 16px", borderBottom: "2px solid #F0EEEA", background: "#FAFAF7" }}>
                <div style={{ width: 100, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#767676" }}>Student</div>
                <div style={{ flex: 1, display: "flex", gap: 2 }}>{(c.classPrep || []).map(cp => {
                  const abbr = cp.name.split(' ').map(w => w[0]).join('').substring(0, 4);
                  return <div key={cp.id} style={{ flex: 1, minWidth: 12, maxWidth: 28, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#767676", textAlign: "center", overflow: "hidden" }} title={cp.name}>{abbr}</div>;
                })}</div>
                <div style={{ width: 40, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#767676", textAlign: "right" }}>{cpSum.map(cp => `${cp.done}`).join('/')}</div>
              </div>
              {(() => { const cpq = cpGridSearch.toLowerCase(); const cpFiltered = cpq ? sorted.filter(s => `${s.first} ${s.last}`.toLowerCase().includes(cpq) || `${s.last}, ${s.first}`.toLowerCase().includes(cpq)) : sorted; return cpFiltered.map((s, si) => {
                const sCp = cP[s.id] || {};
                const doneCount = (c.classPrep || []).filter(cp => !!sCp[cp.id]).length;
                const allDone = doneCount === (c.classPrep || []).length;
                return <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 16px", borderBottom: si < cpFiltered.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                  <div style={{ width: 100, flexShrink: 0, fontFamily: F.b, fontSize: 12, fontWeight: 500, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.last}, {s.first}</div>
                  <div style={{ flex: 1, display: "flex", gap: 2 }}>
                    {(c.classPrep || []).map(cp => { const done = !!sCp[cp.id];
                      return <div key={cp.id} title={`${cp.name}: ${done ? 'Complete' : 'Not complete'}`} style={{ flex: 1, minWidth: 12, maxWidth: 28, height: 16, borderRadius: 3, background: done ? "#D4EDDA" : "#F5F4F0", border: done ? "1.5px solid #B7DFBF" : "1.5px dashed #E8E6E1", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: done ? "#2D6A4F" : "transparent" }}>{done ? "✓" : ""}</div>;
                    })}
                  </div>
                  <div style={{ width: 40, textAlign: "right", fontFamily: F.b, fontSize: 11, color: allDone ? "#2D6A4F" : "#767676" }}>{doneCount}/{(c.classPrep || []).length}</div>
                </div>;
              }); })()}
            </div>}
          </div>}

        </div>}

        {/* MANAGE */}
        {tab === "manage" && <div>
          <Lbl>Assignments — toggle to release, set due dates for any assignment</Lbl>
          {c.groups.map((grp, gi) => <div key={gi} style={{ marginBottom: 14 }}>
            {grp.name && <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: c.color, marginBottom: 4 }}>{grp.name}</div>}
            <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
              {grp.ids.map((id, i) => { const a = c.assignments.find(x => x.id === id); if (!a) return null; const isR = rel.includes(id); const ddObj = dueDates[id]; const ddLabel = ddObj?.label; const ddDate = ddObj?.date; const isEditingDue = editDue === id;
                return <div key={id} style={{ borderBottom: i < grp.ids.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px" }}
                    onMouseEnter={e => e.currentTarget.style.background = "#FAFAF7"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <button role="switch" aria-checked={isR} aria-label={a?.name || id} onClick={() => handleToggleRel(id)} style={{ width: 34, height: 18, borderRadius: 9, background: isR ? c.color : "#E0DDD8", border: "none", padding: 0, position: "relative", transition: "background .3s", flexShrink: 0, cursor: "pointer" }}><div style={{ width: 12, height: 12, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: isR ? 19 : 3, transition: "left .3s", boxShadow: "0 1px 2px rgba(0,0,0,.15)" }} /></button>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 500 }}>{a.name}</div>
                      {(ddLabel || ddDate) && !isEditingDue && <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginTop: 1 }}>{ddDate ? new Date(ddDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : ''}{ddLabel && ddDate ? ' · ' : ''}{ddLabel || ''}</div>}
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); setEditDue(isEditingDue ? null : id); setEditDueVal(ddLabel || ''); setEditDueDate(ddDate || ''); }} style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: (ddLabel || ddDate) ? "#856404" : "#767676", cursor: "pointer", background: "#fff", flexShrink: 0 }}>{ddDate ? "✎ Due" : ddLabel ? "✎ Note" : "+ Due date"}</button>
                    {a.eval === "mastery" ? <Pill t="Mastery" bg="#FFF0F0" c="#C0392B" /> : <Pill t="Completion" bg="#F0F8FF" c="#1565C0" />}
                  </div>
                  {isEditingDue && <div style={{ padding: "4px 16px 10px 60px", display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <input type="date" value={editDueDate} onChange={e => setEditDueDate(e.target.value)} aria-label="Due date" style={{ padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, outline: "none" }} />
                    <input value={editDueVal} onChange={e => setEditDueVal(e.target.value)} placeholder="e.g. Before class, By end of day" aria-label="Due date note"
                      style={{ flex: 2, minWidth: 140, padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, outline: "none" }}
                      onKeyDown={async e => { if (e.key === "Enter") { await upsertDueDate(ck, id, editDueVal, editDueDate); setEditDue(null); refresh(); } }} />
                    <input type="date" value={editDueDate} onChange={e => setEditDueDate(e.target.value)} aria-label="Due date" style={{ padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, outline: "none" }} />
                    <button onClick={async () => { await upsertDueDate(ck, id, editDueVal, editDueDate); setEditDue(null); refresh(); }} style={{ padding: "5px 10px", background: c.color, color: "#fff", border: "none", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Save</button>
                    <button onClick={async () => { await upsertDueDate(ck, id, '', ''); setEditDue(null); refresh(); }} style={{ padding: "5px 8px", background: "#F5F4F0", color: "#6B6B6B", border: "1px solid #E8E6E1", borderRadius: 5, fontFamily: F.b, fontSize: 11, cursor: "pointer" }}>Clear</button>
                  </div>}
                </div>;
              })}
            </div>
          </div>)}

          {(c.classPrep && c.classPrep.length > 0) && <>
          <Lbl s={{ marginTop: 20 }}>Class Preparation — toggle to release, set due dates</Lbl>
          <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
            {c.classPrep.map((cp, i) => { const isR = rel.includes(cp.id); const ddObj = dueDates[cp.id]; const ddLabel = ddObj?.label; const ddDate = ddObj?.date; const isEditingDue = editDue === cp.id;
              return <div key={cp.id} style={{ borderBottom: i < c.classPrep.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#FAFAF7"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <button role="switch" aria-checked={isR} aria-label={cp.name} onClick={() => handleToggleRel(cp.id)} style={{ width: 34, height: 18, borderRadius: 9, background: isR ? c.color : "#E0DDD8", position: "relative", transition: "background .3s", flexShrink: 0, cursor: "pointer", border: "none", padding: 0 }}><div style={{ width: 12, height: 12, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: isR ? 19 : 3, transition: "left .3s", boxShadow: "0 1px 2px rgba(0,0,0,.15)" }} /></button>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 500 }}>{cp.name}</div>
                    {(ddLabel || ddDate) && !isEditingDue && <div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B", marginTop: 1 }}>{ddDate ? new Date(ddDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : ''}{ddLabel && ddDate ? ' · ' : ''}{ddLabel || ''}</div>}
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); setEditDue(isEditingDue ? null : cp.id); setEditDueVal(ddLabel || ''); setEditDueDate(ddDate || ''); }} style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 11, color: (ddLabel || ddDate) ? "#856404" : "#767676", cursor: "pointer", background: "#fff", flexShrink: 0 }}>{ddDate ? "✎ Due" : ddLabel ? "✎ Note" : "+ Due date"}</button>
                  <Pill t="Completion" bg="#F0F8FF" c="#1565C0" />
                </div>
                {isEditingDue && <div style={{ padding: "4px 16px 10px 60px", display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <input type="date" value={editDueDate} onChange={e => setEditDueDate(e.target.value)} aria-label="Due date" autoFocus style={{ padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, outline: "none" }} />
                  <input value={editDueVal} onChange={e => setEditDueVal(e.target.value)} placeholder="e.g. Before class, By end of day" aria-label="Due date note" style={{ flex: 2, minWidth: 140, padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, outline: "none" }} onKeyDown={async e => { if (e.key === "Enter") { await upsertDueDate(ck, cp.id, editDueVal, editDueDate); setEditDue(null); refresh(); } }} />
                  <input type="date" value={editDueDate} onChange={e => setEditDueDate(e.target.value)} aria-label="Due date" style={{ padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, outline: "none" }} />
                  <button onClick={async () => { await upsertDueDate(ck, cp.id, editDueVal, editDueDate); setEditDue(null); refresh(); }} style={{ padding: "5px 10px", background: c.color, color: "#fff", border: "none", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Save</button>
                  <button onClick={async () => { await upsertDueDate(ck, cp.id, '', ''); setEditDue(null); refresh(); }} style={{ padding: "5px 8px", background: "#F5F4F0", color: "#6B6B6B", border: "1px solid #E8E6E1", borderRadius: 5, fontFamily: F.b, fontSize: 11, cursor: "pointer" }}>Clear</button>
                </div>}
              </div>;
            })}
          </div>
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
          {["A", "B", "C", "D"].map(g => { const t = c.tracks[g]; const m = TM[g]; const on = filteredStudents.filter(s => calcGrade(iS[s.id] || {}, relAssignments, ck) === g);
            return <div key={g} style={{ marginBottom: 12, background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid #F0EEEA" }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: m.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.d, fontSize: 14, fontWeight: 700, color: m.c }}>{g}</div>
                <div style={{ flex: 1 }}><div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600 }}>{g} Track — {on.length}</div><div style={{ fontFamily: F.b, fontSize: 11, color: "#6B6B6B" }}>{t.req.map(id => c.assignments.find(a => a.id === id)?.name).join(", ")}</div></div>
              </div>
              <div style={{ padding: "6px 16px 10px" }}>{on.length === 0 ? <div style={{ fontFamily: F.b, fontSize: 11, color: "#767676" }}>None</div> :
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>{on.map(s => <span key={s.id} style={{ padding: "2px 8px", background: m.bg, borderRadius: 4, fontFamily: F.b, fontSize: 11, fontWeight: 500, color: m.c }}>{s.name}</span>)}</div>}</div>
            </div>;
          })}
          <div style={{ marginTop: 16 }}>
            <Lbl s={{ marginBottom: 8 }} onClick={() => setExpFinalGrades(!expFinalGrades)} expanded={expFinalGrades}>Final Grades Summary</Lbl>
            {expFinalGrades && <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
              {[...filteredStudents].sort((a, b) => (a.last || "").localeCompare(b.last || "")).map((s, i) => {
                const g = calcGrade(iS[s.id] || {}, relAssignments, ck); const m = TM[g] || TM.F;
                return <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px", borderBottom: i < filteredStudents.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                  <div style={{ width: 26, height: 26, borderRadius: "50%", background: m.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.d, fontSize: 12, fontWeight: 700, color: m.c }}>{g === "early" ? "—" : g}</div>
                  <div style={{ fontFamily: F.b, fontSize: 13, fontWeight: 500 }}>{s.last}, {s.first}</div>
                </div>;
              })}
            </div>}
          </div>
        </div>}
      </main>
    </div>
  );
}
