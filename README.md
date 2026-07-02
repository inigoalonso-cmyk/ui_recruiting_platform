# Pre-screening Platform

Internal app to define, for each job, which parameters are evaluated and with what weight (out of 10), plus the "killer questions" for the agent interview phase. The Happy Robot workflow queries this app to know what to evaluate, and returns the score, which this app syncs to Ashby.

## Structure

```
server.js              -> Express server
db/index.js            -> SQLite schema (jobs, parameters, killer_questions, score_log)
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

### 3. For the second workflow (killer questions)

The interview-call agent can request the job's killer questions from the same `evaluation-config` endpoint (`killer_questions` field), or you can create a dedicated endpoint later if you need something different (for example, marking which one was used on each call).

## Notes

- The "weights" are free by design (each person adds their own); the UI shows the total sum so you can spot if you go over 10 between everyone, but it does not block it — decide for yourselves whether to normalize before the agent computes the final score.
- There is no user authentication in the UI (it's intended for internal team use). If you're going to leave it public on Railway, at least put some basic auth in front of it (Railway makes this easy) so not just anyone can change the parameters.
- Protected data: the UI does not prevent someone from adding a discriminatory parameter (age, etc.) — that validation has to live in the agent's prompt and in the team's human review; see the conversation about this point.
