'use strict';

const path = require('path');

/**
 * Start options are resolved on the CALLER side, never in the daemon.
 *
 * Why: the daemon runs with cwd = the state home, so a relative script path or
 * cwd would resolve against the wrong directory. The caller knows its own cwd,
 * so it converts everything to absolute paths before sending the request.
 */
function normalizeStart(params, baseCwd, { requireScript = true } = {}) {
  const base = baseCwd || process.cwd();
  if (!params || (requireScript && !params.script)) {
    const err = new Error('start requires a script path');
    err.code = 'INVALID_ARGUMENT';
    throw err;
  }

  const out = Object.assign({}, params);
  if (params.script) out.script = path.resolve(base, params.script);
  out.cwd = params.cwd ? path.resolve(base, params.cwd) : base;
  if (params.output) out.output = path.resolve(base, params.output);
  if (params.error) out.error = path.resolve(base, params.error);
  if (Array.isArray(params.watchPaths)) {
    out.watchPaths = params.watchPaths.map((p) => path.resolve(base, p));
  }
  if (Array.isArray(params.args)) out.args = params.args.map(String);
  return out;
}

module.exports = { normalizeStart };
