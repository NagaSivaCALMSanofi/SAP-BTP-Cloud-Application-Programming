/**
 * CAPM Service Implementation — v6
 * ─────────────────────────────────────────────
 * ROOT CAUSE FIX:
 *   The URL .../Feature_Analytic_ModelLive?$format=json returns the OData
 *   service document (listing entity sets), NOT the actual data.
 *
 *   The service document shows:
 *     value: [{ name: "Feature_Analytic_ModelLive", url: "Feature_Analytic_ModelLive" }]
 *
 *   This means the correct data URL is:
 *     .../Feature_Analytic_ModelLive/Feature_Analytic_ModelLive?$format=json
 *
 *   Fix applied in v6:
 *     1. AUTO-RECOVERY: When a service document is detected, automatically
 *        extract the entity set URL from response.value[0].url and retry
 *        with the corrected URL. No manual .env change needed.
 *     2. Update DATASPHERE_API_PATH in .env to include the entity set name:
 *        /api/v1/datasphere/consumption/analytical/RAM_SPACE/Feature_Analytic_ModelLive/Feature_Analytic_ModelLive
 *     3. Log the corrected URL clearly so the user can update .env permanently.
 */

'use strict';

require('dotenv').config();

const cds = require('@sap/cds');
const axios = require('axios');
const qs = require('qs');

// ─────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────
const log = {
    info:  (msg) => console.log(`[${new Date().toISOString()}] INFO:  ${msg}`),
    warn:  (msg) => console.warn(`[${new Date().toISOString()}] WARN:  ${msg}`),
    error: (msg) => console.error(`[${new Date().toISOString()}] ERROR: ${msg}`),
    debug: (msg) => { if (process.env.LOG_LEVEL === 'debug') console.log(`[${new Date().toISOString()}] DEBUG: ${msg}`); }
};

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────
const MAX_RECORDS = parseInt(process.env.MAX_RECORDS) || 10000;
const MAX_PAGES   = 200;
const PAGE_DELAY  = 200;

// ─────────────────────────────────────────────
// OAuth Token Cache
// ─────────────────────────────────────────────
let tokenCache = {
    accessToken: null,
    expiresAt:   null,
    tokenType:   'Bearer'
};

async function fetchNewToken() {
    const { OAUTH_TOKEN_URL, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET } = process.env;

    if (!OAUTH_TOKEN_URL || !OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
        throw new Error('OAuth credentials missing. Check your .env file.');
    }

    log.info('[OAuth] Fetching new access token...');

    const response = await axios.post(
        OAUTH_TOKEN_URL,
        qs.stringify({
            grant_type:    'client_credentials',
            client_id:     OAUTH_CLIENT_ID,
            client_secret: OAUTH_CLIENT_SECRET
        }),
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept':       'application/json'
            },
            timeout: 30000
        }
    );

    const { access_token, expires_in, token_type } = response.data;

    tokenCache = {
        accessToken: access_token,
        expiresAt:   new Date(Date.now() + (expires_in - 60) * 1000),
        tokenType:   token_type || 'Bearer'
    };

    log.info(`[OAuth] Token acquired. Expires: ${tokenCache.expiresAt.toISOString()}`);
    return tokenCache.accessToken;
}

async function getValidToken(forceRefresh = false) {
    if (!forceRefresh && tokenCache.accessToken && tokenCache.expiresAt && new Date() < tokenCache.expiresAt) {
        log.debug('[OAuth] Using cached token.');
        return tokenCache.accessToken;
    }
    if (forceRefresh) {
        tokenCache = { accessToken: null, expiresAt: null, tokenType: 'Bearer' };
    }
    return fetchNewToken();
}

// ─────────────────────────────────────────────
// Sleep helper
// ─────────────────────────────────────────────
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─────────────────────────────────────────────
// Response type detector
// ─────────────────────────────────────────────

/**
 * Detect whether the API returned a service document instead of entity data.
 *
 * A service document looks like:
 *   { "@odata.context": ".../$metadata", "value": [ { "name": "...", "url": "..." } ] }
 *
 * @param {Array} records - Extracted records array
 * @returns {boolean}
 */
