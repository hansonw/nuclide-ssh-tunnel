'use babel';

import child_process from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Remote host to connect to.
const hostname = 'localhost';
// Remote path to open in Nuclide.
const cwd = path.normalize('~');
// Path to the nuclide-start-server script.
// If you `npm install -g nuclide-start-server`,
// this should just be "nuclide-start-server".
const startServerScript = path.normalize(
  '~/.atom/packages/nuclide/pkg/nuclide-server/nuclide-start-server',
);
// Local port of the SSH tunnel.
const localPort = 1234;
// Actual Nuclide server port.
const remotePort = 8888;

// Placeholder for tunnel process.
let tunnel = null;

export function activate() {
  // Package load entry point.
  // Note that we have to wait for the Nuclide remote projects service anyway.
}

export function deactivate() {
  // Clean up the tunnel when Atom exits.
  if (tunnel != null) {
    tunnel.kill();
  }
}

export function consumeRemoteProjectsService(service) {
  const prompt = atom.notifications.addSuccess(
    'Start Connection',
    {
      description: 'Start the SSH tunnel connection?',
      dismissable: true,
      icon: 'plug',
      buttons: [
        {
          text: 'Go!',
          className: 'icon-check',
          onDidClick: () => {
            prompt.dismiss();
            startConnection(service);
          },
        },
      ],
    },
  );
}

function startConnection(service) {
  const notification = atom.notifications.addInfo(
    'Starting SSH connection...',
    {dismissable: true},
  );

  // Use a predetermined scratch file for certificate exchange.
  // We don't just use the stdout because that can be flaky.
  const hash = crypto.randomBytes(16).toString('hex');
  const jsonOutputPath = `/tmp/nuclide-ssh-handshake-${hash}`;

  child_process.execFile('ssh', [
    hostname,
    '--',
    startServerScript,
    '--timeout',
    '60',
    '--port',
    remotePort.toString(),
    // If you don't need HTTPS authentication, just use '-k' and ignore the rest.
    // '-k',

    // Otherwise, we have to obtain the certificates via SFTP.
    // Since we're connecting to localhost (and tunneling).
    '--common-name',
    'localhost',
    // Certificate info is written to this file, which we can then SCP over.
    '--json-output-file',
    jsonOutputPath,
    // The actual certificates are generated here.
    '--certs-dir',
    '/tmp',
  ], (error, stdout, stderr) => {
    notification.dismiss();
    if (error != null) {
      atom.notifications.addError(
        'Error establishing SSH connection',
        {
          description: String(error),
          detail: `stdout: ${stdout}\nstderr: ${stderr}`,
        },
      );
    } else {
      createConnection(service, jsonOutputPath);
    }
  });
}

function createConnection(service, jsonOutputPath) {
  // Can be omitted if "-k" is used.
  getCertificates(hostname, jsonOutputPath)
    .then(config => {
      // Create a tunnel for the server port.
      tunnel = child_process.spawn('ssh', [
        '-L',
        `${localPort}:${hostname}:${remotePort}`,
        hostname,
        '-N',
      ]);

      service
        .findOrCreate({
          host: hostname, // host nuclide server is running on.
          port: localPort, // port to connect to.
          cwd,
          displayTitle: 'SSH Tunnel', // Name to display in the file tree.
          ...config,
        })
        .then(() => {
          atom.notifications.addSuccess('Connection successful!');
        })
        .catch(e => {
          atom.notifications.addError('Failed to establish connection!', {
            detail: e.message,
          });
        });
    })
    .catch(err => {
      atom.notifications.addError(
        'Error fetching certificates!',
        {detail: String(err)},
      );
    });
}

function getCertificates(hostname, jsonOutputPath) {
  atom.notifications.addInfo('Fetching certificates...');
  return new Promise((resolve, reject) => {
    child_process
      .execFile(
        'scp',
        ['-q', `${hostname}:${jsonOutputPath}`, '/dev/stdout'],
        (error, stdout, stderr) => {
          if (error != null) {
            return reject(error);
          }
          const json = JSON.parse(stdout.toString());
          if (json.success) {
            resolve({
              certificateAuthorityCertificate: json.ca,
              clientCertificate: json.cert,
              clientKey: json.key,
            });
          } else {
            reject(new Error(`Failed to start server: ${output}`));
          }
        },
      );
  });
}
