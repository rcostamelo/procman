'use strict';

// Example that fails fast, used to exercise the restart budget.
console.error('crash.js: failing on purpose at ' + new Date().toISOString());
process.exit(1);
