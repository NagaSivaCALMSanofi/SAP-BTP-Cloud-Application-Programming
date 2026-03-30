/**
 * SAP Datasphere API Client (standalone module)
 *
 * ⚠️  API Constraint:
 *     Only $format=json is supported. $top and other OData
 *     query options are rejected with HTTP 400.
 */

'use strict';

const axios = require('axios');
const qs    = require('qs');

let tokenCache = { accessToken: null, expiresAt: null, tokenType: 'Bearer' };

async function fetchNewToken() {
    const response = await axios.post(
        process.env.OAUTH_TOKEN_URL,
        qs.stringify({
            grant_type:    'client_credentials',
            client_id:     process.env.OAUTH_CLIENT_ID,
            client_secret: process.env.OAUTH_CLIENT_SECRET
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
    );
    const { access_token, expires_in, token_type } = response.data;
    tokenCache = {
        accessToken: access_token,
        expiresAt:   new Date(Date.now() + (expires_in - 60) * 1000),
        tokenType:   token_type || 'Bearer'
    };
    return tokenCache.accessToken;
}

async function getValidToken() {
    if (tokenCache.accessToken && new Date() < tokenCache.expiresAt) return tokenCache.accessToken;
    return fetchNewToken();
}

/**
 * Fetch the full dataset — no $top, only $format=json
 */
async function fetchFeatureAnalyticData() {
    const url   = `${process.env.DATASPHERE_BASE_URL}${process.env.DATASPHERE_API_PATH}`;
    const token = await getValidToken();
    const res   = await axios.get(url, {
        params:  { '$format': 'json' },   // ← only supported param
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        timeout: 120000
    });
    return res.data?.value || [];
}

module.exports = { fetchFeatureAnalyticData, getValidToken, fetchNewToken };