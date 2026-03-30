namespace com.datasphere.featureanalytic;

// ─────────────────────────────────────────────
// Main Feature Analytic Entity
// Matches the API payload structure exactly
// ─────────────────────────────────────────────
entity Feature_Analytic_Model {
    key featureId        : String(50);
        date             : String(20);
        dayOfWeek        : String(5);
        featureName      : String(500);
        firstWeekDay     : String(5);
        period           : String(10);
        priority         : String(50);
        projectId        : String(100);
        projectName      : String(500);
        release          : String(200);
        requirementId    : String(100);
        requirementName  : String(500);
        resolution       : String(10);
        responsible      : String(200);
        scopeId          : String(100);
        scopeName        : String(500);
        status           : String(50);
        statusText       : String(100);
        timeZone         : String(10);
        timestamp        : String(30);
        timestampFormat  : String(10);
        week             : String(10);
        workstream       : String(200);
        counter          : Integer;
        lastRefreshed    : Timestamp;
}

// ─────────────────────────────────────────────
// Sync Log Entity - tracks each data refresh
// ─────────────────────────────────────────────
entity SyncLog {
    key id           : UUID;
        syncTime     : Timestamp;
        recordCount  : Integer;
        status       : String(20);   // SUCCESS | FAILED
        errorMessage : String(1000);
        duration     : Integer;      // milliseconds
}
