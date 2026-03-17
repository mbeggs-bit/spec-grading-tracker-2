'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { COURSES, TM, CAL_LINK, TOKEN_CUTOFF, BRAND, calcGrade, getBlockers, tokBal, pastCutoff, getTokenTarget } from '../lib/courses';

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
  return (data || []).map(r => r.assignment_id);
}

async function loadStudentsForCourse(courseKey) {
  const { data } = await supabase.from('enrollments').select('profile_id, profiles(id, email, first_name, last_name, role)').eq('course_key', courseKey);
  return (data || []).filter(e => e.profiles?.role === 'student').map(e => ({ id: e.profiles.id, first: e.profiles.first_name, last: e.profiles.last_name, email: e.profiles.email, name: `${e.profiles.first_name} ${e.profiles.last_name}` }));
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

async function submitToken(profileId, courseKey, assignmentId, tokenType, note) {
  await supabase.from('tokens').insert({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, token_type: tokenType, note });
  await supabase.from('feedback_queue').insert({ profile_id: profileId, course_key: courseKey, assignment_id: assignmentId, token_type: tokenType, note });
}

async function resolveQueueItem(queueId, profileId, courseKey, assignmentId, resolution) {
  await supabase.from('feedback_queue').update({ resolved: true, resolution, resolved_at: new Date().toISOString() }).eq('id', queueId);
  if (resolution === 'M' || resolution === 'R') {
    const status = resolution === 'M' ? 'mastery' : 'revision';
    await upsertInstrStatus(profileId, courseKey, assignmentId, status);
  }
}

async function toggleReleased(courseKey, assignmentId) {
  const { data: existing } = await supabase.from('released_assignments').select('id').match({ course_key: courseKey, assignment_id: assignmentId }).single();
  if (existing) {
    await supabase.from('released_assignments').delete().eq('id', existing.id);
  } else {
    await supabase.from('released_assignments').insert({ course_key: courseKey, assignment_id: assignmentId });
  }
}

/* ================================================================
   TINY COMPONENTS
   ================================================================ */
function Pill({ t, bg = "#F8F7F4", c = "#AAA" }) { return <span style={{ display: "inline-block", padding: "2px 7px", borderRadius: 4, fontFamily: F.b, fontSize: 10, fontWeight: 600, background: bg, color: c, whiteSpace: "nowrap" }}>{t}</span>; }
function Lbl({ children, s = {} }) { return <div style={{ fontFamily: F.b, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", color: "#999", marginBottom: 10, ...s }}>{children}</div>; }
function GradeRing({ grade, size = 50 }) { const m = TM[grade] || TM.F; const on = grade !== "F" && grade !== "early"; return <div style={{ width: size, height: size, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: on ? m.c : "#F0EEEA", border: `3px solid ${on ? m.c : "#E0DDD8"}`, transition: "all .4s" }}><span style={{ fontSize: size * .38, fontWeight: 700, fontFamily: F.d, color: on ? "#fff" : "#BBB", lineHeight: 1 }}>{grade === "early" ? "—" : grade}</span></div>; }
function Loading() { return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}><div style={{ fontFamily: F.b, color: "#999", fontSize: 14 }}>Loading...</div></div>; }

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
  const [courseData, setCourseData] = useState({ rel: [], students: [], iS: {}, iN: {}, sC: {}, cP: {}, toks: {}, fq: [] });
  const [dataLoading, setDataLoading] = useState(false);
  const { rel, students, iS, iN, sC, cP, toks, fq } = courseData;

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
  const [noteFor, setNoteFor] = useState(null);
  const [noteVal, setNoteVal] = useState('');
  const [expTracks, setExpTracks] = useState(false);
  const [expTokens, setExpTokens] = useState(false);
  const [expPrep, setExpPrep] = useState(false);

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
    const [r, s, is, inn, sc, cp, t, f] = await Promise.all([
      loadReleasedAssignments(ck),
      user.profile.role === 'instructor' ? loadStudentsForCourse(ck) : Promise.resolve([]),
      user.profile.role === 'instructor' ? loadInstrStatuses(ck) : Promise.resolve({}),
      user.profile.role === 'instructor' ? loadInstrNotes(ck) : Promise.resolve({}),
      loadStudentChecks(ck, user.profile.role === 'student' ? user.profile.id : null),
      loadClassPrep(ck, user.profile.role === 'student' ? user.profile.id : null),
      loadTokens(ck, user.profile.role === 'student' ? user.profile.id : null),
      user.profile.role === 'instructor' ? loadFeedbackQueue(ck) : Promise.resolve([]),
    ]);
    setCourseData({ rel: r, students: s, iS: is, iN: inn, sC: sc, cP: cp, toks: t, fq: f });
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
      // Create enrollment
      await supabase.from('enrollments').insert({ profile_id: authId, course_key: courseCode.course_key });
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
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
      <div style={{ maxWidth: 420, width: "100%", padding: "0 20px" }}>
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div style={{ display: "inline-block", padding: "4px 10px", background: "#CF202E", color: "#fff", fontFamily: F.b, fontSize: 9, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase", borderRadius: 3, marginBottom: 14 }}>Spec Grading Tracker</div>
          <h1 style={{ fontSize: 30, fontWeight: 700, color: "#1A1A1A", lineHeight: 1.15, marginBottom: 6 }}>Own your learning.</h1>
          <p style={{ fontFamily: F.b, fontSize: 13, color: "#999" }}>Track your growth. Make decisions. Pursue mastery.</p>
        </div>
        <div style={{ background: "#fff", border: "1px solid #E8E6E1", borderRadius: 10, padding: "20px" }}>
          <div style={{ fontFamily: F.b, fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em", color: "#888", marginBottom: 10 }}>
            {isSignup ? "Create Your Account" : "Sign In"}
          </div>
          {isSignup && <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input value={signupFirst} onChange={e => { setSignupFirst(e.target.value); setLoginErr(''); }} placeholder="First name"
              style={{ flex: 1, padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13, boxSizing: "border-box", outline: "none" }} />
            <input value={signupLast} onChange={e => { setSignupLast(e.target.value); setLoginErr(''); }} placeholder="Last name"
              style={{ flex: 1, padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13, boxSizing: "border-box", outline: "none" }} />
          </div>}
          <input value={loginEmail} onChange={e => { setLoginEmail(e.target.value); setLoginErr(''); }} placeholder="UCM email (@ucmo.edu)"
            style={{ width: "100%", padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13, marginBottom: 8, boxSizing: "border-box", outline: "none" }} />
          <input value={loginPass} onChange={e => { setLoginPass(e.target.value); setLoginErr(''); }} placeholder={isSignup ? "Create a password (6+ characters)" : "Password"} type="password"
            style={{ width: "100%", padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13, marginBottom: isSignup ? 8 : 12, boxSizing: "border-box", outline: "none" }} />
          {isSignup && <input value={signupCode} onChange={e => { setSignupCode(e.target.value); setLoginErr(''); }} placeholder="Course code (from Dr. Beggs)"
            onKeyDown={e => { if (e.key === 'Enter') handleSignup(); }}
            style={{ width: "100%", padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 13, marginBottom: 12, boxSizing: "border-box", outline: "none" }} />}
          {loginErr && <div style={{ fontFamily: F.b, fontSize: 11, color: "#C0392B", marginBottom: 10, lineHeight: 1.4 }}>{loginErr}</div>}
          <button onClick={isSignup ? handleSignup : handleLogin}
            style={{ width: "100%", padding: "10px", background: "#CF202E", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: F.b, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
            {isSignup ? "Create Account" : "Sign In"}
          </button>
          <button onClick={() => { setIsSignup(!isSignup); setLoginErr(''); }}
            style={{ width: "100%", padding: "8px", background: "none", border: "none", cursor: "pointer", fontFamily: F.b, fontSize: 11, color: "#888" }}>
            {isSignup ? "Already have an account? Sign in" : "First time? Create account"}
          </button>
        </div>
      </div>
    </div>
  );

  // ---- COURSE SELECT ----
  if (!ck) {
    return (
      <div>
        <div style={{ borderBottom: "1px solid #E8E6E1", background: "#fff" }}>
          <div style={{ maxWidth: 600, margin: "0 auto", padding: "10px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontFamily: F.b, fontSize: 11, color: "#999" }}>{user.profile.first_name} {user.profile.last_name} ({user.profile.role})</span>
            <button onClick={handleLogout} style={{ fontFamily: F.b, fontSize: 10, color: "#888", background: "none", border: "1px solid #E0DDD8", borderRadius: 4, padding: "3px 8px", cursor: "pointer" }}>Sign out</button>
          </div>
        </div>
        <div style={{ maxWidth: 600, margin: "0 auto", padding: "40px 20px" }}>
          <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 20 }}>Select Course</h2>
          {user.courses.map(k => {
            const co = COURSES[k]; if (!co) return null;
            return <button key={k} onClick={() => setCk(k)} style={{ display: "block", width: "100%", padding: "16px 20px", marginBottom: 8, background: "#fff", border: "2px solid #E8E6E1", borderRadius: 10, cursor: "pointer", textAlign: "left", position: "relative", overflow: "hidden" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = co.color} onMouseLeave={e => e.currentTarget.style.borderColor = "#E8E6E1"}>
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, background: co.color }} />
              <div style={{ fontFamily: F.d, fontSize: 16, fontWeight: 600 }}>{co.title}</div>
              <div style={{ fontFamily: F.b, fontSize: 11, color: "#888" }}>{co.assignments.length} assignments</div>
            </button>;
          })}
        </div>
      </div>
    );
  }

  if (dataLoading) return <Loading />;

  const c = COURSES[ck];
  const isInstr = user.profile.role === 'instructor';

  // ---- STUDENT VIEW ----
  if (!isInstr) {
    const myId = user.profile.id;
    const myChecks = sC[myId] || {};
    const myPrep = cP[myId] || {};
    const myToks = toks[myId] || [];
    const grade = calcGrade(myChecks, rel, ck);
    const { target, blockers, msg: bMsg } = getBlockers(myChecks, rel, ck);
    const tok = tokBal(myToks.length, 0);
    const cutoff = pastCutoff();

    const handleCheck = async (aid) => {
      await toggleStudentCheck(myId, ck, aid);
      refresh();
    };
    const handlePrep = async (pid) => {
      await toggleClassPrep(myId, ck, pid);
      refresh();
    };
    const handleToken = async () => {
      if (!modal) return;
      await submitToken(myId, ck, modal.id, tfType, tfNote);
      setModal(null); setTfNote(''); setTfType('revision');
      refresh();
    };

    const hasGroupToken = (gid) => myToks.some(t => t.assignment_id === gid);
    const isFirstInGroup = (a) => {
      if (!a.tokenGroup) return true;
      const grp = c.groups.find(g => g.tokenGroup === a.tokenGroup);
      if (!grp) return true;
      return grp.ids.find(id => rel.includes(id) && !myChecks[id]) === a.id;
    };
    const showTokenBtn = (a) => !cutoff && tok.avail > 0 && !myChecks[a.id] && rel.includes(a.id) && !(a.tokenGroup && hasGroupToken(a.tokenGroup));

    return (
      <div>
        <div style={{ borderBottom: "1px solid #E8E6E1", background: "#fff", position: "sticky", top: 0, zIndex: 10 }}>
          <div style={{ maxWidth: 780, margin: "0 auto", padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button onClick={() => setCk(null)} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: F.b, fontSize: 12, color: "#888" }}>← Back</button>
              <div style={{ width: 1, height: 14, background: "#E0DDD8" }} />
              <span style={{ fontFamily: F.d, fontSize: 14, fontWeight: 600 }}>{c.short}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <a href={CAL_LINK} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 12px", background: "#FFF5F5", border: "1px solid #FCDEDE", borderRadius: 7, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#CF202E", textDecoration: "none" }}>📅 Meet with Dr. Beggs</a>
              <a href="mailto:mbeggs@ucmo.edu" style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 12px", background: "#F5F5F5", border: "1px solid #E8E6E1", borderRadius: 7, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#555", textDecoration: "none" }}>✉ Email Dr. Beggs</a>
              <button onClick={handleLogout} style={{ fontFamily: F.b, fontSize: 10, color: "#888", background: "none", border: "1px solid #E0DDD8", borderRadius: 4, padding: "3px 8px", cursor: "pointer" }}>Sign out</button>
            </div>
          </div>
        </div>

        <div style={{ maxWidth: 780, margin: "0 auto", padding: "22px 20px" }}>
          {/* Dashboard */}
          <div style={{ background: "#fff", border: `2px solid ${(TM[grade] || TM.F).c}`, borderRadius: 14, padding: "22px", marginBottom: 18 }}>
            <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
              <GradeRing grade={grade} size={54} />
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontFamily: F.b, fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em", color: "#999", marginBottom: 2 }}>
                  {grade === "early" ? "Status" : grade === "F" ? "Current Track" : "On Track For"}
                </div>
                <div style={{ fontFamily: F.d, fontSize: 22, fontWeight: 700, color: (TM[grade] || TM.F).c }}>
                  {grade === "early" ? "Getting Started" : grade === "F" ? "Check off assignments to build your track" : `${grade} Track`}
                </div>
                <div style={{ fontFamily: F.b, fontSize: 11, color: "#AAA", marginTop: 1 }}>{rel.filter(id => myChecks[id]).length} of {rel.length} checked off</div>
              </div>
              <div style={{ textAlign: "center", padding: "6px 14px", background: "#F9F8F5", borderRadius: 8 }}>
                <div style={{ display: "flex", gap: 3, justifyContent: "center", marginBottom: 3 }}>
                  {Array.from({ length: tok.total }).map((_, i) => <div key={i} style={{ width: 14, height: 14, borderRadius: "50%", background: i < tok.avail ? "#CF202E" : "#E0DDD8", fontSize: 7, color: i < tok.avail ? "#fff" : "#CCC", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>✦</div>)}
                </div>
                <div style={{ fontFamily: F.b, fontSize: 9, color: "#999" }}>{tok.avail} token{tok.avail !== 1 ? "s" : ""}</div>
              </div>
            </div>
            {target && blockers.length > 0 && <div style={{ marginTop: 14, padding: "10px 14px", background: "#FFFCF5", borderRadius: 8, borderLeft: `3px solid ${(TM[target] || TM.F).c}` }}>
              <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: (TM[target] || TM.F).c, marginBottom: 3 }}>To reach {target} track:</div>
              <div style={{ fontFamily: F.b, fontSize: 12, color: "#666", lineHeight: 1.6 }}>
                {blockers.map((id, i) => { const a = c.assignments.find(x => x.id === id); return <span key={id}>{i > 0 ? " · " : ""}<strong>{a?.name || id}</strong>{a?.eval === "mastery" ? <span style={{ fontSize: 10, color: "#C0392B", marginLeft: 2 }}>(mastery)</span> : <span style={{ fontSize: 10, color: "#1565C0", marginLeft: 2 }}>(completion)</span>}</span>; })}
              </div>
            </div>}
            {grade === "early" && <div style={{ marginTop: 12, padding: "10px 14px", background: "#F3F4F6", borderRadius: 8, fontFamily: F.b, fontSize: 12, color: "#6B7280" }}>Check off your first assignment to see your grade track!</div>}
            {grade === "A" && <div style={{ marginTop: 12, padding: "10px 14px", background: "#D4EDDA", borderRadius: 8, fontFamily: F.b, fontSize: 12, color: "#2D6A4F" }}>You're on the highest track — keep it up!</div>}
          </div>

          {/* Checklist */}
          <Lbl>My Progress</Lbl>
          <div style={{ fontFamily: F.b, fontSize: 12, color: "#888", marginBottom: 14, lineHeight: 1.6, padding: "10px 14px", background: "#F9F8F5", borderRadius: 8 }}>
            <strong style={{ color: "#555" }}>Completion items:</strong> Check off once you've submitted your work.<br />
            <strong style={{ color: "#555" }}>Mastery items:</strong> Wait for Dr. Beggs's feedback — only check off if you've met the specs.
          </div>

          {c.groups.map((grp, gi) => {
            const grpA = grp.ids.map(id => c.assignments.find(a => a.id === id)).filter(Boolean);
            return <div key={gi} style={{ marginBottom: 14 }}>
              {grp.name && <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: c.color, marginBottom: 5, padding: "0 4px" }}>{grp.name}{grp.tokenGroup ? <span style={{ fontWeight: 400, color: "#999", fontSize: 10, marginLeft: 6 }}>(1 token covers entire project)</span> : ""}</div>}
              <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
                {grpA.map((a, i) => {
                  const isRel = rel.includes(a.id); const isChecked = !!myChecks[a.id];
                  if (!isRel) return <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", borderBottom: i < grpA.length - 1 ? "1px solid #F5F3EF" : "none", opacity: .35 }}>
                    <div style={{ width: 22, height: 22, borderRadius: 6, border: "2px dashed #E0DDD8", flexShrink: 0 }} />
                    <span style={{ fontFamily: F.b, fontSize: 13, color: "#CCC" }}>{a.name}</span>
                    <span style={{ marginLeft: "auto", fontFamily: F.b, fontSize: 10, color: "#DDD" }}>Not yet assigned</span>
                  </div>;
                  return <div key={a.id} style={{ borderBottom: i < grpA.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", cursor: "pointer" }}
                      onClick={() => handleCheck(a.id)}
                      onMouseEnter={e => e.currentTarget.style.background = "#FAFAF7"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <div style={{ width: 22, height: 22, borderRadius: 6, border: isChecked ? "none" : "2px solid #D0CEC9", background: isChecked ? "#CF202E" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .2s", flexShrink: 0 }}>
                        {isChecked && <span style={{ color: "#fff", fontSize: 13, fontWeight: 700 }}>✓</span>}
                      </div>
                      <span style={{ flex: 1, fontFamily: F.b, fontSize: 13, fontWeight: 500, color: isChecked ? "#999" : "#1A1A1A", textDecoration: isChecked ? "line-through" : "none", textDecorationColor: "#DDD" }}>{a.name}</span>
                      {a.eval === "mastery" && <Pill t="Mastery" bg="#FFF0F0" c="#C0392B" />}
                      {a.eval === "completion" && <Pill t="Completion" bg="#F0F8FF" c="#1565C0" />}
                    </div>
                    {showTokenBtn(a) && isFirstInGroup(a) && <div style={{ padding: "0 16px 10px 48px" }}>
                      <button onClick={(e) => { e.stopPropagation(); const tt = getTokenTarget(a.id, ck); setModal(tt); setTfType("revision"); setTfNote(""); }}
                        style={{ padding: "4px 12px", background: "#FFFCF5", border: "1px solid #FFECB5", borderRadius: 5, fontFamily: F.b, fontSize: 10, fontWeight: 600, color: "#856404", cursor: "pointer" }}>
                        Submit a token{a.tokenGroup ? " (entire project)" : ""}
                      </button>
                    </div>}
                  </div>;
                })}
              </div>
            </div>;
          })}

          {/* Token Modal */}
          {modal && <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={() => setModal(null)}>
            <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 14, padding: "24px", maxWidth: 420, width: "90%", boxShadow: "0 12px 40px rgba(0,0,0,.15)" }}>
              <div style={{ fontFamily: F.d, fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Submit a Token</div>
              <div style={{ fontFamily: F.b, fontSize: 13, color: "#555", marginBottom: 14 }}>{modal.name}</div>
              <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#555", marginBottom: 6 }}>What is this token for?</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                {[{ v: "revision", l: "I revised this" }, { v: "late", l: "I'm submitting late" }].map(o => <button key={o.v} onClick={() => setTfType(o.v)} style={{ padding: "7px 14px", borderRadius: 6, fontFamily: F.b, fontSize: 11, cursor: "pointer", background: tfType === o.v ? c.color : "#fff", color: tfType === o.v ? "#fff" : "#555", border: tfType === o.v ? `1px solid ${c.color}` : "1px solid #E0DDD8", flex: 1, textAlign: "center" }}>{o.l}</button>)}
              </div>
              <input value={tfNote} onChange={e => setTfNote(e.target.value)} placeholder="Note for Dr. Beggs (optional)" style={{ width: "100%", padding: "8px 12px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12, marginBottom: 14, boxSizing: "border-box" }} />
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={handleToken} style={{ padding: "8px 18px", background: c.color, color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: F.b, fontSize: 13, fontWeight: 600 }}>Submit Token</button>
                <button onClick={() => setModal(null)} style={{ padding: "8px 14px", background: "#F0EEEA", color: "#888", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: F.b, fontSize: 12 }}>Cancel</button>
              </div>
              <div style={{ fontFamily: F.b, fontSize: 10, color: "#BBB", marginTop: 8 }}>Uses 1 of your {tok.avail} token{tok.avail !== 1 ? "s" : ""}.</div>
            </div>
          </div>}

          {/* Class Prep */}
          <button onClick={() => setExpPrep(!expPrep)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "12px 16px", background: "#fff", border: "1px solid #E8E6E1", borderRadius: expPrep ? "10px 10px 0 0" : 10, cursor: "pointer", marginBottom: expPrep ? 0 : 12 }}>
            <span style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#555" }}>Class Preparation ({Object.values(myPrep).filter(Boolean).length}/{c.classPrep.length})</span>
            <span style={{ fontSize: 11, color: "#CCC", transform: expPrep ? "rotate(180deg)" : "", transition: "transform .2s" }}>▾</span>
          </button>
          {expPrep && <div style={{ background: "#fff", border: "1px solid #E8E6E1", borderTop: "none", borderRadius: "0 0 10px 10px", padding: "14px 16px", marginBottom: 12 }}>
            <div style={{ fontFamily: F.b, fontSize: 11, color: "#888", marginBottom: 10, lineHeight: 1.5 }}>These do not affect your letter grade. They contribute to your educator disposition assessment.</div>
            {c.classPrep.map((cp, i) => {
              const done = !!myPrep[cp.id];
              return <div key={cp.id} onClick={() => handlePrep(cp.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 4px", borderBottom: i < c.classPrep.length - 1 ? "1px solid #F5F3EF" : "none", cursor: "pointer" }}
                onMouseEnter={e => e.currentTarget.style.background = "#FAFAF7"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <div style={{ width: 20, height: 20, borderRadius: 5, border: done ? "none" : "2px solid #D0CEC9", background: done ? c.color : "#fff", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .2s", flexShrink: 0 }}>{done && <span style={{ color: "#fff", fontSize: 11, fontWeight: 700 }}>✓</span>}</div>
                <span style={{ fontFamily: F.b, fontSize: 12, color: done ? "#999" : "#1A1A1A", textDecoration: done ? "line-through" : "none" }}>{cp.name}</span>
              </div>;
            })}
          </div>}

          {/* Grade Tracks */}
          <button onClick={() => setExpTracks(!expTracks)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "12px 16px", background: "#fff", border: "1px solid #E8E6E1", borderRadius: expTracks ? "10px 10px 0 0" : 10, cursor: "pointer", marginBottom: expTracks ? 0 : 12 }}>
            <span style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#555" }}>Grade Track Requirements</span>
            <span style={{ fontSize: 11, color: "#CCC", transform: expTracks ? "rotate(180deg)" : "", transition: "transform .2s" }}>▾</span>
          </button>
          {expTracks && <div style={{ background: "#fff", border: "1px solid #E8E6E1", borderTop: "none", borderRadius: "0 0 10px 10px", padding: "14px 16px", marginBottom: 12 }}>
            <div style={{ fontFamily: F.b, fontSize: 11, color: "#888", marginBottom: 12 }}>Every item in a track must be checked off to earn that grade.</div>
            {["A", "B", "C", "D"].map(g => { const t = c.tracks[g]; const m = TM[g]; const isOn = grade === g;
              return <div key={g} style={{ marginBottom: 8, padding: "8px 12px", borderRadius: 8, border: isOn ? `2px solid ${m.c}` : "1px solid #F0EEEA", position: "relative" }}>
                {isOn && <span style={{ position: "absolute", top: 6, right: 10, fontFamily: F.b, fontSize: 8, fontWeight: 700, color: "#fff", background: m.c, padding: "2px 6px", borderRadius: 6 }}>YOUR TRACK</span>}
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <div style={{ width: 20, height: 20, borderRadius: "50%", background: m.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.d, fontSize: 11, fontWeight: 700, color: m.c }}>{g}</div>
                  <span style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#333" }}>{g} Track</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                  {t.req.map(id => { const a = c.assignments.find(x => x.id === id); const ch = !!myChecks[id]; const r = rel.includes(id);
                    return <span key={id} style={{ padding: "2px 6px", borderRadius: 5, fontFamily: F.b, fontSize: 10, background: !r ? "#F5F4F0" : ch ? "#D4EDDA" : "#fff", border: `1px solid ${!r ? "#E8E6E1" : ch ? "#B7DFBF" : "#E8E6E1"}`, color: !r ? "#CCC" : ch ? "#2D6A4F" : "#555" }}>{ch ? "✓ " : ""}{a?.name || id}</span>;
                  })}
                </div>
              </div>;
            })}
          </div>}

          {/* Tokens */}
          <button onClick={() => setExpTokens(!expTokens)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "12px 16px", background: "#fff", border: "1px solid #E8E6E1", borderRadius: expTokens ? "10px 10px 0 0" : 10, cursor: "pointer", marginBottom: 12 }}>
            <span style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: "#555" }}>Tokens ({tok.avail} available)</span>
            <span style={{ fontSize: 11, color: "#CCC", transform: expTokens ? "rotate(180deg)" : "", transition: "transform .2s" }}>▾</span>
          </button>
          {expTokens && <div style={{ background: "#fff", border: "1px solid #E8E6E1", borderTop: "none", borderRadius: "0 0 10px 10px", padding: "14px 16px", marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 5, marginBottom: 8 }}>
              {Array.from({ length: tok.total }).map((_, i) => <div key={i} style={{ width: 22, height: 22, borderRadius: "50%", background: i < tok.avail ? "#CF202E" : "#E0DDD8", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: i < tok.avail ? "#fff" : "#CCC", fontWeight: 700 }}>{i < tok.avail ? "✦" : "✕"}</div>)}
            </div>
            <div style={{ fontFamily: F.b, fontSize: 11, color: "#888", marginBottom: 6 }}>3 per course · {tok.used} used · {tok.avail} available</div>
            <div style={{ fontFamily: F.b, fontSize: 11, color: "#999", lineHeight: 1.5 }}>
              Use tokens to <strong style={{ color: "#555" }}>revise</strong> or <strong style={{ color: "#555" }}>submit late work</strong>.
              {cutoff ? <><br /><strong style={{ color: "#C0392B" }}>Token period has ended ({TOKEN_CUTOFF}).</strong></> : <><br /><span style={{ color: "#888" }}>Cutoff: {TOKEN_CUTOFF}</span></>}
            </div>
            {myToks.length > 0 && <div style={{ marginTop: 10 }}>
              <div style={{ fontFamily: F.b, fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em", color: "#CCC", marginBottom: 4 }}>History</div>
              {myToks.map((t, i) => { const a = c.assignments.find(x => x.id === t.assignment_id) || (c.tokenGroups || {})[t.assignment_id]; return <div key={t.id} style={{ display: "flex", gap: 6, padding: "4px 0", borderBottom: i < myToks.length - 1 ? "1px solid #F5F3EF" : "none", fontFamily: F.b, fontSize: 11, color: "#777" }}><span style={{ color: "#CCC" }}>✦</span>{t.token_type === "revision" ? "Revision" : "Late"}: {a?.name || t.assignment_id}<span style={{ marginLeft: "auto", fontSize: 10, color: "#CCC" }}>{new Date(t.submitted_at).toLocaleDateString()}</span></div>; })}
            </div>}
          </div>}
        </div>
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
  const markAllInstr = async (aid, val) => {
    for (const s of students) { await upsertInstrStatus(s.id, ck, aid, val); }
    refresh();
  };

  const sorted = [...students].sort((a, b) => {
    if (sortBy === "first") return (a.first || "").localeCompare(b.first || "");
    if (sortBy === "last") return (a.last || "").localeCompare(b.last || "");
    const o = { A: 0, B: 1, C: 2, D: 3, F: 4, early: 5 };
    return (o[calcGrade(iS[a.id] || {}, rel, ck)] || 5) - (o[calcGrade(iS[b.id] || {}, rel, ck)] || 5);
  });

  const dist = { A: 0, B: 0, C: 0, D: 0, F: 0, early: 0 };
  students.forEach(s => { const g = calcGrade(iS[s.id] || {}, rel, ck); dist[g] = (dist[g] || 0) + 1; });

  const insights = rel.map(id => { const a = c.assignments.find(x => x.id === id); const rc = students.filter(s => (iS[s.id] || {})[id] === "revision").length; const mc = students.filter(s => (iS[s.id] || {})[id] === "mastery").length; return { ...a, rc, mc, ns: students.length - rc - mc }; }).filter(a => a.rc > 0).sort((a, b) => b.rc - a.rc);
  const cpSum = (c.classPrep || []).map(cp => ({ ...cp, done: students.filter(s => (cP[s.id] || {})[cp.id]).length }));

  const exportCSV = () => {
    const allA = c.assignments.filter(x => rel.includes(x.id)); const cpI = c.classPrep || [];
    const header = ["Last", "First", "Email", ...allA.map(x => x.name + " (Instr)"), ...allA.map(x => x.name + " (Student)"), ...cpI.map(x => x.name + " (Prep)"), "Tokens Used", "Tokens Avail", "Instr Track", "Student Track"].join(",");
    const rows = students.map(st => {
      const si = iS[st.id] || {}; const sc = sC[st.id] || {}; const cp2 = cP[st.id] || {}; const tk = (toks[st.id] || []).length;
      const ig = calcGrade(si, rel, ck); const sg = calcGrade(sc, rel, ck); const tok = tokBal(tk, 0);
      return [st.last, st.first, st.email, ...allA.map(x => si[x.id] === "mastery" ? "M" : si[x.id] === "revision" ? "R" : ""), ...allA.map(x => sc[x.id] ? "Y" : ""), ...cpI.map(x => cp2[x.id] ? "Y" : ""), tok.used, tok.avail, ig === "early" ? "" : ig, sg === "early" ? "" : sg].map(v => `"${v}"`).join(",");
    });
    const csvContent = header + "\n" + rows.join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" }); const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `${ck.replace(/\s/g, "_")}_${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
  };

  // BATCH GRADING VIEW
  if (batch) {
    const ba = c.assignments.find(x => x.id === batchAsgn);
    const bSorted = [...students].sort((a, b) => sortBy === "first" ? (a.first || "").localeCompare(b.first || "") : (a.last || "").localeCompare(b.last || ""));
    return (
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => setBatch(false)} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: F.b, fontSize: 12, color: "#888" }}>← Overview</button>
            <span style={{ fontFamily: F.b, fontSize: 13, fontWeight: 600, color: "#555" }}>Grade by Assignment</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ padding: "4px 8px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 10, background: "#fff" }}><option value="first">First</option><option value="last">Last</option></select>
            <select value={batchAsgn} onChange={e => setBatchAsgn(e.target.value)} style={{ padding: "5px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12, background: "#fff" }}>
              {rel.map(id => { const x = c.assignments.find(a => a.id === id); return <option key={id} value={id}>{x?.name || id}</option>; })}
            </select>
          </div>
        </div>
        {ba && <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontFamily: F.d, fontSize: 17, fontWeight: 600 }}>{ba.name}</span>
            {ba.eval === "mastery" ? <Pill t="Mastery" bg="#FFF0F0" c="#C0392B" /> : <Pill t="Completion" bg="#F0F8FF" c="#1565C0" />}
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <button onClick={() => markAllInstr(batchAsgn, "mastery")} style={{ padding: "6px 14px", background: "#D4EDDA", border: "1px solid #B7DFBF", borderRadius: 6, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#2D6A4F", cursor: "pointer" }}>{ba.eval === "completion" ? "Mark All Complete" : "Mark All Mastered"}</button>
            <button onClick={() => markAllInstr(batchAsgn, null)} style={{ padding: "6px 14px", background: "#F5F4F0", border: "1px solid #E8E6E1", borderRadius: 6, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#999", cursor: "pointer" }}>Reset All</button>
          </div>
          <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
            {bSorted.map((s, si) => {
              const st = (iS[s.id] || {})[batchAsgn] || ""; const note = (iN[s.id] || {})[batchAsgn]; const isEN = noteFor === s.id;
              const studentChecked = !!(sC[s.id] || {})[batchAsgn];
              const opts = ba.eval === "completion"
                ? [{ v: "mastery", l: "✓ Complete", bg: "#D4EDDA", c: "#2D6A4F" }, { v: "", l: "—", bg: "#F5F4F0", c: "#999" }]
                : [{ v: "mastery", l: "Mastered", bg: "#D4EDDA", c: "#2D6A4F" }, { v: "revision", l: "Revise", bg: "#FFF3CD", c: "#856404" }, { v: "", l: "—", bg: "#F5F4F0", c: "#999" }];
              return <div key={s.id} style={{ borderBottom: si < bSorted.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px" }}>
                  <div style={{ fontFamily: F.b, fontSize: 13, fontWeight: 500, width: 120, flexShrink: 0 }}>{sortBy === "last" ? `${s.last}, ${s.first}` : `${s.first} ${s.last}`}</div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {opts.map(o => <button key={o.v} onClick={() => handleInstrUpdate(s.id, batchAsgn, o.v || null)} style={{ padding: "5px 10px", borderRadius: 6, fontFamily: F.b, fontSize: 10, fontWeight: 600, cursor: "pointer", background: st === o.v ? o.bg : "#F8F7F4", color: st === o.v ? o.c : "#CCC", border: st === o.v ? `2px solid ${o.c}` : "1px solid #E8E6E1" }}>{o.l}</button>)}
                  </div>
                  <button onClick={() => { setNoteFor(isEN ? null : s.id); setNoteVal(note || ""); }} style={{ padding: "3px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 10, color: note ? "#856404" : "#CCC", cursor: "pointer", background: "#fff", flexShrink: 0 }}>{note ? "✎ Note" : "+ Note"}</button>
                  <div style={{ width: 60, flexShrink: 0, textAlign: "right" }}>
                    {studentChecked && <Pill t="Self ✓" bg="#E8F5E9" c="#2D6A4F" />}
                  </div>
                </div>
                {note && !isEN && <div style={{ padding: "2px 16px 6px 136px", fontFamily: F.b, fontSize: 10, color: "#666", fontStyle: "italic" }}>Note: {note}</div>}
                {isEN && <div style={{ padding: "4px 16px 8px 136px", display: "flex", gap: 6 }}>
                  <input value={noteVal} onChange={e => setNoteVal(e.target.value)} placeholder="Feedback note..." autoFocus style={{ flex: 1, padding: "5px 9px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 11, outline: "none" }} onKeyDown={e => { if (e.key === "Enter") { handleInstrNote(s.id, batchAsgn, noteVal); setNoteFor(null); } }} />
                  <button onClick={() => { handleInstrNote(s.id, batchAsgn, noteVal); setNoteFor(null); }} style={{ padding: "5px 10px", background: c.color, color: "#fff", border: "none", borderRadius: 5, fontFamily: F.b, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Save</button>
                </div>}
              </div>;
            })}
          </div>
        </div>}
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
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => setPrepView(false)} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: F.b, fontSize: 12, color: "#888" }}>← Overview</button>
            <span style={{ fontFamily: F.b, fontSize: 13, fontWeight: 600, color: "#555" }}>Track Class Prep</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ padding: "4px 8px", border: "1px solid #E0DDD8", borderRadius: 5, fontFamily: F.b, fontSize: 10, background: "#fff" }}><option value="first">First</option><option value="last">Last</option></select>
            <select value={prepItem} onChange={e => setPrepItem(e.target.value)} style={{ padding: "5px 10px", border: "1px solid #E0DDD8", borderRadius: 6, fontFamily: F.b, fontSize: 12, background: "#fff" }}>
              {cpItems.map(cp => <option key={cp.id} value={cp.id}>{cp.name}</option>)}
            </select>
          </div>
        </div>
        {currentPrep && <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontFamily: F.d, fontSize: 17, fontWeight: 600 }}>{currentPrep.name}</span>
            <Pill t={`${doneCount} of ${students.length}`} bg={doneCount === students.length ? "#D4EDDA" : "#F5F4F0"} c={doneCount === students.length ? "#2D6A4F" : "#999"} />
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <button onClick={() => markAllPrep(true)} style={{ padding: "6px 14px", background: "#D4EDDA", border: "1px solid #B7DFBF", borderRadius: 6, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#2D6A4F", cursor: "pointer" }}>Mark All Complete</button>
            <button onClick={() => markAllPrep(false)} style={{ padding: "6px 14px", background: "#F5F4F0", border: "1px solid #E8E6E1", borderRadius: 6, fontFamily: F.b, fontSize: 11, fontWeight: 600, color: "#999", cursor: "pointer" }}>Reset All</button>
          </div>
          <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
            {pSorted.map((s, si) => {
              const done = !!(cP[s.id] || {})[prepItem];
              return <div key={s.id} onClick={async () => { await toggleClassPrep(s.id, ck, prepItem); refresh(); }}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", borderBottom: si < pSorted.length - 1 ? "1px solid #F5F3EF" : "none", cursor: "pointer" }}
                onMouseEnter={e => e.currentTarget.style.background = "#FAFAF7"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <div style={{ width: 22, height: 22, borderRadius: 6, border: done ? "none" : "2px solid #D0CEC9", background: done ? "#2D6A4F" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {done && <span style={{ color: "#fff", fontSize: 13, fontWeight: 700 }}>✓</span>}
                </div>
                <span style={{ fontFamily: F.b, fontSize: 13, fontWeight: 500, color: done ? "#999" : "#1A1A1A" }}>{sortBy === "last" ? `${s.last}, ${s.first}` : `${s.first} ${s.last}`}</span>
              </div>;
            })}
          </div>
        </div>}
      </div>
    );
  }

  // MAIN INSTRUCTOR VIEW
  return (
    <div>
      <div style={{ borderBottom: "1px solid #E8E6E1", background: "#fff", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: 1000, margin: "0 auto", padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={handleLogout} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: F.b, fontSize: 12, color: "#888" }}>← Sign out</button>
            <div style={{ width: 1, height: 14, background: "#E0DDD8" }} />
            <select value={ck} onChange={e => setCk(e.target.value)} style={{ fontFamily: F.d, fontSize: 14, fontWeight: 600, border: "none", background: "none", cursor: "pointer", outline: "none" }}>{user.courses.map(k => <option key={k} value={k}>{COURSES[k]?.short || k}</option>)}</select>
            <span style={{ fontFamily: F.b, fontSize: 10, color: "#999" }}>{students.length} students</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {pending.length > 0 && tab !== "queue" && <button onClick={() => setTab("queue")} style={{ padding: "3px 10px", background: "#FFF3CD", border: "1px solid #FFECB5", borderRadius: 5, fontFamily: F.b, fontSize: 10, fontWeight: 600, color: "#856404", cursor: "pointer" }}>{pending.length} token{pending.length !== 1 ? "s" : ""}</button>}
            <button onClick={() => { setBatch(true); setBatchAsgn(rel[0] || ""); }} style={{ padding: "5px 12px", background: c.color, color: "#fff", border: "none", borderRadius: 6, fontFamily: F.b, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Grade by Assignment</button>
            <button onClick={() => { setPrepView(true); setPrepItem((c.classPrep || [])[0]?.id || ""); }} style={{ padding: "5px 12px", background: "#fff", color: c.color, border: `1px solid ${c.color}`, borderRadius: 6, fontFamily: F.b, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Track Class Prep</button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "18px 20px" }}>
        <div style={{ display: "flex", gap: 0, marginBottom: 18, borderBottom: "2px solid #F0EEEA" }}>
          {[{ k: "overview", l: "Overview" }, { k: "manage", l: "Manage" }, { k: "queue", l: `Tokens${pending.length ? ` (${pending.length})` : ""}` }, { k: "tracks", l: "Tracks" }].map(t => <button key={t.k} onClick={() => setTab(t.k)} style={{ padding: "8px 14px", border: "none", cursor: "pointer", fontFamily: F.b, fontSize: 12, fontWeight: 600, color: tab === t.k ? c.color : "#999", background: "none", borderBottom: tab === t.k ? `2px solid ${c.color}` : "2px solid transparent", marginBottom: -2 }}>{t.l}</button>)}
        </div>

        {/* OVERVIEW */}
        {tab === "overview" && <div>
          <div style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap" }}>
            {["A", "B", "C", "D", "F"].map(g => <div key={g} style={{ flex: 1, minWidth: 55, background: TM[g].bg, borderRadius: 8, padding: "10px", textAlign: "center" }}>
              <div style={{ fontSize: 20, fontWeight: 700, fontFamily: F.d, color: TM[g].c }}>{dist[g] || 0}</div>
              <div style={{ fontFamily: F.b, fontSize: 9, fontWeight: 600, color: TM[g].c, opacity: .7 }}>{g}</div>
            </div>)}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
            <Lbl s={{ marginBottom: 0 }}>Students (Your Records)</Lbl>
            <div style={{ display: "flex", gap: 4 }}>
              <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ padding: "2px 6px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 10, color: "#666", background: "#fff", cursor: "pointer" }}><option value="first">First</option><option value="last">Last</option><option value="grade">Track</option></select>
              <button onClick={exportCSV} style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 10, color: "#666", background: "#fff", cursor: "pointer" }}>📥 CSV</button>
              <button onClick={refresh} style={{ padding: "2px 8px", border: "1px solid #E0DDD8", borderRadius: 4, fontFamily: F.b, fontSize: 10, color: "#666", background: "#fff", cursor: "pointer" }}>↻ Refresh</button>
            </div>
          </div>

          <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 16px", borderBottom: "2px solid #F0EEEA", background: "#FAFAF7" }}>
              <div style={{ width: 24 }} />
              <div style={{ width: 120, fontFamily: F.b, fontSize: 8, fontWeight: 600, color: "#CCC" }}>Student</div>
              <div style={{ flex: 1, display: "flex", gap: 2 }}>{rel.map(id => { const x = c.assignments.find(a => a.id === id); return <div key={id} style={{ flex: 1, minWidth: 12, maxWidth: 22, fontFamily: F.b, fontSize: 6, fontWeight: 600, color: "#CCC", textAlign: "center", overflow: "hidden" }} title={x?.name}>{(x?.name || "").substring(0, 4)}</div>; })}</div>
              <div style={{ width: 50, fontFamily: F.b, fontSize: 8, fontWeight: 600, color: "#CCC", textAlign: "right" }}>Self</div>
            </div>
            {sorted.map((s, si) => {
              const ig = calcGrade(iS[s.id] || {}, rel, ck); const sg = calcGrade(sC[s.id] || {}, rel, ck);
              const m = TM[ig] || TM.F; const mm = ig !== sg && ig !== "early" && sg !== "early";
              return <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 16px", borderBottom: si < sorted.length - 1 ? "1px solid #F5F3EF" : "none", background: mm ? "#FFF8F0" : "transparent" }}>
                <div style={{ width: 22, height: 22, borderRadius: "50%", background: m.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.d, fontSize: 10, fontWeight: 700, color: m.c, flexShrink: 0 }}>{ig === "early" ? "—" : ig}</div>
                <div style={{ width: 120, flexShrink: 0, fontFamily: F.b, fontSize: 12, fontWeight: 500, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sortBy === "last" ? `${s.last}, ${s.first}` : s.name}</div>
                <div style={{ flex: 1, display: "flex", gap: 2 }}>
                  {rel.map(id => { const st = (iS[s.id] || {})[id] || "";
                    return <div key={id} title={c.assignments.find(a => a.id === id)?.name} style={{ flex: 1, minWidth: 12, maxWidth: 22, height: 16, borderRadius: 3, background: st === "mastery" ? "#D4EDDA" : st === "revision" ? "#FFF3CD" : "#F5F4F0", border: !st ? "1.5px dashed #E8E6E1" : "1.5px solid transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 6, fontWeight: 700, color: st === "mastery" ? "#2D6A4F" : st === "revision" ? "#856404" : "transparent" }}>{st === "mastery" ? "M" : st === "revision" ? "R" : ""}</div>;
                  })}
                </div>
                <div style={{ width: 50, textAlign: "right", fontFamily: F.b, fontSize: 9, color: mm ? "#E65100" : "#CCC" }}>{sg === "early" ? "—" : sg}{mm ? " ⚠" : ""}</div>
              </div>;
            })}
          </div>
          <div style={{ fontFamily: F.b, fontSize: 10, color: "#BBB", marginTop: 8 }}>"Self" = student self-reported track. ⚠ = mismatch.</div>

          {insights.length > 0 && <div style={{ marginTop: 20 }}>
            <Lbl s={{ marginBottom: 8 }}>Where Students Are Struggling</Lbl>
            <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
              {insights.map((a, i) => <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: i < insights.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                <div style={{ width: 28, height: 28, borderRadius: 7, background: "#FFF3CD", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.b, fontSize: 12, fontWeight: 700, color: "#856404", flexShrink: 0 }}>{a.rc}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 500 }}>{a.name}</div>
                  <div style={{ fontFamily: F.b, fontSize: 10, color: "#999" }}>{a.rc}R · {a.mc}M · {a.ns} no status</div>
                </div>
              </div>)}
            </div>
          </div>}

          <div style={{ marginTop: 20 }}>
            <Lbl s={{ marginBottom: 8 }}>Class Preparation Completion</Lbl>
            <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
              {cpSum.map((cp, i) => <div key={cp.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: i < cpSum.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                <div style={{ width: 28, height: 28, borderRadius: 7, background: cp.done === students.length ? "#D4EDDA" : "#F5F4F0", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.b, fontSize: 12, fontWeight: 700, color: cp.done === students.length ? "#2D6A4F" : "#999", flexShrink: 0 }}>{cp.done}</div>
                <div style={{ flex: 1 }}><div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 500 }}>{cp.name}</div><div style={{ fontFamily: F.b, fontSize: 10, color: "#999" }}>{cp.done} of {students.length}</div></div>
              </div>)}
            </div>
          </div>
        </div>}

        {/* MANAGE */}
        {tab === "manage" && <div>
          <Lbl>Assignments — click to release/unrelease</Lbl>
          {c.groups.map((grp, gi) => <div key={gi} style={{ marginBottom: 14 }}>
            {grp.name && <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600, color: c.color, marginBottom: 4 }}>{grp.name}</div>}
            <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
              {grp.ids.map((id, i) => { const a = c.assignments.find(x => x.id === id); if (!a) return null; const isR = rel.includes(id);
                return <div key={id} onClick={() => handleToggleRel(id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: i < grp.ids.length - 1 ? "1px solid #F5F3EF" : "none", cursor: "pointer" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#FAFAF7"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <div style={{ width: 34, height: 18, borderRadius: 9, background: isR ? c.color : "#E0DDD8", position: "relative", transition: "background .3s", flexShrink: 0 }}><div style={{ width: 12, height: 12, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: isR ? 19 : 3, transition: "left .3s", boxShadow: "0 1px 2px rgba(0,0,0,.15)" }} /></div>
                  <div style={{ flex: 1 }}><div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 500 }}>{a.name}</div></div>
                  {a.eval === "mastery" ? <Pill t="Mastery" bg="#FFF0F0" c="#C0392B" /> : <Pill t="Completion" bg="#F0F8FF" c="#1565C0" />}
                </div>;
              })}
            </div>
          </div>)}
        </div>}
        {tab === "queue" && <div>
          <div style={{ fontFamily: F.b, fontSize: 11, color: "#777", lineHeight: 1.5, marginBottom: 14, padding: "8px 12px", background: "#F9F8F5", borderRadius: 8 }}>
            Students submit tokens for revisions or late work. Review in Brightspace, then update here.
          </div>
          {pending.length === 0 && <div style={{ background: "#D4EDDA", borderRadius: 10, padding: "24px", textAlign: "center", marginBottom: 16 }}><div style={{ fontSize: 22, marginBottom: 4 }}>✓</div><div style={{ fontFamily: F.b, fontSize: 13, fontWeight: 600, color: "#2D6A4F" }}>All caught up!</div></div>}
          <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
            {fq.map((item, i) => {
              const a = c.assignments.find(x => x.id === item.assignment_id) || (c.tokenGroups || {})[item.assignment_id];
              return <div key={item.id} style={{ padding: "12px 16px", borderBottom: i < fq.length - 1 ? "1px solid #F5F3EF" : "none", opacity: item.resolved ? .6 : 1, background: item.resolved ? "#FAFAF7" : "transparent" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: item.resolved ? 0 : 8 }}>
                  <div style={{ width: 26, height: 26, borderRadius: 6, background: item.token_type === "late" ? "#F3E8FF" : "#FFF3CD", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 }}>{item.token_type === "late" ? "📥" : "↻"}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 500 }}><strong>{item.sName}</strong> — {a?.name || item.assignment_id}</div>
                    <div style={{ fontFamily: F.b, fontSize: 10, color: "#999" }}>{item.token_type === "late" ? "Late submission" : "Revision"} · {new Date(item.submitted_at).toLocaleDateString()}{item.note ? ` · "${item.note}"` : ""}</div>
                  </div>
                  {item.resolved && <Pill t={`→ ${item.resolution}`} bg={item.resolution === "M" ? "#D4EDDA" : "#FFF3CD"} c={item.resolution === "M" ? "#2D6A4F" : "#856404"} />}
                </div>
                {!item.resolved && <div style={{ display: "flex", gap: 6, marginLeft: 36 }}>
                  <button onClick={() => handleResolve(item.id, item.profile_id, item.assignment_id, "M")} style={{ padding: "6px 14px", background: "#2D6A4F", color: "#fff", border: "none", borderRadius: 5, cursor: "pointer", fontFamily: F.b, fontSize: 11, fontWeight: 600 }}>Reviewed → Mastered</button>
                  <button onClick={() => handleResolve(item.id, item.profile_id, item.assignment_id, "R")} style={{ padding: "6px 14px", background: "#fff", color: "#856404", border: "1px solid #FFECB5", borderRadius: 5, cursor: "pointer", fontFamily: F.b, fontSize: 11, fontWeight: 600 }}>Reviewed → Still Needs Revision</button>
                </div>}
              </div>;
            })}
            {fq.length === 0 && <div style={{ padding: "18px", textAlign: "center", fontFamily: F.b, fontSize: 11, color: "#CCC" }}>No submissions yet.</div>}
          </div>
        </div>}

        {/* TRACKS */}
        {tab === "tracks" && <div>
          <div style={{ fontFamily: F.b, fontSize: 11, color: "#888", marginBottom: 14 }}>Based on <strong>your</strong> records.</div>
          {["A", "B", "C", "D"].map(g => { const t = c.tracks[g]; const m = TM[g]; const on = students.filter(s => calcGrade(iS[s.id] || {}, rel, ck) === g);
            return <div key={g} style={{ marginBottom: 12, background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid #F0EEEA" }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: m.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.d, fontSize: 14, fontWeight: 700, color: m.c }}>{g}</div>
                <div style={{ flex: 1 }}><div style={{ fontFamily: F.b, fontSize: 12, fontWeight: 600 }}>{g} Track — {on.length}</div><div style={{ fontFamily: F.b, fontSize: 9, color: "#999" }}>{t.req.map(id => c.assignments.find(a => a.id === id)?.name).join(", ")}</div></div>
              </div>
              <div style={{ padding: "6px 16px 10px" }}>{on.length === 0 ? <div style={{ fontFamily: F.b, fontSize: 10, color: "#CCC" }}>None</div> :
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>{on.map(s => <span key={s.id} style={{ padding: "2px 8px", background: m.bg, borderRadius: 4, fontFamily: F.b, fontSize: 10, fontWeight: 500, color: m.c }}>{s.name}</span>)}</div>}</div>
            </div>;
          })}
          <div style={{ marginTop: 16 }}>
            <Lbl s={{ marginBottom: 8 }}>Final Grades Summary</Lbl>
            <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E6E1", overflow: "hidden" }}>
              {[...students].sort((a, b) => (a.last || "").localeCompare(b.last || "")).map((s, i) => {
                const g = calcGrade(iS[s.id] || {}, rel, ck); const m = TM[g] || TM.F;
                return <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px", borderBottom: i < students.length - 1 ? "1px solid #F5F3EF" : "none" }}>
                  <div style={{ width: 26, height: 26, borderRadius: "50%", background: m.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.d, fontSize: 12, fontWeight: 700, color: m.c }}>{g === "early" ? "—" : g}</div>
                  <div style={{ fontFamily: F.b, fontSize: 13, fontWeight: 500 }}>{s.last}, {s.first}</div>
                </div>;
              })}
            </div>
          </div>
        </div>}
      </div>
    </div>
  );
}
