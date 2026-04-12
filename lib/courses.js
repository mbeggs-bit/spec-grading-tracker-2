export const CAL_LINK = "https://calendar.app.google/d5PqvvcTyP7KiHsu9";

// UCM School Colors
export const BRAND = { primary: "#CF202E", light: "#FCDEDE", calBg: "#FFF5F5", calBorder: "#F5B7B7" };

export const TM = {
  A: { c: "#2D6A4F", bg: "#D4EDDA" }, B: { c: "#1565C0", bg: "#DCEEFB" },
  C: { c: "#E65100", bg: "#FFF3E0" }, D: { c: "#856404", bg: "#FFF8E1" },
  F: { c: "#999", bg: "#F5F4F0" }, early: { c: "#6B7280", bg: "#F3F4F6" }
};

export const COURSES = {
  "ECEL 3820": {
    title: "ECEL 3820: Math for the Intermediate Learner",
    short: "Math for the Intermediate Learner",
    color: "#2D6A4F", colorLight: "#D4EDDA",
    archived: false,
    tokenCutoff: "April 26, 2026", tokenCutoffDate: new Date("2026-04-26T23:59:59"),
    groups: [{ name: null, ids: ["3act","lesson","vtm1","vtm2","vtm3","frac-int","frac-act","thinking","portfolio"] }],
    assignments: [
      { id: "3act", name: "3 Act Adventure", eval: "mastery" },
      { id: "lesson", name: "Lesson Plan", eval: "mastery" },
      { id: "vtm1", name: "Video Teaching Moment 1", eval: "mastery" },
      { id: "vtm2", name: "Video Teaching Moment 2", eval: "mastery" },
      { id: "vtm3", name: "Video Teaching Moment 3", eval: "mastery" },
      { id: "frac-int", name: "Fraction Interview", eval: "completion" },
      { id: "frac-act", name: "Fraction Activity", eval: "completion" },
      { id: "thinking", name: "Thinking Blocks", eval: "completion" },
      { id: "portfolio", name: "Final Portfolio", eval: "completion" },
    ],
    tokenGroups: {},
    classPrep: [
      { id: "cp-smp", name: "Standards of Math Practice" },
      { id: "cp-mult", name: "Multiplication" },
      { id: "cp-div", name: "Division" },
      { id: "cp-frac", name: "Fraction" },
      { id: "cp-fracmult", name: "Fraction Multiplication" },
      { id: "cp-fracdiv", name: "Fraction Division" },
      { id: "cp-lpdraft", name: "Lesson Plan Draft" },
      { id: "cp-vtm1-draft", name: "VTM 1 Draft" },
      { id: "cp-vtm1-fb", name: "VTM 1 Peer Feedback" },
      { id: "cp-vtm2-draft", name: "VTM 2 Draft" },
      { id: "cp-vtm2-fb", name: "VTM 2 Peer Feedback" },
      { id: "cp-vtm3-draft", name: "VTM 3 Draft" },
      { id: "cp-vtm3-fb", name: "VTM 3 Peer Feedback" },
    ],
    bonus: [{ id: "b3820-1", name: "Math Read-Aloud Review" }, { id: "b3820-2", name: "Peer Teaching Observation" }],
    tracks: {
      A: { req: ["3act","lesson","frac-int","frac-act","thinking","portfolio"], pick: [{ from: ["vtm1","vtm2","vtm3"], need: 3, label: "VTMs" }] },
      B: { req: ["3act","lesson","frac-int","frac-act","portfolio"], pick: [{ from: ["vtm1","vtm2","vtm3"], need: 2, label: "VTMs" }] },
      C: { req: ["3act","lesson","frac-int","portfolio"], pick: [{ from: ["vtm1","vtm2","vtm3"], need: 1, label: "VTMs" }] },
      D: { req: ["3act"], alt: ["lesson"], isOr: true },
    },
  },
  "ECEL 4850": {
    title: "ECEL 4850: Math Curriculum & Assessment",
    short: "Math Curriculum & Assessment",
    color: "#CF202E", colorLight: "#FCDEDE",
    archived: false,
    tokenCutoff: "April 26, 2026", tokenCutoffDate: new Date("2026-04-26T23:59:59"),
    groups: [
      { name: null, ids: ["les1","les2","ct1","ct2"] },
      { name: "Number Talks", ids: ["nt-plan","nt-impl"] },
      { name: "Planning with Assessment", ids: ["pwa-chart","pwa-a1","pwa-a2","pwa-a3","pwa-followup"], tokenGroup: "pwa" },
      { name: "Final Portfolio", ids: ["fp-w1","fp-w2","fp-w3"] },
    ],
    assignments: [
      { id: "les1", name: "LES Lesson Plan 1", eval: "mastery" },
      { id: "les2", name: "LES Lesson Plan 2", eval: "mastery" },
      { id: "ct1", name: "CT Feedback & Reflection 1", eval: "completion" },
      { id: "ct2", name: "CT Feedback & Reflection 2", eval: "completion" },
      { id: "nt-plan", name: "Number Talk Planning", eval: "mastery" },
      { id: "nt-impl", name: "Number Talk Implementation", eval: "completion" },
      { id: "pwa-chart", name: "Data Chart", eval: "mastery", tokenGroup: "pwa" },
      { id: "pwa-a1", name: "Individual Analysis 1", eval: "mastery", tokenGroup: "pwa" },
      { id: "pwa-a2", name: "Individual Analysis 2", eval: "mastery", tokenGroup: "pwa" },
      { id: "pwa-a3", name: "Individual Analysis 3", eval: "mastery", tokenGroup: "pwa" },
      { id: "pwa-followup", name: "Follow-Up Lesson Outline", eval: "mastery", tokenGroup: "pwa" },
      { id: "fp-w1", name: "Warm Up 1", eval: "completion" },
      { id: "fp-w2", name: "Warm Up 2", eval: "completion" },
      { id: "fp-w3", name: "Warm Up 3", eval: "completion" },
    ],
    tokenGroups: { pwa: { name: "Planning with Assessment (Project)", ids: ["pwa-chart","pwa-a1","pwa-a2","pwa-a3","pwa-followup"] } },
    classPrep: [
      { id: "cp-mtp", name: "Math Teaching Practices" },
      { id: "cp-les", name: "Launch, Explore, Summarize" },
      { id: "cp-ca", name: "Concept Attainment" },
      { id: "cp-fb", name: "Fluency Beliefs" },
      { id: "cp-q", name: "Questioning" },
    ],
    sections: {
      LS: { name: "Lee's Summit", code: "MATH4850LS" },
      WB: { name: "Warrensburg", code: "MATH4850WB" },
    },
    bonus: [{ id: "b4850-1", name: "Additional Classroom Observation" }],
    tracks: {
      A: { req: ["les1","les2","ct1","ct2","nt-plan","nt-impl","pwa-chart","pwa-a1","pwa-a2","pwa-a3","pwa-followup"], pick: [{ from: ["fp-w1","fp-w2","fp-w3"], need: 3, label: "warm ups" }] },
      B: { req: ["les1","les2","ct1","ct2","nt-plan","pwa-chart"], pick: [{ from: ["pwa-a1","pwa-a2","pwa-a3"], need: 2, label: "analyses" }, { from: ["fp-w1","fp-w2","fp-w3"], need: 2, label: "warm ups" }] },
      C: { req: ["pwa-chart"], pick: [{ from: ["les1","les2"], need: 1, label: "lesson plans" }, { from: ["ct1","ct2"], need: 1, label: "reflections" }, { from: ["pwa-a1","pwa-a2","pwa-a3"], need: 1, label: "analyses" }, { from: ["fp-w1","fp-w2","fp-w3"], need: 1, label: "warm ups" }] },
      D: { req: [], pick: [{ from: ["les1","les2"], need: 1, label: "lesson plans" }, { from: ["ct1","ct2"], need: 1, label: "reflections" }, { from: ["fp-w1","fp-w2","fp-w3"], need: 1, label: "warm ups" }] },
    },
  },
  "ECEL 3468": {
    title: "ECEL 3468: School, Community & Family Connections",
    short: "School, Community & Family",
    color: "#CF202E", colorLight: "#FCDEDE",
    archived: false,
    tokenCutoff: "July 9, 2026", tokenCutoffDate: new Date("2026-07-09T23:59:59"),
    groups: [
      { name: "Bundles", ids: ["b1","b2","b3","b4","b5"] },
      { name: "Journals", ids: ["j1","j2","j3","j4"] },
      { name: "AI Scenarios", ids: ["ai1","ai2"] },
      { name: "Special Project", ids: ["sp"] },
    ],
    assignments: [
      { id: "b1", name: "Bundle 1: Understanding the Families We Serve", eval: "completion" },
      { id: "b2", name: "Bundle 2: Building Bridges Through Communication", eval: "completion" },
      { id: "b3", name: "Bundle 3: Seeing the Whole Picture", eval: "completion" },
      { id: "b4", name: "Bundle 4: Protecting and Supporting Every Child", eval: "completion" },
      { id: "b5", name: "Bundle 5: Putting It Into Practice", eval: "completion" },
      { id: "j1", name: "Journal 1: Applying Family Systems", eval: "mastery" },
      { id: "j2", name: "Journal 2: Food Insecurities", eval: "mastery" },
      { id: "j3", name: "Journal 3: Adverse Childhood Experiences (ACE)", eval: "mastery" },
      { id: "j4", name: "Journal 4: Teaching Connections & Community Resources", eval: "mastery" },
      { id: "ai1", name: "AI Scenario 1: Email Communication with Parents", eval: "completion" },
      { id: "ai2", name: "AI Scenario 2: Email Communication with Colleagues", eval: "completion" },
      { id: "sp", name: "Special Project", eval: "mastery" },
    ],
    tokenGroups: {},
    classPrep: [],
    bonus: [],
    tracks: {
      A: { req: ["b1","b2","b3","b4","b5","j1","j2","j3","j4","ai1","ai2","sp"] },
      B: { req: ["b1","b2","b3","b4","b5","j1","j2","j3","j4","ai1"] },
      C: { req: ["b1","b2","b3","b4","j1","j2","j3"] },
      D: { req: ["b1","b2","b3","j1","j2"] },
    },
  },
};

