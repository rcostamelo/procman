'use strict';

// Spawns a long-lived child, then idles. Used to prove that stopping a managed
// process also kills its descendants (not just the pid we know about).
const { spawn } = require('child_process');

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  detached: false
});

console.log(`spawner pid=${process.pid} child pid=${child.pid}`);
setInterval(() => {}, 1000);
