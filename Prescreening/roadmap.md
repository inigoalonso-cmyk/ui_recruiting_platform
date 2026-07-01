# Ashby Hiring Automation — Roadmap

Full pipeline of workflows to build in HappyRobot, wired into Ashby, following
the original flow: jobBot → Applicants → **Prescreen** → Agent Interview →
Email + Recruiter Calendar → Interview Scheduled → Briefing Email to
Recruiter. Any candidate that fails a gate gets archived (terminal, no
separate workflow — same archive step reused).

## Phase 0 — jobBot *(existing, out of scope)*
- What it is: LinkedIn agent that answers candidate questions.
- Status: Already live — not part of this build.

## Phase 1 — Prescreen *(in progress)*
- Goal: score every incoming application's CV from 0–10 against job-specific
  criteria (set per job by the recruiter). Score ≥ 8 advances to Agent
  Interview; otherwise archived with a reason.
- Status: **Blueprint complete** — see `prescreening_workflow_blueprint.md`
  in this folder for full node structure, prompt, confirmed Ashby endpoints,
  and open items.
- Blocked on: Ashby API key with the required scopes
  (`hiringProcessMetadataWrite`, `candidatesRead`, `candidatesWrite`,
  `jobsRead`, `interviewsRead`), plus confirming the CV-parsing step with
  Frontal.

## Phase 2 — Agent Interview
- Goal: an AI-run interview for candidates who passed Prescreen; scores
  their answers and decides pass/fail.
- Status: Not started — design begins once Prescreen is live and writing
  reliably to Ashby.

## Phase 3 — Scheduling (Email + Recruiter Calendar)
- Goal: candidates who pass the Agent Interview get an email letting them
  self-book a slot on the recruiter's calendar.
- Status: Not started.
- Open decision: which calendar tool to integrate (recruiter's native Ashby
  calendar vs. external tool).

## Phase 4 — Recruiter Handoff (Briefing Email)
- Goal: once a candidate books an interview slot, send the recruiter a
  briefing email with a candidate summary and feedback from Prescreen +
  Agent Interview.
- Status: Not started.

## States (no workflow needed)
- **Applicants** — inbound/job board, feeds into Prescreen.
- **Interview Scheduled** — handoff point between Scheduling and the
  recruiter, feeds into Phase 4.

## Build order & dependencies
1. **Prescreen** — blocked on Ashby API key.
2. **Agent Interview** — blocked on Prescreen being live in production.
3. **Scheduling** — blocked on Agent Interview outcome + calendar tool
   decision.
4. **Recruiter Handoff** — blocked on Scheduling.

## Open decisions across the roadmap
- Calendar tool for self-booking (Phase 3).
- Whether Agent Interview runs as a voice call or a chat-based flow.
- Whether/how Ashby's own "AI Filter Assistant" (seen in the Ashby UI)
  overlaps with or replaces any part of this pipeline.
