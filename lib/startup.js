'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { NAME } = require('./constants');
const { paths } = require('./paths');

/**
 * Boot integration: generate (and optionally install) a service unit that
 * brings the saved process list back after a reboot.
 *
 * Default is to PRINT the unit and the exact commands. Installing touches
 * /etc, so it only happens when explicitly asked for and the write succeeds;
 * we never shell out to sudo.
 */

const CLI = path.join(__dirname, '..', 'bin', `${NAME}.js`);

function generate({ platform = process.platform, home = paths().home, user = os.userInfo().username } = {}) {
  const node = process.execPath;
  const cli = CLI;

  if (platform === 'linux') {
    const name = `${NAME}-${user}`;
    const file = `/etc/systemd/system/${name}.service`;
    const content = [
      '[Unit]',
      `Description=${NAME} process manager (${home})`,
      'After=network.target',
      '',
      '[Service]',
      'Type=forking',
      `User=${user}`,
      `Environment=${NAME.toUpperCase()}_HOME=${home}`,
      `ExecStart=${node} ${cli} resurrect`,
      `ExecStop=${node} ${cli} kill`,
      'Restart=on-failure',
      'RestartSec=10',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      ''
    ].join('\n');
    return {
      platform,
      file,
      content,
      commands: [`sudo cp <generated> ${file}`, 'sudo systemctl daemon-reload', `sudo systemctl enable --now ${name}`]
    };
  }

  if (platform === 'darwin') {
    const name = `${NAME}.pm`;
    const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${name}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${name}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${cli}</string>
    <string>resurrect</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>${NAME.toUpperCase()}_HOME</key><string>${home}</string></dict>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
    return {
      platform,
      file,
      content,
      commands: ['launchctl load -w ' + file]
    };
  }

  return {
    platform,
    file: null,
    content: null,
    commands: [],
    message: `automatic startup is not implemented for platform "${platform}"; run "${NAME} resurrect" yourself or wrap it in a service`
  };
}

/**
 * Write the unit where it belongs. Returns the same shape as generate() plus
 * `installed` and, when it fails, a readable reason instead of a stack trace.
 */
function install(options = {}) {
  const result = generate(options);
  if (!result.file || !result.content) return Object.assign(result, { installed: false });

  try {
    fs.writeFileSync(result.file, result.content, { mode: 0o644 });
    return Object.assign(result, { installed: true });
  } catch (err) {
    return Object.assign(result, {
      installed: false,
      error: `${result.file} is not writable (${err.code}); run the printed commands with sudo`
    });
  }
}

module.exports = { generate, install, CLI };
