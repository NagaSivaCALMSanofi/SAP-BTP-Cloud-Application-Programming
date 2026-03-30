using com.datasphere.featureanalytic as db from '../db/schema';

// ─────────────────────────────────────────────
// Feature Analytic OData Service
// Exposed at /odata/v4/FeatureAnalyticService
// ─────────────────────────────────────────────
service FeatureAnalyticService @(path: '/odata/v4/FeatureAnalyticService') {

    // ── Main data entity - read-only ──────────
    @readonly
    entity Feature_Analytic_Model as projection on db.Feature_Analytic_Model;

    // ── Sync log for monitoring ───────────────
    @readonly
    entity SyncLog as projection on db.SyncLog;

    // ── Action: manually trigger data refresh ─
    action triggerRefresh() returns {
        success  : Boolean;
        message  : String;
        count    : Integer;
        syncTime : Timestamp;
    };

    // ── Function: get current sync status ─────
    function getSyncStatus() returns {
        lastSync    : Timestamp;
        recordCount : Integer;
        nextSync    : Timestamp;
        status      : String;
    };
}