/* ================================================================
   SHARED HELPER — checks pick and pickGroup requirements against
   a set of available IDs and a set of confirmed/done IDs
   ================================================================ */
function checkTrackRequirements(track, availableIds, doneIds) {
  // Check fixed requirements — only grade-relevant ones
  const rv = track.req.filter(id => availableIds.includes(id));
  const reqMet = rv.every(id => doneIds.has(id));
  
  // Check pick requirements (any X from pool)
  // If no items from a pool are grade-relevant, skip it (not yet applicable)
  const pickMet = (track.pick || []).every(p => {
    const available = p.from.filter(id => availableIds.includes(id));
    if (available.length === 0) return true; // not yet applicable
    const completed = available.filter(id => doneIds.has(id));
    return completed.length >= p.need;
  });
  
  // Check pickGroup requirements (any X complete groups)
  // If no groups have any available items, skip it (not yet applicable)
  const pickGroupMet = (track.pickGroup || []).every(pg => {
    const anyAvailable = pg.from.some(group => group.some(id => availableIds.includes(id)));
    if (!anyAvailable) return true; // not yet applicable
    let groupsCompleted = 0;
    for (const group of pg.from) {
      const groupAvailable = group.filter(id => availableIds.includes(id));
      if (groupAvailable.length > 0 && groupAvailable.every(id => doneIds.has(id))) {
        groupsCompleted++;
      }
    }
    return groupsCompleted >= pg.need;
  });
  
  return reqMet && pickMet && pickGroupMet;
}

