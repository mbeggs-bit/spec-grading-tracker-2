export const TOKEN_CUTOFF = "April 26, 2026";
export const CUTOFF_DATE = new Date("2026-04-26T23:59:59");
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
      { id: "cp-mtp", name: "Math Teaching Practices" },
      { id: "cp-les", name: "Launch, Explore, Summarize" },
      { id: "cp-ca", name: "Concept Attainment" },
      { id: "cp-fb", name: "Fluency Beliefs" },
      { id: "cp-q", name: "Questioning" },
    ],
    bonus: [{ id: "b3820-1", name: "Math Read-Aloud Review" }, { id: "b3820-2", name: "Peer Teaching Observation" }],
    tracks: {
      A: { req: ["3act","lesson","vtm1","vtm2","vtm3","frac-int","frac-act","thinking","portfolio"] },
      B: { req: ["3act","lesson","vtm1","vtm2","frac-int","frac-act","portfolio"] },
      C: { req: ["3act","lesson","vtm1","frac-int","portfolio"] },
      D: { req: ["3act"], alt: ["lesson"], isOr: true },
    },
  },
  "ECEL 4850": {
    title: "ECEL 4850: Math Curriculum & Assessment",
    short: "Math Curriculum & Assessment",
    color: "#CF202E", colorLight: "#FCDEDE",
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
      { id: "nt-plan", name: "Number Talk Planning", eval: "completion" },
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
    bonus: [{ id: "b4850-1", name: "Additional Classroom Observation" }],
    tracks: {
      A: { req: ["les1","les2","ct1","ct2","nt-plan","nt-impl","pwa-chart","pwa-a1","pwa-a2","pwa-a3","pwa-followup","fp-w1","fp-w2","fp-w3"] },
      B: { req: ["les1","les2","ct1","ct2","nt-plan","pwa-chart","pwa-a1","pwa-a2","fp-w1","fp-w2"] },
      C: { req: ["les1","ct1","pwa-chart","pwa-a1","fp-w1"] },
      D: { req: ["les1","ct1","fp-w1"] },
    },
  },
};

export function calcGrade(checked, relIds, ck) {
  const c = COURSES[ck];
  const done = new Set(Object.keys(checked).filter(k => checked[k] === true || checked[k] === "mastery"));
  if (done.size === 0 && relIds.length < 2) return "early";
  if (done.size === 0 && relIds.length >= 2) return "F";
  for (const g of ["A", "B", "C", "D"]) {
    const t = c.tracks[g];
    const rv = t.req.filter(id => relIds.includes(id));
    if (rv.length === 0) continue;
    if (g === "D" && t.isOr) {
      const mOk = t.req.filter(id => relIds.includes(id)).every(id => done.has(id));
      const aOk = (t.alt || []).filter(id => relIds.includes(id)).every(id => done.has(id));
      if ((t.req.some(id => relIds.includes(id)) && mOk) || (t.alt && t.alt.some(id => relIds.includes(id)) && aOk)) return g;
    } else {
      if (rv.every(id => done.has(id))) return g;
    }
  }
  return "F";
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
  return { target, blockers, msg: blockers.length === 0 ? `Remaining ${target}-track items haven't been assigned yet.` : `${blockers.length} more to reach ${target} track` };
}

export function tokBal(tokensUsed, bonusCount) {
  const base = 3;
  const used = tokensUsed || 0;
  return { total: base + (bonusCount || 0), used, avail: base + (bonusCount || 0) - used, earned: bonusCount || 0 };
}

export function pastCutoff() {
  return new Date() > CUTOFF_DATE;
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
