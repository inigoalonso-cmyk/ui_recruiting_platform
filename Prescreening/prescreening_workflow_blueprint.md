# Prescreen — Blueprint (v3, with confirmed Ashby API details)

**Name of this phase: Prescreen** (first phase of the broader roadmap of
workflows in Ashby).

Built on the confirmed HappyRobot native nodes (**Loop**, **AI Extract**,
**Paths**, native **Ashby** integration) plus confirmed Ashby API endpoints,
payloads, and permission scopes.

## Structure

### 1. Trigger — Scheduled
Runs every **30 minutes**.

### 2. Ashby — List Applications (`application.list`)
- Output: `applications` (array)
- **Confirmed filter:** `application.list` supports `currentInterviewStage`.
  Since Prescreen moves every processed application out of the initial
  intake stage (to Agent Interview or Archived), filtering by
  `currentInterviewStage = <intake stage ID>` naturally returns only
  unprocessed applications — much cheaper than fetching everything and
  checking a custom field. Step 4a stays as a cheap safety-net check, not
  the primary filter.
- **Confirmed pagination:** cursor-based, via `limit` (max 100) and
  `cursor`. Response includes `moreDataAvailable` and `nextCursor` — keep
  calling until `moreDataAvailable` is `false`.
- **Confirmed sync pattern:** after a full paginated sync, Ashby returns a
  `syncToken` you can store and reuse on later calls to fetch only
  applications that changed since then (incremental sync), instead of
  re-listing everything every run. See "Backfill & sync strategy" below.

### 2b. Ashby — job.search
Fetches the recruiter-defined scoring criteria for the job.
- Confirmed: `customField.create` supports `objectType: "Job"`, so
  `job_criteria` can live as a Job-level custom field, filled in by each
  recruiter.
- Confirmed: `job.search` returns a `customFields` array per job — that's
  the documented read path (no separate `job.info` schema confirmed).
- Output: `job_criteria`
- Open item: confirm whether `job.search` (or another job endpoint) also
  returns an **interview plan ID** for the job — needed for step 4e-prep.

### Backfill & sync strategy (handles the ~70,000 existing applications)

Running the standard 30-min cadence against 100 results/page would take
~700 runs just to list the backlog once — far too slow. `application.list`
doesn't return a total/pending count, but it doesn't need to: the response's
own `moreDataAvailable` flag is enough to drive an outer page-loop, with no
threshold to configure.

**Outer loop, wrapping steps 2–4e:**
1. Call `application.list` (filtered by `currentInterviewStage`, `limit=100`,
   `cursor` = last stored cursor if any).
2. Run the existing per-application loop (steps 3–4e) over this page's
   `results`.