// Check if a track has any relevant items at all
function trackHasRelevantItems(track, availableIds) {
  const hasReq = track.req.some(id => availableIds.includes(id));
  const hasPick = (track.pick || []).some(p => p.from.some(id => availableIds.includes(id)));
  const hasPickGroup = (track.pickGroup || []).some(pg => pg.from.some(group => group.some(id => availableIds.includes(id))));
  return hasReq || hasPick || hasPickGroup;
}

/* ================================================================
   GRADE CALCULATION — INSTRUCTOR VIEW
   Uses instructor statuses only. This is what the instructor sees.
   ================================================================ */
export function calcGrade(checked, relIds, ck) {
  const c = COURSES[ck];
  const done = new Set(Object.keys(checked).filter(k => checked[k] === true || checked[k] === "mastery"));
  if (done.size === 0 && relIds.length < 2) return "early";
  if (done.size === 0 && relIds.length >= 2) return "F";
  for (const g of ["A", "B", "C", "D"]) {
    const t = c.tracks[g];
    if (!trackHasRelevantItems(t, relIds)) continue;
    if (g === "D" && t.isOr) {
      const mOk = t.req.filter(id => relIds.includes(id)).every(id => done.has(id));
      const aOk = (t.alt || []).filter(id => relIds.includes(id)).every(id => done.has(id));
      if ((t.req.some(id => relIds.includes(id)) && mOk) || (t.alt && t.alt.some(id => relIds.includes(id)) && aOk)) return g;
    } else {
      if (checkTrackRequirements(t, relIds, done)) return g;
    }
  }
  return "F";
}