function isServiceDocument(records) {
    if (!records || records.length === 0) return false;
    const first = records[0];
    return (
        Object.prototype.hasOwnProperty.call(first, 'name') &&
        Object.prototype.hasOwnProperty.call(first, 'url') &&
        !Object.prototype.hasOwnProperty.call(first, 'featureId') &&
        !Object.prototype.hasOwnProperty.call(first, 'FeatureId') &&
        !Object.prototype.hasOwnProperty.call(first, 'date') &&
        !Object.prototype.hasOwnProperty.call(first, 'status')
    );
}

// ─────────────────────────────────────────────
// Single-page fetch helper
// ─────────────────────────────────────────────

/**
 * Fetch one page from a given URL.
 *
 * @param {string}  url     - Full URL to GET (must already include $format=json)
 * @param {string}  token   - Bearer token
 * @param {number}  pageNum - Page number for logging
 * @returns {{ records: Array, nextLink: string|null, isServiceDoc: boolean, serviceDocEntityUrl: string|null }}
 */
async function fetchOnePage(url, token, pageNum = 1) {
    log.debug(`[API] GET ${url}`);

    const response = await axios.get(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept':        'application/json'
        },
        timeout: 120000
    });

    const body = response.data || {};

    // ── Always log full response on page 1 for diagnostics ───────
    if (pageNum === 1) {
        const bodyStr = JSON.stringify(body);
        log.info(`[API] Page 1 raw response (first 2000 chars): ${bodyStr.substring(0, 2000)}`);
        log.info(`[API] Response top-level keys: ${Object.keys(body).join(', ')}`);
        log.info(`[API] @odata.context: ${body['@odata.context'] || 'NOT PRESENT'}`);
    }

    // ── Extract records ───────────────────────────────────────────
    let records = [];

    if (Array.isArray(body.value)) {
        records = body.value;
    } else if (Array.isArray(body)) {
        records = body;
    } else if (body.value && typeof body.value === 'object') {
        records = [body.value];
    } else {
        log.warn(`[API] Could not extract records. body keys: ${Object.keys(body).join(', ')}`);
    }

    // ── Detect service document response ─────────────────────────
    if (isServiceDocument(records)) {
        const entitySetUrl = records[0].url || null;
        const entitySetName = records[0].name || null;

        log.error(`[API] ══════════════════════════════════════════════════════`);
        log.error(`[API] SERVICE DOCUMENT DETECTED`);
        log.error(`[API] The URL is resolving to the OData service root, not the entity set.`);
        log.error(`[API] Current URL: ${url}`);
        log.error(`[API] Entity set found in service document: "${entitySetName}" → url: "${entitySetUrl}"`);
        log.error(`[API] ── AUTO-RECOVERY: will retry with corrected URL ──`);
        log.error(`[API] ══════════════════════════════════════════════════════`);

        log.info(`[API] Available entity sets in service document:`);
        records.forEach((entry, i) => {
            log.info(`[API]   [${i}] name="${entry.name}" url="${entry.url}"`);
        });

        return { records: [], nextLink: null, isServiceDoc: true, serviceDocEntityUrl: entitySetUrl };
    }

    // ── Log first record structure for validation ─────────────────
    if (records.length > 0) {
        log.info(`[API] First record keys: ${Object.keys(records[0]).join(', ')}`);
        log.info(`[API] First record featureId: "${records[0].featureId || records[0].FeatureId || 'MISSING'}"`);
    }

    const nextLink = body['@odata.nextLink'] || null;

    return { records, nextLink, isServiceDoc: false, serviceDocEntityUrl: null };
}

// ─────────────────────────────────────────────
// Datasphere API Fetch — full pagination with auto-recovery
// ─────────────────────────────────────────────

