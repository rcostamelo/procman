#!/usr/bin/env node
'use strict';

const { run } = require('../lib/cli');
const { EXIT_CODES } = require('../lib/constants');

run(process.argv.slice(2)).then(
  (code) => { process.exitCode = typeof code === 'number' ? code : EXIT_CODES.SUCCESS; },
  (err) => {
    process.stderr.write(`procman: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = EXIT_CODES.ERROR;
  }
);
