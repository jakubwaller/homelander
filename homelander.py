#!/usr/bin/env python3
"""
Homelander — IS24 auto-apply bot.

Polls Fredy for new Immoscout24 listings, drives real Chrome via CDP
to auto-send contact messages. Designed to run as a Hermes cron job
every 60 seconds.

Usage:
    python homelander.py                  # single run
    python homelander.py --dry-run        # detect only, don't send
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import requests
import websocket
import yaml

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent


def load_config() -> dict:
    """Load config from private/config.yaml."""
    config_path = SCRIPT_DIR / "private" / "config.yaml"
    if not config_path.exists():
        print("ERROR: private/config.yaml not found. Copy config.example.yaml and fill it in.")
        sys.exit(1)
    with open(config_path) as f:
        return yaml.safe_load(f)


# ---------------------------------------------------------------------------
# File lock (prevents concurrent runs)
# ---------------------------------------------------------------------------

LOCK_FILE = Path("/tmp/homelander.lock")
LOCK_STALE_SECONDS = 120


def acquire_lock() -> bool:
    """Create a lockfile with current PID. Returns True if lock acquired."""
    if LOCK_FILE.exists():
        try:
            stale_time = time.time() - LOCK_FILE.stat().st_mtime
            if stale_time < LOCK_STALE_SECONDS:
                old_pid = LOCK_FILE.read_text().strip()
                # Check if process is still alive
                try:
                    os.kill(int(old_pid), 0)
                    return False  # Process still running
                except (OSError, ValueError):
                    pass  # Process dead, steal lock
        except Exception:
            pass
    LOCK_FILE.write_text(str(os.getpid()))
    return True


def release_lock() -> None:
    """Remove the lockfile."""
    try:
        LOCK_FILE.unlink(missing_ok=True)
    except AttributeError:
        if LOCK_FILE.exists():
            LOCK_FILE.unlink()


# ---------------------------------------------------------------------------
# State management
# ---------------------------------------------------------------------------


def load_state(path: Path) -> dict:
    """Load seen_ids set and sent_at timestamps from JSON file."""
    if path.exists():
        with open(path) as f:
            data = json.load(f)
            data.setdefault("seen_ids", [])
            data.setdefault("sent_at", {})
            return data
    return {"seen_ids": [], "sent_at": {}}


def save_state(path: Path, state: dict) -> None:
    """Atomic write of state via tempfile + os.replace."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".is24_state_")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(state, f, indent=2)
        os.replace(tmp, path)
    except Exception:
        os.unlink(tmp)
        raise


def find_new_listings(listings: list[dict], state: dict) -> list[dict]:
    """Diff Fredy listings against seen_ids, return genuinely new ones."""
    seen = set(state["seen_ids"])
    return [l for l in listings if l["id"] not in seen]


# ---------------------------------------------------------------------------
# Fredy API client
# ---------------------------------------------------------------------------


class FredyClient:
    """Authenticate with Fredy and poll its listings API."""

    def __init__(self, base_url: str, username: str, password: str):
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.username = username
        self.password = password

    def login(self) -> None:
        """POST /api/login, store session cookie."""
        resp = self.session.post(
            f"{self.base_url}/api/login",
            json={"username": self.username, "password": self.password},
            timeout=10,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"AUTH_FAILED: HTTP {resp.status_code}")

    def get_listings(self, job_id: str, page_size: int = 20) -> list[dict]:
        """
        GET /api/listings/table?providerFilter=immoscout&page=1&pageSize=N
        Returns list of {id, title, price, link, address, job_id, ...},
        filtered to only the specified job_id.
        """
        all_listings = []
        page = 1
        while True:
            resp = self.session.get(
                f"{self.base_url}/api/listings/table",
                params={
                    "providerFilter": "immoscout",
                    "page": page,
                    "pageSize": page_size,
                },
                timeout=10,
            )
            if resp.status_code != 200:
                raise RuntimeError(f"Fredy API returned HTTP {resp.status_code}")
            data = resp.json()
            results = data.get("result", [])
            all_listings.extend(results)
            if len(results) < page_size:
                break
            page += 1
        return [l for l in all_listings if l.get("job_id") == job_id]


# ---------------------------------------------------------------------------
# Chrome DevTools Protocol (CDP) sender
# ---------------------------------------------------------------------------


