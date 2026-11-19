import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

export async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(deadline); }
}

export async function start(binary, args, env, ready) {
  const child = spawn(fileURLToPath(new URL(`../../target/${binary}`, import.meta.url)), args, {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  try {
    const match = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`Startup timeout: ${output}`)), 5000);
      const finish = (error, match) => {
        clearTimeout(deadline);
        child.off('error', onError);
        child.off('exit', onExit);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        error ? reject(error) : resolve(match);
      };
      const onError = (error) => finish(error);
      const onExit = (code) => finish(new Error(`Exited ${code}: ${output}`));
      const onData = (data) => {
        output = (output + data).slice(-8192);
        const match = output.match(ready);
        if (match) finish(null, match);
      };
      child.once('error', onError);
      child.once('exit', onExit);
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
    });
    // Drain diagnostics after startup as well; never let the pipe block a child.
    child.stdout.resume();
    child.stderr.resume();
    return { child, match };
  } catch (error) { await stop(child); throw error; }
}

export async function serveProbe(page, source, url) {
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    write: false, lib: { entry: fileURLToPath(new URL(source, import.meta.url)), formats: ['es'] },
  } });
  const code = bundle[0].output.find((item) => item.type === 'chunk').code;
  await page.route(`**/${url}`, (route) => route.fulfill({ contentType: 'text/javascript', body: code }));
}

export async function availablePort() {
  // Vite treats port 0 as its default, so reserve an OS-selected port first.
  const { createServer } = await import('node:net');
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