/**
 * Fetch ALL Feature Analytic records from SAP Datasphere.
 *
 * AUTO-RECOVERY LOGIC:
 *   If the first request returns a service document (name+url fields),
 *   the code automatically appends the entity set URL from the service
 *   document to the base URL and retries — no manual intervention needed.
 *
 *   Example:
 *     Initial URL:   .../Feature_Analytic_ModelLive?$format=json
 *     Service doc:   value[0].url = "Feature_Analytic_ModelLive"
 *     Corrected URL: .../Feature_Analytic_ModelLive/Feature_Analytic_ModelLive?$format=json
 *
 * @returns {{ records: Array, duration: number, pagesFetched: number }}
 */
async function fetchFromDatasphere() {
    const baseUrl = process.env.DATASPHERE_BASE_URL;
    const apiPath = process.env.DATASPHERE_API_PATH;

    // Construct first-page URL with $format=json appended directly
    let firstUrl = `${baseUrl}${apiPath}?$format=json`;

    log.info(`[API] ════════════════════════════════════════`);
    log.info(`[API] Starting paginated fetch`);
    log.info(`[API] First URL: ${firstUrl}`);
    log.info(`[API] Target: up to ${MAX_RECORDS} records, up to ${MAX_PAGES} pages`);

    const t0         = Date.now();
    let allRecords   = [];
    let pagesFetched = 0;
    let currentUrl   = firstUrl;
    let autoRecovered = false;

    // ── Page loop ─────────────────────────────────────────────────
    while (true) {
        if (pagesFetched >= MAX_PAGES) {
            log.warn(`[API] Reached MAX_PAGES (${MAX_PAGES}). Stopping.`);
            break;
        }
        if (allRecords.length >= MAX_RECORDS) {
            log.info(`[API] Reached MAX_RECORDS (${MAX_RECORDS}). Stopping.`);
            break;
        }

        let token = await getValidToken();
        let pageResult;

        try {
            pageResult = await fetchOnePage(currentUrl, token, pagesFetched + 1);
        } catch (err) {
            if (err.response?.status === 401) {
                log.warn(`[API] 401 on page ${pagesFetched + 1} — refreshing token and retrying...`);
                token      = await getValidToken(true);
                pageResult = await fetchOnePage(currentUrl, token, pagesFetched + 1);
            } else {
                const detail = err.response
                    ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
                    : err.message;
                throw new Error(`Datasphere API failed on page ${pagesFetched + 1}: ${detail}`);
            }
        }

        const { records, nextLink, isServiceDoc, serviceDocEntityUrl } = pageResult;

        // ── AUTO-RECOVERY: service document detected ──────────────
        if (isServiceDoc) {
            if (autoRecovered) {
                // Already tried recovery once — give up to avoid infinite loop
                log.error(`[API] Auto-recovery already attempted. Still receiving service document.`);
                log.error(`[API] Please verify DATASPHERE_API_PATH in your .env file.`);
                log.error(`[API] Correct path should be:`);
                log.error(`[API]   ${apiPath}/${serviceDocEntityUrl || 'Feature_Analytic_ModelLive'}`);
                break;
            }

            if (serviceDocEntityUrl) {
                // Build corrected URL by appending entity set name to current base
                const baseWithoutQuery = currentUrl.split('?')[0];
                const correctedUrl = `${baseWithoutQuery}/${serviceDocEntityUrl}?$format=json`;

                log.info(`[API] ── AUTO-RECOVERY TRIGGERED ──`);
                log.info(`[API] Original URL : ${currentUrl}`);
                log.info(`[API] Corrected URL: ${correctedUrl}`);
                log.info(`[API] ── Retrying with corrected URL... ──`);
                log.info(`[API] TIP: Update your .env DATASPHERE_API_PATH to:`);
                log.info(`[API]   ${apiPath}/${serviceDocEntityUrl}`);

                currentUrl    = correctedUrl;
                autoRecovered = true;
                // Do NOT increment pagesFetched — this is a recovery, not a real page
                continue;
            } else {
                log.error(`[API] Service document detected but no entity URL found. Cannot auto-recover.`);
                break;
            }
        }

        pagesFetched++;

        log.info(`[API] Page ${pagesFetched}: received ${records.length} records` +
                 ` | running total: ${allRecords.length + records.length}` +
                 ` | nextLink: ${nextLink ? 'YES' : 'NO'}`);

        allRecords = allRecords.concat(records);

        if (!nextLink) {
            log.info(`[API] No nextLink — pagination complete after ${pagesFetched} page(s).`);
            break;
        }

        currentUrl = nextLink;

        if (PAGE_DELAY > 0) await sleep(PAGE_DELAY);
    }

    log.info(`[API] ── Pre-dedup record count: ${allRecords.length} ──`);

    // ── Deduplication: full-record fingerprint only ───────────────
    const fingerprintSet = new Set();
    const unique = [];

    for (const record of allRecords) {
        const fingerprint = JSON.stringify({
            featureId:       record.featureId       || record.FeatureId,
            date:            record.date             || record.Date,
            dayOfWeek:       record.dayOfWeek        || record.DayOfWeek,
            featureName:     record.featureName      || record.FeatureName,
            firstWeekDay:    record.firstWeekDay     || record.FirstWeekDay,
            period:          record.period           || record.Period,
            priority:        record.priority         || record.Priority,
            projectId:       record.projectId        || record.ProjectId,
            projectName:     record.projectName      || record.ProjectName,
            release:         record.release          || record.Release,
            requirementId:   record.requirementId    || record.RequirementId,
            requirementName: record.requirementName  || record.RequirementName,
            resolution:      record.resolution       || record.Resolution,
            responsible:     record.responsible      || record.Responsible,
            scopeId:         record.scopeId          || record.ScopeId,
            scopeName:       record.scopeName        || record.ScopeName,
            status:          record.status           || record.Status,
            statusText:      record.statusText       || record.StatusText,
            timeZone:        record.timeZone         || record.TimeZone,
            timestamp:       record.timestamp        || record.Timestamp,
            timestampFormat: record.timestampFormat  || record.TimestampFormat,
            week:            record.week             || record.Week,
            workstream:      record.workstream       || record.Workstream,
            counter:         record.counter          ?? record.Counter
        });

        if (!fingerprintSet.has(fingerprint)) {
            fingerprintSet.add(fingerprint);
            unique.push(record);
        } else {
            log.debug(`[API] True duplicate removed: featureId=${record.featureId || record.FeatureId}`);
        }
    }

    const trueDuplicates = allRecords.length - unique.length;
    if (trueDuplicates > 0) {
        log.warn(`[API] Removed ${trueDuplicates} true duplicate record(s).`);
    } else {
        log.info(`[API] No duplicates found — all ${unique.length} records are unique.`);
    }

    const duration = Date.now() - t0;
    log.info(`[API] ── Fetch complete: ${unique.length} unique records` +
             ` across ${pagesFetched} page(s) in ${duration}ms ──`);

    return { records: unique, duration, pagesFetched };
}

