#!/usr/bin/env python3
"""Run a fresh, retained Sandstorm installation and an end-to-end profiling scenario."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import platform
import signal
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def sha256(file):
    with open(file, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--scenario', choices=['davros', 'latency'], default='davros')
    parser.add_argument('--davros', type=Path)
    parser.add_argument('--latency-app', type=Path, help='latency-test-app.spk')
    parser.add_argument('--latency-binary', type=Path, help='Matching latency-test-app executable for direct control')
    parser.add_argument('--requests', type=int, default=1000)
    parser.add_argument('--warmup', type=int, default=100)
    parser.add_argument('--repetitions', type=int, default=5)
    parser.add_argument('--concurrency', default='1,5,20')
    parser.add_argument('--cold-repetitions', type=int, default=5)
    parser.add_argument('--output', type=Path, required=True, help='New directory; never reused or deleted')
    parser.add_argument('--mode', choices=['baseline', 'js', 'native', 'both'], default='js')
    parser.add_argument('--port', type=int, default=9200, help='First of three consecutive ports (four for latency)')
    parser.add_argument('--chrome', type=Path, required=True, help='Chrome matching tests/node_modules chromedriver')
    args = parser.parse_args()
    args.bundle = args.bundle.resolve(strict=True)
    app = args.davros if args.scenario == 'davros' else args.latency_app
    if app is None:
        parser.error('--davros or --latency-app is required for the selected scenario')
    app = app.resolve(strict=True)
    latency_options = None
    if args.scenario == 'latency':
        if args.latency_binary is None:
            parser.error('--latency-binary is required for the direct-control measurement')
        args.latency_binary = args.latency_binary.resolve(strict=True)
        try:
            concurrency = [int(value) for value in args.concurrency.split(',')]
        except ValueError:
            parser.error('--concurrency must be comma-separated positive integers')
        if min([args.requests, args.warmup, args.repetitions, args.cold_repetitions] + concurrency) < 1:
            parser.error('Request counts, concurrency, and repetitions must be positive')
        latency_options = dict(requests=args.requests, warmup=args.warmup, repetitions=args.repetitions,
                               concurrency=concurrency, coldRepetitions=args.cold_repetitions,
                               directPort=args.port + 3)
    args.chrome = args.chrome.resolve(strict=True)
    output = args.output.resolve()
    if os.geteuid() == 0:
        parser.error('Run as your ordinary user; grant perf access separately when needed')
    for port in range(args.port, args.port + (4 if args.scenario == 'latency' else 3)):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', port))
    tests = ROOT / 'tests'
    driver = tests / 'node_modules/chromedriver/lib/chromedriver/chromedriver'
    nightwatch = tests / 'node_modules/.bin/nightwatch'
    if not driver.exists() or not nightwatch.exists():
        parser.error('Install tests dependencies first: cd tests && npm ci')
    if len(os.fsencode(output / 'sandstorm/var/profile/control.sock')) >= 108:
        parser.error('Output path is too long for the profiler Unix socket')
    if args.mode in ('native', 'both') and not shutil.which('perf'):
        parser.error('Native modes require perf on PATH')
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    downloads = output / 'downloads'
    downloads.mkdir()
    fixture = output / 'payload.bin'
    if args.scenario == 'davros':
        with fixture.open('wb') as stream:
            for _ in range(50):
                stream.write(os.urandom(1_000_000))
    instance = output / 'sandstorm'
    profile = instance / 'var/profile'
    js = args.mode in ('js', 'both')
    native = args.mode in ('native', 'both')
    manifest = dict(status='running', scenario=args.scenario, mode=args.mode, createdAt=time.time(), platform=platform.platform(),
                    bundle=str(args.bundle), bundleSha256=sha256(args.bundle),
                    app=str(app), appSha256=sha256(app), latencyOptions=latency_options,
                    revision=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                    nativeScope='Sandstorm launcher and descendants (user-space CPU)' if native else None)
    if args.scenario == 'davros':
        manifest.update(payloadBytes=fixture.stat().st_size, payloadSha256=sha256(fixture))
    else:
        manifest.update(latencyBinary=str(args.latency_binary), latencyBinarySha256=sha256(args.latency_binary))
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    source_files = ['server-profiler.js', 'meteor-bundle-main.js', 'tests/profiling/run.py',
                    'tests/profiling/davros.js', 'tests/profiling/perf-launch.py', 'tests/profiling/harness.js',
                    'tests/profiling/latency.js', 'tests/profiling/latency-client.js',
                    'tests/profiling/latency-app/server.c++', 'src/sandstorm/config.c++',
                    'src/sandstorm/config.h', 'src/sandstorm/run-bundle.c++']
    manifest['sourceHashes'] = {file: sha256(ROOT / file) for file in source_files}
    (output / 'source.diff').write_bytes(subprocess.check_output(['git', 'diff'], cwd=ROOT))
    env = dict(os.environ, OVERRIDE_SANDSTORM_DEFAULT_DIR=str(instance))
    perf = chrome_driver = None
    started = False
    try:
        with (output / 'install.log').open('w') as log:
            subprocess.run([str(ROOT / 'install.sh'), '-d', '-u', '-p', str(args.port), str(args.bundle)],
                           env=env, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)
        with (instance / 'sandstorm.conf').open('a') as config:
            config.write(f'\nIS_TESTING=true\nALLOW_DEV_ACCOUNTS=true\nUPDATE_CHANNEL=none\n'
                         f'BASE_URL=http://local.sandstorm.io:{args.port}\n'
                         f'WILDCARD_HOST=*.local.sandstorm.io:{args.port}\n'
                         f'PORT={args.port}\nMONGO_PORT={args.port + 1}\n'
                         f'SMTP_LISTEN_PORT={args.port + 2}\nPROFILE_SERVER={str(js).lower()}\n')
        startup_started_at = time.time()
        startup_monotonic_ns = time.monotonic_ns()
        start = time.monotonic()
        started = True
        if native:
            # perf follows forks, including the daemon and short-lived workers. Keep its workload
            # alive until shutdown so the launcher returning doesn't end the recording early.
            perf_log = (output / 'perf.log').open('w')
            perf = subprocess.Popen(['perf', 'record', '--clockid', 'mono', '-e', 'cpu-clock:u', '-F', '99',
                                     '--call-graph', 'dwarf', '-o', str(output / 'perf.data'),
                                     '--', sys.executable, str(ROOT / 'tests/profiling/perf-launch.py'),
                                     str(instance / 'sandstorm')], stdin=subprocess.PIPE,
                                    stdout=perf_log, stderr=subprocess.STDOUT)
        else:
            subprocess.run([str(instance / 'sandstorm'), 'start'], check=True)
        deadline = time.monotonic() + 180
        while True:
            if perf and perf.poll() is not None:
                raise RuntimeError('perf/launcher failed; see perf.log (check perf sampling permissions)')
            try:
                request = urllib.request.Request(f'http://127.0.0.1:{args.port}/apps',
                                                 headers={'Host': f'local.sandstorm.io:{args.port}'})
                with urllib.request.urlopen(request, timeout=2) as response:
                    ready = b'__meteor_runtime_config__' in response.read()
                if ready and (not js or (profile / 'control.sock').exists()):
                    break
            except (OSError, urllib.error.URLError):
                pass
            if time.monotonic() > deadline:
                raise TimeoutError('Sandstorm/profiler did not become ready; inspect sandstorm/var/log')
            time.sleep(0.1)
        (output / 'startup.json').write_text(json.dumps({'startedAtUnixSeconds': startup_started_at,
            'monotonicStartNs': str(startup_monotonic_ns), 'durationMs': (time.monotonic() - start) * 1000}))
        if js:
            connection = http.client.HTTPConnection('localhost', timeout=30)
            connection.sock = socket.socket(socket.AF_UNIX)
            connection.sock.settimeout(30)
            connection.sock.connect(str(profile / 'control.sock'))
            connection.request('POST', '/stop')
            response = connection.getresponse()
            body = response.read()
            if response.status != 200:
                raise RuntimeError(body.decode())
            connection.close()
        # Use a dedicated WebDriver port and config; don't mutate the normal suite's config.
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            driver_port = probe.getsockname()[1]
        config = json.loads((tests / 'nightwatch.json').read_text())
        config['src_folders'] = [str(ROOT / 'tests/profiling')]
        config['custom_commands_path'] = str(tests / 'commands')
        config['output_folder'] = str(output / 'reports')
        config['webdriver']['port'] = driver_port
        settings = config['test_settings']['default']
        settings['webdriver']['port'] = driver_port
        settings['launch_url'] = f'http://local.sandstorm.io:{args.port}'
        settings['screenshots']['path'] = str(output / 'screenshots')
        settings['desiredCapabilities']['goog:chromeOptions']['binary'] = str(args.chrome)
        settings['desiredCapabilities']['goog:chromeOptions']['prefs']['download.default_directory'] = str(downloads)
        settings['globals']['asyncHookTimeout'] = 300000
        config_path = output / 'nightwatch.json'
        config_path.write_text(json.dumps(config, indent=2))
        driver_log = (output / 'chromedriver.log').open('w')
        chrome_driver = subprocess.Popen([str(driver), f'--port={driver_port}'], stdout=driver_log,
                                         stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 15
        while True:
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{driver_port}/status', timeout=1).close()
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise TimeoutError('ChromeDriver did not start')
                time.sleep(0.1)
        env.update(E2E_PROFILE_OUTPUT=str(output), E2E_PROFILE_SOCKET=str(profile / 'control.sock') if js else '',
                   E2E_DAVROS_SPK=str(app), E2E_APP_SPK=str(app), E2E_SCENARIO=args.scenario)
        if latency_options:
            env.update(E2E_LATENCY_BINARY=str(args.latency_binary), E2E_LATENCY_OPTIONS=json.dumps(latency_options))
        with (output / 'scenario.log').open('w') as log:
            subprocess.run([str(nightwatch), '-c', str(config_path), '-e', 'default', '-t',
                            str(ROOT / f'tests/profiling/{args.scenario}.js')], cwd=tests, env=env,
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=1200)
        if perf and perf.poll() is not None:
            raise RuntimeError('perf exited during the scenario; see perf.log')
        manifest['status'] = 'passed'
    except BaseException as error:
        manifest.update(status='failed', error=str(error))
        raise
    finally:
        cleanup_errors = []
        def cleanup(label, action):
            try:
                action()
            except Exception as error:
                cleanup_errors.append(f'{label}: {error}')

        if chrome_driver:
            chrome_driver.terminate()
            cleanup('ChromeDriver', lambda: chrome_driver.wait(timeout=15))
            if chrome_driver.poll() is None:
                chrome_driver.kill()
                cleanup('ChromeDriver kill', lambda: chrome_driver.wait(timeout=5))
        if started:
            cleanup('Sandstorm stop', lambda: subprocess.run(
                [str(instance / 'sandstorm'), 'stop'], timeout=30, check=True))
        if perf and perf.poll() is None:
            perf.stdin.close()
            cleanup('perf flush', lambda: perf.wait(timeout=30))
            if perf.poll() is None:
                perf.kill()
                cleanup('perf kill', lambda: perf.wait(timeout=5))
        if perf and perf.returncode not in (None, 0):
            cleanup_errors.append(f'perf exited with status {perf.returncode}; see perf.log')
        if cleanup_errors:
            manifest.update(status='failed', cleanupErrors=cleanup_errors)
        (output / 'manifest.json').write_text(json.dumps(manifest, indent=2))
        print(f'Artifacts retained in {output}', flush=True)
        if cleanup_errors:
            raise RuntimeError('; '.join(cleanup_errors))


if __name__ == '__main__':
    def interrupted(signum, frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    main()
