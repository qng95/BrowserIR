import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const [cliPath, capturePrefix] = process.argv.slice(2);
if (!cliPath || !capturePrefix) {
  process.stderr.write('capture-stdio requires a CLI path and capture prefix.\n');
  process.exitCode = 2;
} else {
  const capturePath = `${capturePrefix}.${process.pid}`;
  const child = spawn(process.execPath, [cliPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  process.stdin.pipe(child.stdin);
  child.stdout.on('data', (chunk) => {
    appendFileSync(capturePath, chunk);
    process.stdout.write(chunk);
  });

  const forward = (signal) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));
  process.stdin.once('end', () => child.stdin.end());
  child.once('exit', (code, signal) => {
    if (signal === 'SIGINT') process.exitCode = 130;
    else if (signal === 'SIGTERM') process.exitCode = 143;
    else process.exitCode = code ?? 1;
  });
}
