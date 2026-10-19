'use strict';

// Allocates 8 MB every 120 ms, forever. Used to exercise --max-memory-restart.
const chunks = [];
setInterval(() => {
  chunks.push(Buffer.alloc(8 * 1024 * 1024, 1));
  console.log(`allocated ${chunks.length * 8} MB (pid ${process.pid})`);
}, 120);
