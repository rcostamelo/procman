'use strict';

const { NAME, ENV_PREFIX } = require('./constants');

/** Minimal printf-style substitution: %s, %d, %j (JSON), %% */
function substitute(template, args) {
  let index = 0;
  return String(template).replace(/%[sdj%]/g, (token) => {
    if (token === '%%') return '%';
    if (index >= args.length) return token;
    const value = args[index++];
    if (token === '%j') {
      try { return JSON.stringify(value); } catch (err) { return '[unserializable]'; }
    }
    return String(value);
  });
}

/** tiny debug logger: PROCMAN_DEBUG=1 ./bin/procman.js list */
function create(scope) {
  const enabled = !!process.env[`${ENV_PREFIX}_DEBUG`];
  return (template, ...args) => {
    if (!enabled) return;
    process.stderr.write(`[${NAME}:${scope}] ${substitute(template, args)}\n`);
  };
}

module.exports = create;
module.exports.substitute = substitute;