3. Check `moreDataAvailable`:
   - **`true` →** fetch the next page with `nextCursor` and repeat from 1,
     up to a safe cap per run (time/number of pages, to respect Ashby's
     1,000 req/min limit and the AI provider's limits).
   - **`false` →** everything is caught up; store the final cursor/
     `syncToken` and end the run.

Because this runs the same way every time, the workflow behaves like a
"backfill" on its own while `moreDataAvailable` keeps coming back `true`
(the current 70,000-application situation), and automatically settles into
processing just one small page per run once caught up — no manual switch
between phases needed.

Open items for this part:
- Confirm with Frontal whether the Loop node can paginate through multiple
  pages within a single run (i.e., an outer loop wrapping the existing
  per-application loop), and whether there's an execution-time or iteration
  cap that limits how much a single run can chew through.
- Confirm whether HappyRobot workflows can persist a variable (`cursor` /
  `syncToken`) across separate scheduled runs — needed so it can resume
  cleanly on the next run once the per-run cap is hit.
- Confirm whether `currentInterviewStage` can be combined with a
  `syncToken`-based incremental call, or whether they're mutually exclusive
  filter modes.

### 3. Loop — iterate_over `applications`
- Mode: **sequential** (via `execute_in_parallel` = off), to avoid
  rate-limiting Ashby on the write-backs.
- `iterate_over`: point the variable picker (`@`) at the actual array
  (e.g. `response.results` if nested, not the top-level response object).
- Current item: `iteration_element` (one `application`)

Inside the loop, for each `iteration_element`:

**4a. Paths — already scored?**
Condition on the Prescreening Score custom field of `iteration_element`.
- Has a score → end this iteration (skip)
- No score → continue

**4b. Ashby — Get CV file**
- Get the resume file handle from `candidate.info` (e.g. `resumeFileHandle`)
  for the candidate on `iteration_element`.
- Call `file.info` with that handle to resolve it to a usable file/URL.
- Output: `cv_file`
- Open item: exact `file.info` response shape (field names for file type,
  download URL, expiry) isn't confirmed in the docs — check the real
  response once this node is on the canvas.

**4b2. Parse CV to text** *(open item)*
Not yet confirmed whether this is a separate node or handled internally by
AI Extract.
- Open item: does AI Extract accept a file/attachment (e.g. a PDF resume)
  directly and parse it internally, or is a dedicated document-parsing node
  needed to turn `cv_file` into `cv_text` first? If separate, which formats
  does it support (PDF, DOCX)?
- Output (once resolved): `cv_text`

**4c. AI Extract — Score CV**
AI node with structured output (prompt below).
- Inputs: `candidate_name`, `job_title`, `cv_text` (from step 4b2),
  `job_criteria` (from step 2b — no longer a placeholder)
- Output fields: `score` (number), `rationale` (string)
- Put the rubric/examples in the prompt, describe `score` as "integer 0–10"
  in the field definition, and add a **Paths** guard after this node to
  hard-enforce the 0–10 bound if needed.

**4d. Ashby — customField.setValues** (via Passthrough Request)
Writes `score` and `rationale` onto the Application's custom fields.
Inherits the Ashby credential from Settings → Integrations automatically.
- Open item: the exact payload schema (application ID + field ID + value
  shape) isn't confirmed in the docs — verify in the API reference/playground
  when building this call.

**4e-prep. Ashby — interviewStage.list**
```json
{ "interviewPlanId": "<uuid>" }
```
- Requires the job's interview plan ID (see open item in step 2b) — if the
  job endpoints don't expose it directly, we may need another lookup step.
- Output: `stage_id_agent_interview`, `stage_id_rejected` (match by stage
  title)

**4e-prep-2. Ashby — archiveReason.list**
One-time/cached lookup to get the `archiveReasonId` to use when rejecting.
- If there isn't already a reason like "Failed AI prescreening", create one
  in Admin → Jobs & Applications → Archive Reasons first.

**4e. Paths — score ≥ 8?**
- **Yes →** `application.changeStage`
  ```json
  { "applicationId": "<uuid>", "interviewStageId": "<stage_id_agent_interview>" }
  ```
- **No (fallback) →** `application.changeStage`
  ```json
  {
    "applicationId": "<uuid>",
    "interviewStageId": "<stage_id_rejected>",
    "archiveReasonId": "<archiveReasonId>"
  }
  ```
  `archiveReasonId` is required when moving to an Archived stage.

## Prompt for the AI Extract node

```
You are a recruiting assistant that performs a first-pass CV screening for job applications.

## Task
You will receive one candidate's CV along with the job they applied to. Evaluate how well the CV matches the role and return a score from 0 to 10, along with a short rationale.

## Inputs
- Candidate name: {{candidate_name}}
- Job title: {{job_title}}
- CV text: {{cv_text}}
- Job criteria: {{job_criteria}}

## Scoring criteria
[PLACEHOLDER — to be filled in once the hiring team provides the scoring rubric for this role. Do not invent criteria in the meantime; if job_criteria is empty, score based on general fit signals only: relevant experience, relevant skills, seniority match, and clear career progression.]

## Rules
- Base your evaluation only on information present in the CV. Do not infer or assume facts that are not stated.
- Do not consider or reference age, gender, name, nationality, photo, or any other characteristic unrelated to job qualifications. Evaluate strictly on professional fit.
- If the CV is incomplete, unreadable, or missing key information, reflect that in a lower score and state why in the rationale — do not guess.
- The rationale must be concise (2–4 sentences) and reference specific evidence from the CV.
- A score of 8 or higher means the candidate should advance to the next round. Reserve 8+ for candidates who clearly meet the core requirements.

## Output fields
- score (number, 0-10)
- rationale (string)
```

## Confirmed Ashby endpoints

| Step | Endpoint | Scope required |
|---|---|---|
| Create custom fields (Score, Rationale, job criteria) | `customField.create` | `hiringProcessMetadataWrite` |
| Write custom field values | `customField.setValues` | `hiringProcessMetadataWrite` |
| List applications | `application.list` | `candidatesRead` |
| Read resume/file metadata | `candidate.info` + `file.info` | `candidatesRead` |
| Read job criteria | `job.search` | `jobsRead` |
| List interview stages | `interviewStage.list` | `interviewsRead` |
| Change application stage | `application.changeStage` | `candidatesWrite` |
| List archive reasons | `archiveReason.list` | `candidatesRead` |

**Full scope set needed on the API key:** `hiringProcessMetadataWrite`,
`candidatesRead`, `candidatesWrite`, `jobsRead`, `interviewsRead`.

## Rate limits & reliability
- Ashby's documented limit is **1,000 requests/minute per API key** — plenty
  for a batch every 30 minutes.
- Still worth designing for: retry with backoff, idempotency on writes
  (don't double-write score/stage changes), and pagination discipline on
  `application.list`.

## Confirmed decisions

- Trigger: every 30 minutes.
- `job_criteria`: per job, stored as a Job-level custom field, entered by
  each recruiter (not a single rubric shared across all jobs).
- Rejections: archived via `application.changeStage` with a required
  `archiveReasonId` — no activity log or notification beyond that for now.

## Documentation gaps — verify directly before relying on them

- Exact `customField.setValues` payload schema (application ID / field ID /
  value shape).
- Full `application.list` filter schema — confirm there's really no
  server-side "missing custom field" filter.
- Exact `file.info` response shape (file type field, URL field, expiry).
- Whether an Application-level custom field created via the API shows up in
  all expected UI surfaces (there's no dedicated Admin UI section for it).
- Whether the `applicationSubmit` webhook is available on our specific plan
  (relevant only if we move from polling to a real-time trigger later).
- Whether `job.search`/another job endpoint exposes a job's interview plan
  ID, needed to call `interviewStage.list`.

## Open items before building it

- Confirm the workflow is on the **V3** engine — already done.
- Set up the Ashby API key under Admin → Integrations → API Keys with the
  full scope set listed above (owner: colleague).
- Create the "Prescreening Score" and "Prescreening Rationale" custom fields
  on Application, and the `job_criteria` custom field on Job, via
  `customField.create`.
- Create an Archive Reason for AI-rejected candidates if one doesn't already
  exist (Admin → Jobs & Applications → Archive Reasons).
- Resolve the job → interview plan ID → stage ID chain once the real
  endpoints are on the canvas.
- Confirm how CV parsing works: whether AI Extract accepts the resume file
  directly, or a separate document-parsing node is needed between "Get CV"
  and "Score CV".
- Plan the one-time backfill run for the ~70,000-application backlog
  separately from the steady 30-minute cadence (see "Backfill & sync
  strategy" above), and confirm the three open items listed there with
  Frontal before building.