/* ================================================================
   GRADE CALCULATION — STUDENT VIEW (dual-gate logic)
   
   An assignment counts toward the student's displayed grade when:
   - Completion items with a due date set: in the calc, done when
     student checks off. No due date = invisible to grade calc.
     (Student can still check off early and it counts as done.)
   - Mastery items, instructor marked M: in the calc, counts as done
     ONLY when student has also checked it off
   - Mastery items, instructor marked R: in the calc, counts as NOT
     done (student needs to revise, get M, then check off)
   - Mastery items, no instructor status: invisible to grade calc
     (protects against grade drops when new assignments are released)
   ================================================================ */
export function calcStudentGrade(studentChecks, instrStatuses, relIds, ck, dueDates = {}) {
  const c = COURSES[ck];
  
  // Build the set of assignments that "count" for grade calculation
  const confirmed = new Set();
  const gradeRelevant = new Set();
  
  for (const id of relIds) {
    const a = c.assignments.find(x => x.id === id);
    if (!a) continue;
    
    const studentChecked = studentChecks[id] === true || studentChecks[id] === "mastery";
    const instrStatus = instrStatuses[id]; // "mastery", "revision", or undefined
    
    if (a.eval === "completion") {
      // Completion items: enter calc when due date has passed OR student checked off early
      const hasDueDate = !!(dueDates[id]?.date);
      const dueDatePassed = hasDueDate && new Date(dueDates[id].date + 'T23:59:59') < new Date();
      if (dueDatePassed || studentChecked) {
        gradeRelevant.add(id);
        if (studentChecked) confirmed.add(id);
      }
    } else {
      // Mastery items: enter calc once instructor has evaluated (M or R)
      // Unevaluated mastery items stay invisible — no penalty for new releases
      if (instrStatus === "mastery" || instrStatus === "revision") {
        gradeRelevant.add(id);
        // Only counts as done when instructor marked M AND student checked off
        if (instrStatus === "mastery" && studentChecked) {
          confirmed.add(id);
        }
        // If instrStatus === "revision", it's in the calc but NOT confirmed
        // — actively counts against the student's grade
      }
    }
  }
  
  // If nothing is grade-relevant yet, it's early
  if (gradeRelevant.size === 0) return "early";
  // If nothing is confirmed but some things are relevant, check if it's truly early
  if (confirmed.size === 0 && gradeRelevant.size < 2) return "early";
  if (confirmed.size === 0) return "F";
  
  // Now calculate grade using only grade-relevant assignments
  const gradeRelIds = [...gradeRelevant];
  for (const g of ["A", "B", "C", "D"]) {
    const t = c.tracks[g];
    if (!trackHasRelevantItems(t, gradeRelIds)) continue;
    if (g === "D" && t.isOr) {
      const mOk = t.req.filter(id => gradeRelIds.includes(id)).every(id => confirmed.has(id));
      const aOk = (t.alt || []).filter(id => gradeRelIds.includes(id)).every(id => confirmed.has(id));
      if ((t.req.some(id => gradeRelIds.includes(id)) && mOk) || (t.alt && t.alt.some(id => gradeRelIds.includes(id)) && aOk)) return g;
    } else {
      if (checkTrackRequirements(t, gradeRelIds, confirmed)) return g;
    }
  }
  return "F";
}

