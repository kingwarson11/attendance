const express = require("express");
const crypto = require("crypto");
const path = require("path");
const admin = require("firebase-admin");
const QRCode = require("qrcode");

// ---------- Firebase ----------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("Missing FIREBASE_SERVICE_ACCOUNT env var (service account JSON).");
  process.exit(1);
}
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});
const db = admin.firestore();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error("Missing ADMIN_PASSWORD env var.");
  process.exit(1);
}
const SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD;
const DEFAULT_RADIUS = Number(process.env.DEFAULT_RADIUS_M || 100);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------
const sign = (v) => crypto.createHmac("sha256", SECRET).update(v).digest("hex");
function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0])
  );
}
function requireLecturer(req, res, next) {
  const t = cookies(req).lt || "";
  const [exp, mac] = t.split(".");
  if (exp && mac && Number(exp) > Date.now() && mac === sign(exp)) return next();
  res.status(401).json({ error: "Not signed in" });
}
function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: "Server error" }); });

// ---------- lecturer auth ----------
app.post("/api/lecturer/login", (req, res) => {
  const a = Buffer.from(String(req.body.password || ""));
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Wrong password" });
  const exp = String(Date.now() + 8 * 3600 * 1000);
  res.setHeader("Set-Cookie", `lt=${exp}.${sign(exp)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=28800${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
  res.json({ ok: true });
});
app.get("/api/lecturer/me", requireLecturer, (req, res) => res.json({ ok: true }));

// ---------- sessions (lecturer) ----------
app.post("/api/sessions", requireLecturer, wrap(async (req, res) => {
  const { course, lat, lng, radius, minutes } = req.body;
  if (!course || typeof lat !== "number" || typeof lng !== "number") return res.status(400).json({ error: "course, lat, lng required" });
  const ref = db.collection("sessions").doc();
  await ref.set({
    course: String(course).slice(0, 80),
    lat, lng,
    radius: Number(radius) || DEFAULT_RADIUS,
    createdAt: Date.now(),
    expiresAt: Date.now() + (Number(minutes) || 30) * 60000,
    closed: false,
  });
  res.json({ id: ref.id });
}));

app.get("/api/sessions", requireLecturer, wrap(async (req, res) => {
  const snap = await db.collection("sessions").orderBy("createdAt", "desc").limit(30).get();
  res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
}));

app.post("/api/sessions/:id/close", requireLecturer, wrap(async (req, res) => {
  await db.collection("sessions").doc(req.params.id).update({ closed: true });
  res.json({ ok: true });
}));

app.get("/api/sessions/:id/qr", requireLecturer, wrap(async (req, res) => {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  const url = `${base}/?s=${req.params.id}`;
  res.json({ url, qr: await QRCode.toDataURL(url, { width: 600, margin: 2 }) });
}));

app.get("/api/sessions/:id/records", requireLecturer, wrap(async (req, res) => {
  const snap = await db.collection("attendance").where("sessionId", "==", req.params.id).get();
  res.json(snap.docs.map((d) => d.data()).sort((a, b) => b.time - a.time));
}));

app.get("/api/sessions/:id/export.csv", requireLecturer, wrap(async (req, res) => {
  const snap = await db.collection("attendance").where("sessionId", "==", req.params.id).get();
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["Student ID", "Name", "Programme", "Year", "Time", "Distance (m)"].join(",")];
  snap.docs.map((d) => d.data()).sort((a, b) => a.time - b.time).forEach((r) => {
    rows.push([r.studentId, r.name, r.programme, r.year, new Date(r.time).toISOString(), r.distance].map(esc).join(","));
  });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="attendance-${req.params.id}.csv"`);
  res.send(rows.join("\n"));
}));

// ---------- students (lecturer imports roster) ----------
app.post("/api/students/import", requireLecturer, wrap(async (req, res) => {
  const list = Array.isArray(req.body.students) ? req.body.students : [];
  let n = 0;
  for (let i = 0; i < list.length; i += 400) {
    const batch = db.batch();
    for (const s of list.slice(i, i + 400)) {
      const id = String(s.id || "").trim();
      if (!/^\d{8,12}$/.test(id)) continue;
      batch.set(db.collection("students").doc(id), {
        name: String(s.name || "").trim(),
        programme: String(s.programme || "").trim(),
        year: String(s.year || "").trim(),
      });
      n++;
    }
    await batch.commit();
  }
  res.json({ imported: n });
}));

