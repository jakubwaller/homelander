#!/usr/bin/env python3
"""
Homelander — IS24 auto-apply bot.

Polls Fredy for new Immoscout24 listings, drives real Chrome via CDP
to auto-send contact messages. Designed to run as a Hermes cron job
every 60 seconds.

Architecture:
    Fredy (VPS)  ←── poll ──  homelander.py (Mac)  ── CDP ──→  Chrome (real profile)
    detection                  diff + send                         residential IP

Usage:
    python homelander.py                  # single run
    python homelander.py --dry-run        # detect only, don't send
"""

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
import yaml

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_CONFIG = Path("config.example.yaml")
USER_CONFIG = Path("private/config.yaml")
STATE_FILE = Path("private/is24_state.json")
LOCK_FILE = Path("/tmp/homelander.lock")
LOCK_STALE_SECONDS = 120


def load_config() -> dict[str, Any]:
    """Load config from private/config.yaml, falling back to config.example.yaml."""
    ...


# ---------------------------------------------------------------------------
# File lock (prevents concurrent runs)
# ---------------------------------------------------------------------------


def acquire_lock() -> bool:
    """
    Create a lockfile with current PID.
    If lockfile exists and PID is still alive, fail.
    If lockfile exists but PID is dead (stale > LOCK_STALE_SECONDS), steal it.
    Returns True if lock acquired.
    """
    ...


def release_lock() -> None:
    """Remove the lockfile."""
    ...


# ---------------------------------------------------------------------------
# State management
# ---------------------------------------------------------------------------


def load_state(path: Path) -> dict[str, Any]:
    """Load seen_ids set and sent_at timestamps from JSON file."""
    ...


def save_state(path: Path, state: dict[str, Any]) -> None:
    """Atomic write of state via tempfile + os.replace."""
    ...


def find_new_listings(
    listings: list[dict], state: dict[str, Any]
) -> list[dict]:
    """Diff Fredy listings against seen_ids, return genuinely new ones."""
    ...


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
        ...

    def get_listings(
        self, provider: str = "immoscout", page_size: int = 20
    ) -> list[dict]:
        """
        GET /api/listings/table?providerFilter=immoscout&page=1&pageSize=20
        Returns list of {id, title, price, link, address}.
        """
        ...


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

    def connect(self) -> None:
        """
        GET http://localhost:<port>/json → find the page WebSocket URL.
        Connect to it. Fail loudly if Chrome isn't running on this port.
        """
        ...

    def navigate(self, expose_id: str) -> bool:
        """
        Navigate to /expose/{id}#/basicContact/email.
        Returns False if blocked (401, "Roboter", "Sicherheitsprüfung").
        """
        ...

    def has_contact_form(self, timeout: float = 10.0) -> bool:
        """Check if textarea + send button exist on the page."""
        ...

    def type_message(self, text: str) -> None:
        """Type message into textarea with human-like delays (50-200ms/char)."""
        ...

    def click_send(self) -> None:
        """Click the 'Anfrage senden' button."""
        ...

    def close(self) -> None:
        """Close WebSocket connection."""
        ...


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def run(config: dict[str, Any], dry_run: bool = False) -> None:
    """
    One full iteration:
    1. Acquire lock
    2. Auth with Fredy
    3. Poll listings
    4. Diff against state
    5. For each new listing: navigate, check, type, send
    6. Print summary
    7. Release lock
    """
    if not acquire_lock():
        print("LOCKED — another instance is running")
        sys.exit(1)

    try:
        state = load_state(STATE_FILE)

        fredy = FredyClient(
            config["fredy"]["base_url"],
            config["fredy"]["username"],
            config["fredy"]["password"],
        )
        fredy.login()
        listings = fredy.get_listings()

        new = find_new_listings(listings, state)
        if not new:
            return  # silent — nothing to do

        max_sends = config["polling"]["max_sends_per_run"]
        to_send = new[:max_sends]

        sender = CDPSender(cdp_port=config["chrome"]["cdp_port"])
        sender.connect()

        message = Path(config["message_file"]).read_text().strip()

        sent = 0
        skipped = 0
        blocked = 0

        for listing in to_send:
            expose_id = listing["id"]

            if not sender.navigate(expose_id):
                print(f"BLOCKED | {expose_id}")
                state["seen_ids"].add(expose_id)
                blocked += 1
                continue

            if not sender.has_contact_form():
                print(f"NO_FORM | {expose_id}")
                state["seen_ids"].add(expose_id)
                skipped += 1
                continue

            pre_delay = random.uniform(3, 15)
            time.sleep(pre_delay)

            sender.type_message(message)
            sender.click_send()

            price = listing.get("price", "?")
            address = listing.get("address", "?")
            print(f"SENT | {expose_id} | {listing.get('title', '?')} | {price}€ | {address}")

            state["seen_ids"].add(expose_id)
            state["sent_at"][expose_id] = time.time()
            save_state(STATE_FILE, state)
            sent += 1

            if sent < len(to_send):
                cooldown = random.uniform(30, 120)
                time.sleep(cooldown)

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
    parser.add_argument(
        "--config",
        default=None,
        help="Path to config file (default: private/config.yaml)",
    )
    args = parser.parse_args()

    config = load_config()
    run(config, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
