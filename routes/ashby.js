const fetch = require('node-fetch');

const ASHBY_BASE_URL = 'https://api.ashbyhq.com';

function authHeader() {
  const key = process.env.ASHBY_API_KEY;
  if (!key) throw new Error('ASHBY_API_KEY is not set in the environment variables');
  const token = Buffer.from(`${key}:`).toString('base64');
  return `Basic ${token}`;
}

async function ashbyRequest(method, body = {}) {
  const res = await fetch(`${ASHBY_BASE_URL}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.success === false) {
    const msg = (data.errors && data.errors.join(', ')) || res.statusText;
    throw new Error(`Ashby API error (${method}): ${msg}`);
  }
  return data;
}

/**
 * Writes the pre-screening score to a custom field in Ashby.
 * objectType is usually "Application" or "Candidate" depending on where the field was created.
 */
async function setCustomFieldScore({ objectId, objectType, fieldId, value }) {
  return ashbyRequest('customField.setValue', {
    objectId,
    objectType,
    fieldId,
    fieldValue: value,
  });
}

async function listCustomFields() {
  return ashbyRequest('customField.list', {});
}

async function getCandidateInfo(candidateId) {
  return ashbyRequest('candidate.info', { id: candidateId });
}

async function listJobs() {
  return ashbyRequest('job.list', {});
}

/**
 * List published job postings (id = jobPosting id, jobId = the underlying job id
 * that job_ashby_links keys on). Read-only. Descriptions are NOT included here —
 * fetch each posting's body with getJobPostingInfo.
 */
async function listJobPostings(limit = 200) {
  return ashbyRequest('jobPosting.list', { limit });
}

/**
 * Fetch a single job posting's full content, including results.descriptionPlain
 * / results.descriptionHtml. Read-only.
 */
async function getJobPostingInfo(jobPostingId) {
  return ashbyRequest('jobPosting.info', { jobPostingId });
}

/**
 * Fetch a single application (used to resolve which job an application belongs
 * to, and its current interview stage).
 */
async function getApplicationInfo(applicationId) {
  return ashbyRequest('application.info', { applicationId });
}

/**
 * Best-effort live lookup of a candidate by phone number.
 *
 * NOTE: Ashby's documented `candidate.search` supports `email` and `name`.
 * Phone search is NOT confirmed in the docs, so we send the phone under a few
 * plausible keys and let Ashby ignore the ones it doesn't understand. Callers
 * MUST still verify each returned candidate's phone numbers themselves (see
 * routes/api.js), and treat an empty/errored result as "no match". Verify the
 * real request shape against the Ashby API reference before relying on this.
 */
async function searchCandidatesByPhone(phone) {
  const data = await ashbyRequest('candidate.search', { phoneNumber: phone, phone });
  return (data && data.results) || [];
}

/**
 * List applications for ONE job (read-only). ALWAYS scoped to a jobId so a caller
 * can never accidentally pull the whole pipeline. `status` filters the application
 * status (Active | Archived | Hired | Lead); omit for all. Returns the raw Ashby
 * page ({ results, moreDataAvailable, nextCursor }). Works for draft/closed jobs too
 * (job status is not a filter here).
 */
async function listApplications({ jobId, status, cursor, limit } = {}) {
  if (!jobId) throw new Error('listApplications requires a jobId (safety: never list unscoped)');
  const body = { jobId };
  if (status) body.status = status;
  if (cursor) body.cursor = cursor;
  if (limit) body.limit = limit;
  return ashbyRequest('application.list', body);
}

/** List the interview stages of a plan, in order. Read-only. Each stage has
 *  { id, title, type, orderInInterviewPlan }. Used to find the "next" stage to
 *  advance to, and the Archived-type stage. */
async function listInterviewStages(interviewPlanId) {
  if (!interviewPlanId) throw new Error('listInterviewStages requires an interviewPlanId');
  return ashbyRequest('interviewStage.list', { interviewPlanId });
}

/** List the org's archive reasons (read-only). Each has { id, text, ... }. Needed as
 *  archiveReasonId when moving an application to the Archived stage. */
async function listArchiveReasons() {
  return ashbyRequest('archiveReason.list', {});
}

/** Move ONE application to a specific interview stage (advance, or archive when the
 *  target stage is an Archived-type stage — then archiveReasonId is required).
 *  WRITE — needs candidatesWrite. Always scoped to a single applicationId. */
async function changeApplicationStage({ applicationId, interviewStageId, archiveReasonId }) {
  if (!applicationId || !interviewStageId) {
    throw new Error('changeApplicationStage requires applicationId and interviewStageId');
  }
  const body = { applicationId, interviewStageId };
  if (archiveReasonId) body.archiveReasonId = archiveReasonId;
  return ashbyRequest('application.changeStage', body);
}

module.exports = {
  setCustomFieldScore,
  listCustomFields,
  getCandidateInfo,
  getApplicationInfo,
  searchCandidatesByPhone,
  listJobs,
  listJobPostings,
  getJobPostingInfo,
  listApplications,
  listInterviewStages,
  changeApplicationStage,
  listArchiveReasons,
};
