'use strict';

// Prints what it received, then exits. Pair with --no-autorestart.
console.log(JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  proc_app_name: process.env.PROC_APP_NAME,
  proc_app_id: process.env.PROC_APP_ID,
  main_is_self: require.main && require.main.filename
}, null, 2));
