# Pre-screening Platform

Internal app to define, for each job, which parameters are evaluated and with what weight (out of 10), plus the "killer questions" for the agent interview phase. The Happy Robot workflow queries this app to know what to evaluate, and returns the score, which this app syncs to Ashby.

## Structure

```
server.js              -> Express server
db/index.js            -> SQLite schema (jobs, parameters, killer_questions, score_log, recruiter_jobs, recruiters)
routes/api.js          -> app endpoints
routes/ashby.js         -> Ashby API client
public/                -> UI (HTML/CSS/JS, no build step)
```

## Deploy on Railway

1. Push this folder to a GitHub repo (or use `railway up` directly from the CLI).
2. On Railway: **New Project → Deploy from GitHub repo**.
3. Add a **Volume** mounted at `/data` (so the SQLite database is not wiped on every redeploy) and set `DATA_DIR=/data` in the environment variables.
4. Configure the environment variables (see `.env.example`):
   - `INTERNAL_API_KEY` — key that Happy Robot will send in the `x-api-key` header.
   - `ASHBY_API_KEY` — your Ashby API key (Ashby → Settings → API).
   - `ASHBY_SCORE_FIELD_ID` — id of the custom field in Ashby where the score is stored (create it in Ashby and use `customField.list` to get its id, or copy it from the Ashby UI if it shows it).
   - `ASHBY_SCORE_OBJECT_TYPE` — `Application` or `Candidate`, depending on which object type you created the custom field on.
5. Railway detects the Node project automatically (Nixpacks) and runs `npm install && npm start`.

## How Happy Robot uses it

### 1. Read a job's criteria before evaluating a candidate

```
GET https://YOUR-APP.up.railway.app/api/jobs/{jobId}/evaluation-config
Header: x-api-key: <INTERNAL_API_KEY>
```

Returns:
```json
{
  "job": { "id": "...", "name": "Field Engineer", "ashby_job_id": "..." },
  "general_parameters": [{ "name": "Immediate availability", "weight": 2, "added_by": "Jorge" }],
  "job_parameters": [{ "name": "Years of field experience", "weight": 4, "added_by": "Iñigo" }],
  "killer_questions": [{ "question": "Can you travel more than 50% of the time?", "added_by": "Jackson" }]
}
```

With this, the pre-screening agent's prompt builds its list of criteria and weights.

### 2. Send the calculated score (and sync it to Ashby)

```
POST https://YOUR-APP.up.railway.app/api/candidates/score
Header: x-api-key: <INTERNAL_API_KEY>
Body:
{
  "job_id": "...",
  "ashby_candidate_id": "...",
  "ashby_application_id": "...",
  "score": 8.5,
  "status": "PASS",
  "breakdown": { "...": "..." },
  "sync_to_ashby": true
}
```

The app stores the result in `score_log` and, if `sync_to_ashby` is `true`, calls `customField.setValue` in Ashby to write the score directly to the configured custom field.

### 3. Agent Interview (Phase 2)

The AI voice agent asks the job's killer questions verbally as true/false and the
backend scores them **deterministically** (plain weighted arithmetic — no AI
judgment). This backend never changes the Ashby stage or archives anyone; the
Happy Robot workflow does that based on the `passed` flag.

All interview endpoints are protected by the same `x-api-key` header as above.

```
GET  /api/interview/questions?applicationId=...        -> { applicationId, jobId, stageEnteredAt, questions: [{id, text, weight}] }
POST /api/interview/attempts/:applicationId/increment  -> { attempts }   # zero-engagement (no answers) counter
POST /api/interview/results                             -> { score, passed, coverage: {asked, total}, sync }
GET  /api/interview/lookup?phone=...                    -> { matched, candidateName, jobTitle, companyName, candidateLanguage, recordingEnabled, killerQuestions } | { matched: false }
```

`POST /api/interview/results` body:
```json
{
  "applicationId": "...",
  "callConnected": true,
  "answers": [{ "question_id": "...", "answer": true }, { "question_id": "...", "answer": null }],
  "callbackRequested": false,
  "callNotes": "..."
}
```
Score = (weighted count of `true` among questions actually asked ÷ weighted total
of questions actually asked) × 10. `answer: null` means the question was not asked
and is excluded from both the numerator and denominator. `passed = score >= 8`.
The result is stored, and the score + coverage are synced to the Ashby custom
fields configured via `ASHBY_INTERVIEW_SCORE_FIELD_ID` / `ASHBY_INTERVIEW_COVERAGE_FIELD_ID`.

> **Note on `/interview/lookup`:** Ashby's documented candidate search covers
> name/email; phone search is not confirmed. The endpoint does a best-effort live
> Ashby lookup (isolated in `routes/ashby.js`) and returns `{ matched: false }`
> when nothing is found — verify the Ashby request shape before relying on it.

## History tab

The recruiter app has a **History** tab showing, per application, the full
evaluation timeline (Prescreen → Agent Interview), the killer questions with the
true/false answer captured for each, call details (connected, callback, notes,
zero-engagement attempts), and charts (interview score vs. the 8/10 threshold and
a coverage donut). It reads from two open, read-only endpoints:

```
GET /api/history                              -> list of evaluated applications
GET /api/applications/:applicationId/history  -> full detail for one application
```

Killer questions are still entered exactly where they were before; the interview
phase reuses them automatically (each carries an optional `weight`, default 1).

## Recruiters section

A second top-level section in the UI (next to **Screening Criteria**), styled the
same way. It has one folder per job title (same "+ New folder" pattern), and each
folder holds a list of recruiter contacts — name, email (validated), a Google
Calendar booking link (validated URL, the recruiter creates it themselves and
pastes it here), and optional notes. Entries can be edited and deleted inline.

An external automation (polled ~every 15 min) fetches the **primary** recruiter
for a job by title:

```
GET https://YOUR-APP.up.railway.app/api/recruiters?job={job_title}
Header: x-api-key: <INTERNAL_API_KEY>
```

- Job title matching is **case-insensitive and trimmed**.
- Returns the **first recruiter added** to that job folder (the primary contact).
- Stable response shape — do not change:

```json
{
  "recruiterName": "Alice Recruiter",
  "recruiterEmail": "alice@company.com",
  "calendarLink": "https://calendar.google.com/calendar/appointments/..."
}
```

- `404 { "error": "..." }` when no recruiter is configured for that job title.
- `400 { "error": "..." }` when the `job` query parameter is missing.

Recruiter management endpoints (used by the UI):

```
GET    /api/recruiter-jobs                            -> folders (one per job title)
POST   /api/recruiter-jobs                            -> { name }
PUT    /api/recruiter-jobs/:id                        -> { name }
DELETE /api/recruiter-jobs/:id
GET    /api/recruiter-jobs/:jobId/recruiters          -> list for a folder
POST   /api/recruiter-jobs/:jobId/recruiters          -> { name, email, calendar_link, notes? }
PUT    /api/recruiters/:id                            -> partial update (validated)
DELETE /api/recruiters/:id
```

## Notes

- The "weights" are free by design (each person adds their own); the UI shows the total sum so you can spot if you go over 10 between everyone, but it does not block it — decide for yourselves whether to normalize before the agent computes the final score.
- There is no user authentication in the UI (it's intended for internal team use). If you're going to leave it public on Railway, at least put some basic auth in front of it (Railway makes this easy) so not just anyone can change the parameters.
- Protected data: the UI does not prevent someone from adding a discriminatory parameter (age, etc.) — that validation has to live in the agent's prompt and in the team's human review; see the conversation about this point.
