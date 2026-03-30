/**
 * Simple structured logger
 * Replace with Winston if file-based logging is needed
 */

'use strict';

const LEVEL = process.env.LOG_LEVEL || 'info';
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function write(level, msg) {
    if (LEVELS[level] >= LEVELS[LEVEL]) {
        const ts = new Date().toISOString();
        const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        fn(`[${ts}] ${level.toUpperCase().padEnd(5)}: ${msg}`);
    }
}

module.exports = {
    debug: (m) => write('debug', m),
    info:  (m) => write('info',  m),
    warn:  (m) => write('warn',  m),
    error: (m) => write('error', m)
};