// ─────────────────────────────────────────────
// Flexible field reader
// Handles both camelCase and PascalCase API responses
// ─────────────────────────────────────────────
function readField(record, camelName, pascalName, fallback = '') {
    const val = record[camelName] !== undefined ? record[camelName]
              : record[pascalName] !== undefined ? record[pascalName]
              : fallback;
    return val;
}

// ─────────────────────────────────────────────
// In-Memory Cache
// ─────────────────────────────────────────────
let inMemoryData = [];
let lastSyncTime = null;
let nextSyncTime = null;
let syncStatus   = 'PENDING';
let totalRecords = 0;
let totalPages   = 0;
let refreshTimer = null;

const REFRESH_MS = parseInt(process.env.REFRESH_INTERVAL_MS) || 300000;

// ─────────────────────────────────────────────
// Data Sync
// ─────────────────────────────────────────────
async function syncData(db) {
    const syncStart = new Date();
    log.info(`[SYNC] ════════════════════════════════════════`);
    log.info(`[SYNC] Starting sync at ${syncStart.toISOString()}`);
    syncStatus = 'RUNNING';

    try {
        const { records, duration, pagesFetched } = await fetchFromDatasphere();

        log.info(`[SYNC] Records returned from fetchFromDatasphere: ${records.length}`);

        if (!records || records.length === 0) {
            log.warn('[SYNC] API returned 0 records after processing. Cache unchanged.');
            syncStatus = 'SUCCESS';
            return;
        }

        // ── Map API fields → CDS entity fields ───────────────────
        log.info(`[SYNC] Mapping ${records.length} records to CDS entity fields...`);

        const mapped = records.map((r, idx) => {
            const featureId = readField(r, 'featureId', 'FeatureId', null);

            if (!featureId) {
                log.warn(`[SYNC] Record[${idx}] has no featureId. Available keys: ${Object.keys(r).join(', ')}`);
                return null;
            }

            return {
                featureId:       featureId,
                date:            readField(r, 'date',            'Date',            ''),
                dayOfWeek:       readField(r, 'dayOfWeek',       'DayOfWeek',       ''),
                featureName:     readField(r, 'featureName',     'FeatureName',     ''),
                firstWeekDay:    readField(r, 'firstWeekDay',    'FirstWeekDay',    ''),
                period:          readField(r, 'period',          'Period',          ''),
                priority:        readField(r, 'priority',        'Priority',        ''),
                projectId:       readField(r, 'projectId',       'ProjectId',       ''),
                projectName:     readField(r, 'projectName',     'ProjectName',     ''),
                release:         readField(r, 'release',         'Release',         null),
                requirementId:   readField(r, 'requirementId',   'RequirementId',   null),
                requirementName: readField(r, 'requirementName', 'RequirementName', null),
                resolution:      readField(r, 'resolution',      'Resolution',      ''),
                responsible:     readField(r, 'responsible',     'Responsible',     null),
                scopeId:         readField(r, 'scopeId',         'ScopeId',         ''),
                scopeName:       readField(r, 'scopeName',       'ScopeName',       null),
                status:          readField(r, 'status',          'Status',          ''),
                statusText:      readField(r, 'statusText',      'StatusText',      ''),
                timeZone:        readField(r, 'timeZone',        'TimeZone',        ''),
                timestamp:       readField(r, 'timestamp',       'Timestamp',       ''),
                timestampFormat: readField(r, 'timestampFormat', 'TimestampFormat', ''),
                week:            readField(r, 'week',            'Week',            ''),
                workstream:      readField(r, 'workstream',      'Workstream',      ''),
                counter:         readField(r, 'counter',         'Counter',         0),
                lastRefreshed:   syncStart
            };
        }).filter(r => r !== null);

        log.info(`[SYNC] Mapped ${mapped.length} valid records` +
                 ` (${records.length - mapped.length} skipped due to missing featureId).`);

        // ── Update in-memory cache ────────────────────────────────
        inMemoryData = mapped;
        totalRecords = mapped.length;
        totalPages   = pagesFetched;
        lastSyncTime = syncStart;
        nextSyncTime = new Date(syncStart.getTime() + REFRESH_MS);
        syncStatus   = 'SUCCESS';

        log.info(`[SYNC] ✅ In-memory cache updated: ${totalRecords} records across ${pagesFetched} page(s).`);
        log.info(`[SYNC] Next scheduled sync: ${nextSyncTime.toISOString()}`);
        log.info(`[SYNC] ════════════════════════════════════════`);

        // ── Persist to SQLite ─────────────────────────────────────
        if (db) {
            try {
                const { Feature_Analytic_Model, SyncLog } = db.entities('com.datasphere.featureanalytic');
                await db.run(DELETE.from(Feature_Analytic_Model));
                await db.run(INSERT.into(Feature_Analytic_Model).entries(mapped));
                await db.run(INSERT.into(SyncLog).entries({
                    id:           cds.utils.uuid(),
                    syncTime:     syncStart,
                    recordCount:  totalRecords,
                    status:       'SUCCESS',
                    errorMessage: null,
                    duration:     duration,
                    pagesFetched: pagesFetched
                }));
                log.info(`[SYNC] SQLite updated with ${totalRecords} records.`);
            } catch (dbErr) {
                log.warn(`[SYNC] SQLite write failed (in-memory cache still valid): ${dbErr.message}`);
            }
        }

    } catch (err) {
        syncStatus = 'FAILED';
        log.error(`[SYNC] ❌ Failed: ${err.message}`);

        if (db) {
            try {
                const { SyncLog } = db.entities('com.datasphere.featureanalytic');
                await db.run(INSERT.into(SyncLog).entries({
                    id:           cds.utils.uuid(),
                    syncTime:     syncStart,
                    recordCount:  0,
                    status:       'FAILED',
                    errorMessage: err.message.substring(0, 1000),
                    duration:     Date.now() - syncStart.getTime(),
                    pagesFetched: 0
                }));
            } catch (logErr) {
                log.error(`[SYNC] Could not write failure log: ${logErr.message}`);
            }
        }
    }
}

