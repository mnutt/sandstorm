#!/usr/bin/env python3
"""Launch the repo's meteor-testapp grain against a local Sandstorm server.

This is a small DDP/SockJS helper for the Lima Ubuntu test VM. It creates/logs
in a dev account, uploads tests/assets/meteor-testapp.spk, ensures the package
is installed, then calls newGrain() with the test app command.
"""

import argparse
import json
import queue
import random
import string
import sys
import threading
import time

import requests


class DdpError(Exception):
    pass


class SockJsDdp:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.session = requests.Session()
        self.sock_id = "".join(
            random.choice(string.ascii_lowercase + string.digits) for _ in range(8))
        self.incoming = queue.Queue()
        self.connected = threading.Event()
        self.reader_error = None
        self.next_id = 1
        self.collections = {}

    def start(self):
        url = f"{self.base}/sockjs/000/{self.sock_id}/eventsource"
        self.reader = threading.Thread(target=self._read_loop, args=(url,), daemon=True)
        self.reader.start()
        if not self.connected.wait(10):
            raise DdpError(f"Timed out opening SockJS session; reader_error={self.reader_error!r}")

        self.send({"msg": "connect", "version": "1", "support": ["1", "pre2", "pre1"]})
        self.wait_for(lambda m: m.get("msg") == "connected", timeout=10)

    def _read_loop(self, url):
        try:
            with self.session.get(url, stream=True, timeout=(5, None)) as response:
                response.raise_for_status()
                for raw_line in response.iter_lines(decode_unicode=True):
                    if raw_line is None:
                        continue

                    line = raw_line.strip()
                    if line.startswith("data: "):
                        line = line[6:]
                    if not line:
                        continue

                    if line == "o":
                        self.connected.set()
                    elif line == "h":
                        continue
                    elif line.startswith("a"):
                        for item in json.loads(line[1:]):
                            msg = json.loads(item)
                            self._record_collection_update(msg)
                            self.incoming.put(msg)
                    elif line.startswith("c"):
                        self.incoming.put({"msg": "closed", "raw": line})
                        return
                    else:
                        self.incoming.put({"msg": "unknown", "raw": line})
        except Exception as exc:
            self.reader_error = repr(exc)
            self.incoming.put({"msg": "reader-error", "error": repr(exc)})

    def _record_collection_update(self, msg):
        collection = msg.get("collection")
        doc_id = msg.get("id")
        if not collection or not doc_id:
            return

        docs = self.collections.setdefault(collection, {})
        if msg.get("msg") == "added":
            docs[doc_id] = dict(msg.get("fields", {}))
            docs[doc_id]["_id"] = doc_id
        elif msg.get("msg") == "changed":
            docs.setdefault(doc_id, {"_id": doc_id}).update(msg.get("fields", {}))
            for field in msg.get("cleared", []):
                docs[doc_id].pop(field, None)
        elif msg.get("msg") == "removed":
            docs.pop(doc_id, None)

    def send(self, msg):
        url = f"{self.base}/sockjs/000/{self.sock_id}/xhr_send"
        payload = json.dumps([json.dumps(msg, separators=(",", ":"))])
        response = self.session.post(
            url, data=payload, headers={"Content-Type": "application/json"}, timeout=10)
        response.raise_for_status()

    def wait_for(self, predicate, timeout=30):
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise DdpError("Timed out waiting for DDP message")

            msg = self.incoming.get(timeout=remaining)
            if msg.get("msg") == "reader-error":
                raise DdpError(msg["error"])
            if predicate(msg):
                return msg

    def call(self, method, params=None, timeout=60):
        call_id = str(self.next_id)
        self.next_id += 1
        self.send({"msg": "method", "method": method, "params": params or [], "id": call_id})
        result = self.wait_for(
            lambda m: m.get("msg") == "result" and m.get("id") == call_id,
            timeout=timeout)
        if "error" in result:
            raise DdpError(f"{method} failed: {result['error']}")
        return result.get("result")

    def sub(self, name, params=None, timeout=60):
        sub_id = str(self.next_id)
        self.next_id += 1
        self.send({"msg": "sub", "name": name, "params": params or [], "id": sub_id})
        self.wait_for(
            lambda m: m.get("msg") == "ready" and sub_id in m.get("subs", []),
            timeout=timeout)
        return sub_id


def find_linked_account(ddp, credential_id):
    ddp.sub("accountsOfCredential", [credential_id], timeout=30)
    deadline = time.time() + 30
    while time.time() < deadline:
        linked = ddp.collections.get("loginCredentialsOfLinkedAccounts", {}).get(credential_id)
        if linked and linked.get("loginAccountId"):
            return linked["loginAccountId"]
        time.sleep(0.2)

    raise DdpError("could not find account linked to credential")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://local.sandstorm.org:6080")
    parser.add_argument("--spk", default="/home/michael/src/sandstorm/tests/assets/meteor-testapp.spk")
    args = parser.parse_args()

    ddp = SockJsDdp(args.base)
    print("connecting")
    ddp.start()

    print("creating dev credential")
    login = ddp.call("createDevAccount", [
        "CLI Grain Launcher",
        True,
        {"name": "CLI Grain Launcher", "handle": "cli_grain_launcher", "pronoun": "neutral"},
        "cli-grain-launcher@example.com",
    ])
    credential_id = login.get("id") if isinstance(login, dict) else login
    print("credential_user_id", credential_id)

    try:
        account = ddp.call("createAccountForCredential", [])
        account_id = account.get("id") if isinstance(account, dict) else account
        print("created_account", account_id)
    except DdpError as exc:
        if "already" not in str(exc):
            raise
        print("account_already_exists")
        account_id = find_linked_account(ddp, credential_id)

    print("logging_in_account", account_id)
    ddp.call("loginWithCredential", [account_id])

    print("requesting upload token")
    token = ddp.call("newUploadToken", [])
    print("upload_token", token)

    print("uploading_spk")
    with open(args.spk, "rb") as spk:
        response = requests.post(f"{args.base}/upload/{token}", data=spk, timeout=180)
    response.raise_for_status()
    package_id = response.text.strip()
    print("package_id", package_id)

    print("ensuring_installed")
    ddp.call("ensureInstalled", [package_id, None, False], timeout=60)

    command = {
        "argv": ["/sandstorm-http-bridge", "4000", "--", "node", "start.js"],
        "environ": [
            {"key": "PATH", "value": "/usr/local/bin:/usr/bin:/bin"},
            {"key": "SANDSTORM", "value": "1"},
        ],
    }
    title = "Untitled testapp instance"

    print("launching_grain", title)
    deadline = time.time() + 90
    while True:
        try:
            grain_id = ddp.call("newGrain", [package_id, command, title], timeout=120)
            break
        except DdpError as exc:
            if time.time() >= deadline or (
                    "No such package is installed" not in str(exc) and "manifest" not in str(exc)):
                raise
            time.sleep(1)

    print("grain_id", grain_id)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