/* ================================================================
   BLOCKERS — STUDENT VIEW (dual-gate)
   ================================================================ */
export function getStudentBlockers(studentChecks, instrStatuses, relIds, ck, dueDates = {}) {
  const grade = calcStudentGrade(studentChecks, instrStatuses, relIds, ck, dueDates);
  if (grade === "early") return { target: null, blockers: [], msg: "Check off your first assignment to see your grade track!" };
  const c = COURSES[ck];
  const order = ["A", "B", "C", "D", "F"];
  const idx = order.indexOf(grade);
  const target = idx > 0 ? order[idx - 1] : null;
  if (!target) return { target: null, blockers: [], msg: grade === "A" ? "You're on the highest track!" : "" };
  const t = c.tracks[target];
  if (!t) return { target, blockers: [], msg: "" };
  
  // A blocker is an assignment in the target track that isn't fully confirmed
  // Only include items that are grade-relevant (mastery with eval, or completion with due date/checked)
  const confirmed = new Set();
  const gradeRelevant = new Set();
  for (const id of relIds) {
    const a = c.assignments.find(x => x.id === id);
    if (!a) continue;
    const studentChecked = studentChecks[id] === true || studentChecks[id] === "mastery";
    if (a.eval === "completion") {
      const hasDueDate = !!(dueDates[id]?.date);
      const dueDatePassed = hasDueDate && new Date(dueDates[id].date + 'T23:59:59') < new Date();
      if (dueDatePassed || studentChecked) {
        gradeRelevant.add(id);
        if (studentChecked) confirmed.add(id);
      }
    } else {
      const instrStatus = instrStatuses[id];
      if (instrStatus === "mastery" || instrStatus === "revision") {
        gradeRelevant.add(id);
        if (instrStatus === "mastery" && studentChecked) confirmed.add(id);
      }
    }
  }
  
  const gradeRelIds = [...gradeRelevant];
  const blockers = t.req.filter(id => gradeRelIds.includes(id) && !confirmed.has(id));
  // Add pick items that still need completing (only grade-relevant ones)
  (t.pick || []).forEach(p => {
    const available = p.from.filter(id => gradeRelIds.includes(id));
    const completed = available.filter(id => confirmed.has(id));
    const remaining = p.need - completed.length;
    if (remaining > 0) {
      available.filter(id => !confirmed.has(id)).slice(0, remaining).forEach(id => { if (!blockers.includes(id)) blockers.push(id); });
    }
  });
  // Add pickGroup items that still need completing (only grade-relevant ones)
  (t.pickGroup || []).forEach(pg => {
    let groupsCompleted = 0;
    for (const group of pg.from) {
      const groupAvailable = group.filter(id => gradeRelIds.includes(id));
      if (groupAvailable.length > 0 && groupAvailable.every(id => confirmed.has(id))) groupsCompleted++;
    }
    const remaining = pg.need - groupsCompleted;
    if (remaining > 0) {
      for (const group of pg.from) {
        const groupAvailable = group.filter(id => gradeRelIds.includes(id));
        const groupDone = groupAvailable.every(id => confirmed.has(id));
        if (!groupDone) {
          groupAvailable.filter(id => !confirmed.has(id)).forEach(id => { if (!blockers.includes(id)) blockers.push(id); });
          break;
        }
      }
    }
  });
  return { target, blockers, msg: blockers.length === 0 ? `Remaining ${target}-track items haven't been assigned yet.` : `${blockers.length} more to reach ${target} track` };
}
export function getBlockers(checked, relIds, ck) {
  const grade = calcGrade(checked, relIds, ck);
  if (grade === "early") return { target: null, blockers: [], msg: "Check off your first assignment to see your grade track!" };
  const order = ["A", "B", "C", "D", "F"];
  const idx = order.indexOf(grade);
  const target = idx > 0 ? order[idx - 1] : null;
  if (!target) return { target: null, blockers: [], msg: grade === "A" ? "You're on the highest track!" : "" };
  const t = COURSES[ck].tracks[target];
  if (!t) return { target, blockers: [], msg: "" };
  const done = new Set(Object.keys(checked).filter(k => checked[k] === true || checked[k] === "mastery"));
  const blockers = t.req.filter(id => relIds.includes(id) && !done.has(id));
  // Add pick items that still need completing
  (t.pick || []).forEach(p => {
    const available = p.from.filter(id => relIds.includes(id));
    const completed = available.filter(id => done.has(id));
    const remaining = p.need - completed.length;
    if (remaining > 0) {
      available.filter(id => !done.has(id)).slice(0, remaining).forEach(id => { if (!blockers.includes(id)) blockers.push(id); });
    }
  });
  // Add pickGroup items that still need completing
  (t.pickGroup || []).forEach(pg => {
    let groupsCompleted = 0;
    for (const group of pg.from) {
      const groupAvailable = group.filter(id => relIds.includes(id));
      if (groupAvailable.length > 0 && groupAvailable.every(id => done.has(id))) groupsCompleted++;
    }
    const remaining = pg.need - groupsCompleted;
    if (remaining > 0) {
      for (const group of pg.from) {
        const groupAvailable = group.filter(id => relIds.includes(id));
        const groupDone = groupAvailable.every(id => done.has(id));
        if (!groupDone) {
          groupAvailable.filter(id => !done.has(id)).forEach(id => { if (!blockers.includes(id)) blockers.push(id); });
          break;
        }
      }
    }
  });
  return { target, blockers, msg: blockers.length === 0 ? `Remaining ${target}-track items haven't been assigned yet.` : `${blockers.length} more to reach ${target} track` };
}

export function tokBal(freeUsed, extraUsed) {
  const base = 3;
  const free = freeUsed || 0;
  const extra = extraUsed || 0;
  return { total: base, used: free, avail: Math.max(0, base - free), extra, freeExhausted: free >= base };
}

export function pastCutoff(ck) {
  const c = COURSES[ck];
  if (!c || !c.tokenCutoffDate) return false;
  return new Date() > c.tokenCutoffDate;
}

export function getTokenCutoff(ck) {
  const c = COURSES[ck];
  return c?.tokenCutoff || "";
}

export function getTokenTarget(aId, ck) {
  const c = COURSES[ck];
  const a = c.assignments.find(x => x.id === aId);
  if (a?.tokenGroup) {
    const g = c.tokenGroups[a.tokenGroup];
    return { id: a.tokenGroup, name: g.name, isGroup: true };
  }
  return { id: aId, name: a?.name || aId, isGroup: false };
}

export function getCourseSections(ck) {
  const c = COURSES[ck];
  return c?.sections || null;
}