class CDPSender:
    """
    Drive an already-running Chrome instance via CDP (websocket).
    Chrome must be launched with --remote-debugging-port=<port>.
    """

    def __init__(self, cdp_port: int = 9222):
        self.cdp_port = cdp_port
        self.ws = None
        self._msg_id = 0
        self._pending_events: list[dict] = []

    def _next_id(self) -> int:
        self._msg_id += 1
        return self._msg_id

    def _send(self, method: str, params: dict | None = None, timeout: float = 15) -> dict:
        """Send a CDP command and wait for its response."""
        msg_id = self._next_id()
        payload = {"id": msg_id, "method": method, "params": params or {}}
        self.ws.send(json.dumps(payload))
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.ws.settimeout(max(0.1, deadline - time.time()))
            try:
                raw = self.ws.recv()
            except websocket.WebSocketTimeoutException:
                raise TimeoutError(f"CDP timeout waiting for {method} response")
            msg = json.loads(raw)
            if msg.get("id") == msg_id:
                if "error" in msg:
                    raise RuntimeError(f"CDP {method}: {msg['error']}")
                return msg.get("result", {})
            # Stash events for later retrieval
            if "method" in msg:
                self._pending_events.append(msg)
        raise TimeoutError(f"CDP timeout waiting for {method} response")

    def _wait_for_event(self, event_name: str, timeout: float = 30) -> dict:
        """Wait for a specific CDP event, consuming stashed events first."""
        # Check stashed events
        for i, evt in enumerate(self._pending_events):
            if evt.get("method") == event_name:
                return self._pending_events.pop(i)
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.ws.settimeout(max(0.1, deadline - time.time()))
            try:
                raw = self.ws.recv()
            except websocket.WebSocketTimeoutException:
                raise TimeoutError(f"CDP timeout waiting for event {event_name}")
            msg = json.loads(raw)
            if msg.get("method") == event_name:
                return msg
            if "method" in msg:
                self._pending_events.append(msg)
        raise TimeoutError(f"CDP timeout waiting for event {event_name}")

    def _evaluate(self, expression: str, timeout: float = 10) -> dict:
        """Run JavaScript in the page and return the result."""
        result = self._send(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True},
            timeout=timeout,
        )
        return result.get("result", {})

    def connect(self) -> None:
        """
        Connect to Chrome's CDP endpoint. Fails loudly if Chrome isn't running.
        """
        try:
            resp = requests.get(
                f"http://localhost:{self.cdp_port}/json", timeout=5
            )
            resp.raise_for_status()
        except requests.RequestException:
            raise RuntimeError(
                "CDP_FAILED — Chrome not running on "
                f"--remote-debugging-port={self.cdp_port}"
            )

        pages = resp.json()
        if not pages:
            raise RuntimeError("CDP_FAILED — no open tabs in Chrome")

        ws_url = pages[0].get("webSocketDebuggerUrl")
        if not ws_url:
            raise RuntimeError("CDP_FAILED — no debuggable page found")

        self.ws = websocket.create_connection(ws_url, timeout=10)
        # Enable Page domain to receive load events
        self._send("Page.enable")

    def navigate(self, expose_id: str) -> bool:
        """
        Navigate to /expose/{id}#/basicContact/email.
        Returns True on success, False if blocked.
        """
        url = f"https://www.immobilienscout24.de/expose/{expose_id}#/basicContact/email"
        self._send("Page.navigate", {"url": url})

        # Wait for page load
        try:
            self._wait_for_event("Page.loadEventFired", timeout=30)
        except TimeoutError:
            pass  # Page might have loaded before we started listening

        # Give the SPA a moment to render the contact form
        time.sleep(3)

        # Check for Datadome block
        result = self._evaluate("document.title || ''", timeout=5)
        title = result.get("value", "")
        if "Roboter" in title or "Sicherheitsprüfung" in title:
            return False

        # Also check body text for block signals
        result = self._evaluate(
            "document.body ? document.body.innerText.substring(0, 500) : ''",
            timeout=5,
        )
        body = result.get("value", "")
        if "Ich bin kein Roboter" in body:
            return False

        return True

    def has_contact_form(self, timeout: float = 10) -> bool:
        """Check if textarea exists on the page."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            result = self._evaluate(
                "!!document.querySelector('textarea, [role=\"textbox\"]')",
                timeout=5,
            )
            if result.get("value"):
                return True
            time.sleep(1)
        return False

    def type_message(self, text: str) -> None:
        """Type message into textarea with human-like delays."""
        # Focus the textarea
        self._evaluate(
            "const el = document.querySelector('textarea, [role=\"textbox\"]');"
            "if (el) { el.focus(); el.click(); }"
        )
        time.sleep(random.uniform(0.3, 0.8))

        for char in text:
            # Use Input.insertText for reliable character input
            self._send("Input.insertText", {"text": char})
            delay = random.uniform(0.05, 0.2)  # 50-200ms
            time.sleep(delay)

    def click_send(self) -> None:
        """Click the send button."""
        # Try multiple selectors for IS24's send button
        self._evaluate(
            "const btns = document.querySelectorAll('button');"
            "for (const b of btns) {"
            "  if (b.textContent.includes('senden') || "
            "      b.textContent.includes('Senden') || "
            "      b.textContent.includes('Anfrage') || "
            "      b.textContent.includes('abschicken')) {"
            "    b.click(); return true;"
            "  }"
            "}"
            "return false;"
        )

    def close(self) -> None:
        """Close WebSocket connection."""
        if self.ws:
            self.ws.close()
            self.ws = None


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def run(config: dict, dry_run: bool = False) -> None:
    """
    One full iteration:
    1. Acquire lock
    2. Auth with Fredy
    3. Poll listings (filtered by job_id)
    4. Diff against state
    5. For each new listing: navigate, check, type, send
    6. Print summary
    7. Release lock
    """
    if not acquire_lock():
        print("LOCKED — another instance is running")
        sys.exit(1)

    try:
        state_path = SCRIPT_DIR / config["state_file"]
        message_path = SCRIPT_DIR / config["message_file"]
        fredy_cfg = config["fredy"]
        chrome_cfg = config["chrome"]
        job_id = "dpe_Ik06j0d9eyvZxXdwI"

        state = load_state(state_path)
        message = message_path.read_text().strip()

        # Auth with Fredy
        fredy = FredyClient(
            fredy_cfg["base_url"],
            fredy_cfg["username"],
            fredy_cfg["password"],
        )
        try:
            fredy.login()
        except Exception as e:
            print(f"AUTH_FAILED — {e}")
            sys.exit(1)

        # Poll listings
        try:
            listings = fredy.get_listings(job_id)
        except Exception as e:
            print(f"FREDY_FAILED — {e}")
            sys.exit(1)

        new = find_new_listings(listings, state)
        if not new:
            return  # silent — nothing to do

        max_sends = config["polling"]["max_sends_per_run"]
        to_send = new[:max_sends]

        if dry_run:
            for listing in to_send:
                expose_id = listing["link"].rstrip("/").split("/")[-1]
                print(
                    f"DRY_RUN | {expose_id} | "
                    f"{listing.get('title', '?')} | "
                    f"{listing.get('price', '?')}€ | "
                    f"{listing.get('address', '?')}"
                )
            print(f"Done: {len(to_send)} would be sent")
            return

        # Connect to Chrome
        try:
            sender = CDPSender(cdp_port=chrome_cfg["cdp_port"])
            sender.connect()
        except Exception as e:
            print(f"CDP_FAILED — {e}")
            sys.exit(1)

        sent = 0
        skipped = 0
        blocked = 0

        try:
            for listing in to_send:
                fredy_id = listing["id"]
                expose_id = listing["link"].rstrip("/").split("/")[-1]

                # Pre-send delay (random 3-15s)
                time.sleep(random.uniform(3, 15))

                if not sender.navigate(expose_id):
                    print(f"BLOCKED | {expose_id}")
                    state["seen_ids"].append(fredy_id)
                    blocked += 1
                    continue

                if not sender.has_contact_form():
                    print(f"NO_FORM | {expose_id}")
                    state["seen_ids"].append(fredy_id)
                    skipped += 1
                    continue

                sender.type_message(message)
                sender.click_send()

                price = listing.get("price", "?")
                address = listing.get("address", "?")
                title = listing.get("title", "?")
                print(f"SENT | {expose_id} | {title} | {price}€ | {address}")

                state["seen_ids"].append(fredy_id)
                state["sent_at"][fredy_id] = time.time()
                save_state(state_path, state)
                sent += 1

                # Cooldown between sends
                if sent < len(to_send):
                    time.sleep(random.uniform(30, 120))
        finally:
            sender.close()

        print(f"Done: {sent} sent, {skipped} skipped, {blocked} blocked")

    finally:
        release_lock()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description="Homelander — IS24 auto-apply bot")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Detect new listings but don't send messages",
    )
    args = parser.parse_args()

    config = load_config()
    run(config, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
