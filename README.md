# ACity Attendance

Classroom attendance: lecturer shows a QR → student scans, enters 8-digit ID, GPS is checked against the classroom, a live selfie is captured, attendance is recorded.
Stack: Node/Express, Firebase Firestore, static HTML front end. Deploys on Render.

## Pages
- `/?s=<sessionId>` – student flow (opened by scanning the QR)
- `/lecturer.html` – lecturer dashboard (create session, QR, live list with selfies, CSV export, roster import)

## 1. Firebase
1. console.firebase.google.com → create project → **Build → Firestore Database** → create (production mode).
2. **Project settings → Service accounts → Generate new private key** (downloads a JSON file). Never commit it.
3. Firestore is only accessed through the server (Admin SDK), so keep the default locked rules.

## 2. Run locally
```bash
npm install
export FIREBASE_SERVICE_ACCOUNT="$(cat path/to/serviceAccount.json)"
export ADMIN_PASSWORD="choose-a-strong-password"
npm start   # http://localhost:3000/lecturer.html
```
Camera and GPS need HTTPS on phones (Render provides it; localhost works on the same machine).

## 3. GitHub
```bash
git init && git add . && git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<you>/acity-attendance.git
git push -u origin main
```

## 4. Render
New → Web Service → connect the repo (or use the included `render.yaml`).
Build `npm install`, start `npm start`. Add env vars:
- `FIREBASE_SERVICE_ACCOUNT` – paste the whole service account JSON
- `ADMIN_PASSWORD` – lecturer password
- `SESSION_SECRET` – any random string
- `PUBLIC_URL` – (optional) your Render URL, used inside the QR code

Free Render services sleep after inactivity; open the site a minute before class.

## Branding
Colours are CSS variables at the top of `public/style.css` (`--brand`, `--brand-dark`). Set them to the official Academic City values and swap the "AC" mark for the official logo if you have permission to use it.

## Notes
- Geofence radius defaults to 100 m, plus the phone's reported GPS accuracy (capped at 50 m).
- Selfies are stored as small JPEGs in Firestore (no paid Storage bucket needed).
- Auto face capture uses the browser `FaceDetector` where available (Chrome/Android); otherwise it captures after a short hold. Manual button always works.
- This is a deterrent, not proof: GPS can be spoofed. Get student consent / follow the school's data-protection rules for selfies and location (Ghana Data Protection Act).
