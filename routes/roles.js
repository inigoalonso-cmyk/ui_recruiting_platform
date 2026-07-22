// Canonicalize an Ashby job title into a role-level identity, collapsing the
// same role opened in multiple locations into one folder.
//
// The Ashby board lists the same role many times, once per country/city
// ("Forward Deployed Engineer - SF", "... - Spain", "... - Chicago", ...). For
// the candidate-facing dashboard (Job Info / JobBot) and for Screening we want
// ONE folder per role, location-agnostic. This module is the single source of
// truth for that mapping so BOTH the Ashby sync (which folder to upsert) and the
// interview-scoring resolver (which folder an application belongs to) agree.
//
// It is deterministic on purpose (no LLM): same title in → same role out, every
// run, so the sync stays idempotent and never spawns duplicate folders.

// Location tokens we strip when they appear as a trailing " - <loc>" segment or,
// for countries only, as a trailing bare word ("GM Spain" -> "GM"). Cities are
// NOT stripped bare-word to avoid mangling legitimate role names.
const COUNTRY_TOKENS = [
  'spain', 'france', 'germany', 'mexico', 'brazil', 'argentina', 'australia',
  'singapore', 'india', 'united kingdom', 'uk', 'usa', 'us', 'europe', 'latam',
  'emea', 'apac', 'german speaking',
];

const CITY_TOKENS = [
  'sf', 'san francisco', 'nyc', 'new york', 'chicago', 'madrid', 'london',
];

const LOCATION_SEGMENT_TOKENS = new Set([...COUNTRY_TOKENS, ...CITY_TOKENS]);

// Explicit overrides for titles that don't follow the " - <location>" shape.
// Keyed by the lower-cased, whitespace-collapsed raw title.
const OVERRIDES = {
  'gm spain': 'GM',
  'gm brazil': 'GM',
};

function collapseWs(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function slug(s) {
  return collapseWs(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Returns { canonicalTitle, roleKey }.
// roleKey is the stable anchor stored in jobs.ashby_job_id (prefixed so it never
// collides with a real Ashby UUID that older rows might still carry).
function canonicalizeRole(rawTitle) {
  const raw = collapseWs(rawTitle);
  const override = OVERRIDES[raw.toLowerCase()];
  if (override) {
    return { canonicalTitle: override, roleKey: `role:${slug(override)}` };
  }

  // 1. Drop trailing " - <location>" segments (handles "Role - SF - Remote" too).
  const parts = raw.split(/\s+-\s+/);
  while (parts.length > 1) {
    const last = parts[parts.length - 1].toLowerCase();
    if (LOCATION_SEGMENT_TOKENS.has(last)) parts.pop();
    else break;
  }
  let canonical = parts.join(' - ');

  // 2. Strip a trailing bare COUNTRY word ("GM Spain" -> "GM"), but never reduce
  //    the title to nothing.
  for (const token of COUNTRY_TOKENS) {
    const re = new RegExp(`\\s+${token.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}$`, 'i');
    if (re.test(canonical)) {
      const stripped = canonical.replace(re, '').trim();
      if (stripped) canonical = stripped;
      break;
    }
  }

  canonical = collapseWs(canonical);
  return { canonicalTitle: canonical, roleKey: `role:${slug(canonical)}` };
}

module.exports = { canonicalizeRole };