function startAutoRefresh(db) {
    if (refreshTimer) clearInterval(refreshTimer);

    log.info(`[TIMER] Auto-refresh every ${REFRESH_MS / 60000} minutes.`);

    syncData(db).catch(e => log.error(`[TIMER] Initial sync error: ${e.message}`));

    refreshTimer = setInterval(() => {
        log.info('[TIMER] Scheduled refresh triggered.');
        syncData(db).catch(e => log.error(`[TIMER] Scheduled sync error: ${e.message}`));
    }, REFRESH_MS);

    process.on('SIGTERM', () => { clearInterval(refreshTimer); });
    process.on('SIGINT',  () => { clearInterval(refreshTimer); process.exit(0); });
}

// ─────────────────────────────────────────────
// CDS Service Handler
// ─────────────────────────────────────────────
module.exports = cds.service.impl(async function (srv) {

    const db = await cds.connect.to('db');

    startAutoRefresh(db);

    // ── READ: Feature_Analytic_Model ──────────────────────────────
    srv.on('READ', 'Feature_Analytic_Model', async (req) => {
        try {
            log.info(`[READ] Feature_Analytic_Model — cache size: ${inMemoryData.length} records`);

            if (inMemoryData.length > 0) {
                let result = [...inMemoryData];

                const skip = req.query?.SELECT?.limit?.offset?.val;
                if (skip && skip > 0) result = result.slice(skip);

                const top = req.query?.SELECT?.limit?.rows?.val;
                if (top && top > 0) result = result.slice(0, top);

                result['$count'] = inMemoryData.length;

                log.info(`[READ] Returning ${result.length} records (total in cache: ${inMemoryData.length})`);
                return result;
            }

            log.warn('[READ] In-memory cache empty — falling back to SQLite.');
            return await db.run(req.query);

        } catch (err) {
            log.error(`[READ] Error: ${err.message}`);
            req.error(500, `Failed to read data: ${err.message}`);
        }
    });

    // ── READ: SyncLog ─────────────────────────────────────────────
    srv.on('READ', 'SyncLog', async (req) => {
        try {
            return await db.run(req.query);
        } catch (err) {
            log.error(`[READ] SyncLog error: ${err.message}`);
            req.error(500, `Failed to read sync log: ${err.message}`);
        }
    });

    // ── ACTION: triggerRefresh ────────────────────────────────────
    srv.on('triggerRefresh', async (req) => {
        log.info('[ACTION] Manual refresh triggered.');
        try {
            await syncData(db);
            return {
                success:  true,
                message:  `Refreshed successfully. ${totalRecords} records loaded across ${totalPages} page(s).`,
                count:    totalRecords,
                pages:    totalPages,
                syncTime: lastSyncTime
            };
        } catch (err) {
            log.error(`[ACTION] Refresh failed: ${err.message}`);
            return {
                success:  false,
                message:  `Refresh failed: ${err.message}`,
                count:    0,
                pages:    0,
                syncTime: null
            };
        }
    });

    // ── FUNCTION: getSyncStatus ───────────────────────────────────
    srv.on('getSyncStatus', async (req) => {
        return {
            lastSync:     lastSyncTime,
            recordCount:  totalRecords,
            nextSync:     nextSyncTime,
            status:       syncStatus,
            pagesFetched: totalPages
        };
    });

    log.info('[SERVICE] FeatureAnalyticService initialized.');
});