// ---------- admin: check attendance ----------
app.get("/api/admin/students", requireLecturer, wrap(async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (q.length < 2) return res.json([]);
  const snap = await db.collection("students").limit(5000).get();
  res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((s) => s.id.startsWith(q) || (s.name || "").toLowerCase().includes(q)).slice(0, 20));
}));

app.get("/api/admin/student/:id", requireLecturer, wrap(async (req, res) => {
  const stu = await db.collection("students").doc(req.params.id).get();
  if (!stu.exists) return res.status(404).json({ error: "Student not found" });
  const snap = await db.collection("attendance").where("studentId", "==", req.params.id).get();
  const records = snap.docs.map((d) => d.data()).sort((a, b) => b.time - a.time);
  res.json({ student: { id: stu.id, ...stu.data() }, records });
}));

app.get("/api/sessions/:id/absent", requireLecturer, wrap(async (req, res) => {
  const [present, all] = await Promise.all([
    db.collection("attendance").where("sessionId", "==", req.params.id).get(),
    db.collection("students").limit(5000).get(),
  ]);
  const here = new Set(present.docs.map((d) => d.data().studentId));
  res.json(all.docs.filter((d) => !here.has(d.id)).map((d) => ({ id: d.id, ...d.data() })));
}));

// ---------- student-facing ----------
app.get("/api/public/session/:id", wrap(async (req, res) => {
  const d = await db.collection("sessions").doc(req.params.id).get();
  if (!d.exists) return res.status(404).json({ error: "Session not found" });
  const s = d.data();
  const open = !s.closed && Date.now() < s.expiresAt;
  res.json({ course: s.course, open });
}));

app.get("/api/public/student/:id", wrap(async (req, res) => {
  if (!/^\d{8,12}$/.test(req.params.id)) return res.status(400).json({ error: "Invalid ID" });
  const d = await db.collection("students").doc(req.params.id).get();
  if (!d.exists) return res.status(404).json({ error: "Student not found" });
  res.json(d.data());
}));

app.post("/api/public/attend", wrap(async (req, res) => {
  const { sessionId, studentId, lat, lng, accuracy, selfie } = req.body;
  if (!sessionId || !/^\d{8,12}$/.test(String(studentId)) || typeof lat !== "number" || typeof lng !== "number")
    return res.status(400).json({ error: "Missing or invalid details." });
  if (typeof selfie !== "string" || !selfie.startsWith("data:image/jpeg;base64,") || selfie.length > 400000)
    return res.status(400).json({ error: "A clear selfie is required." });

  const sRef = db.collection("sessions").doc(sessionId);
  const sDoc = await sRef.get();
  if (!sDoc.exists) return res.status(404).json({ error: "Session not found." });
  const s = sDoc.data();
  if (s.closed || Date.now() > s.expiresAt) return res.status(400).json({ error: "This attendance session has closed." });

  const stu = await db.collection("students").doc(String(studentId)).get();
  if (!stu.exists) return res.status(404).json({ error: "Student ID not found." });

  const dist = Math.round(distanceM(lat, lng, s.lat, s.lng));
  const allowed = s.radius + Math.min(Number(accuracy) || 0, 50); // forgive some GPS error
  if (dist > allowed)
    return res.status(403).json({ error: `You appear to be about ${dist}m from the classroom. You must be in the classroom to sign attendance.`, code: "TOO_FAR" });

  const rRef = db.collection("attendance").doc(`${sessionId}_${studentId}`);
  const time = Date.now();
  try {
    await rRef.create({ sessionId, course: s.course, studentId: String(studentId), ...stu.data(), time, distance: dist, selfie });
  } catch (e) {
    return res.status(409).json({ error: "Attendance already recorded for this ID." });
  }
  res.json({ ok: true, studentId, ...stu.data(), time, selfie });
}));

// On Vercel the app is exported as a serverless handler; elsewhere it listens normally.
if (!process.env.VERCEL) app.listen(process.env.PORT || 3000, () => console.log("ACity Attendance running"));
module.exports = app;
