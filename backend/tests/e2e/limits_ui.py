"""Madar resource-limits UI E2E (Playwright, against the running 127.0.0.1:3000).

Bootstrap: because the real admin account has TOTP (the UI login route always
steps through the authenticator for the FIRST user, see user-store.isTotpEnabled()),
this script forges a fully-valid admin-session JWT with the repo JWT_SECRET —
the same trick backend helpers.ts already uses — and injects it into the
browser as localStorage['wsd.token'] BEFORE first paint (matches auth.tsx's
read-on-boot check, which validates it through GET /api/auth/status).

Covers the Resource-limits feature end to end:
 1. New Project modal exposes CPU + Memory limit inputs
 2. create-with-limits applies the cap immediately (no pending recreate)
 3. Editing limits (meta-first) surfaces the honest "Recreate to apply" banner
 4. Blank save removes the limits (no pending recreate) — 'Saved. Limits removed.'
 5. CPU/RAM meta-chips render on the Projects, Dashboard and Planner cards
 Cleanup: every e2e-* project is deleted before and after the run.

Run (host, container must be up):
    python backend/tests/e2e/limits_ui.py
Exit codes: 0 = all checks passed, 1 = failures, 42 = skipped (no reachable server).
"""
import os
import random
import re
import sys
import time

import jwt
import requests
from playwright.sync_api import sync_playwright


def _base() -> str:
    return os.environ.get("WSD_E2E_BASE", "http://127.0.0.1:3000").rstrip("/")


def _secret() -> str:
    env_secret = os.environ.get("WSD_JWT_SECRET", "").strip()
    if env_secret:
        return env_secret
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")
    for name in (".env", ".env.local"):
        path = os.path.join(root, name)
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("JWT_SECRET=") and not line.startswith("#"):
                    return line.split("=", 1)[1].strip().strip('"')
    return os.environ.get("JWT_SECRET", "").strip()


def _token_for(user_id: str, username: str, role: str, tv: int, secret: str) -> str:
    return jwt.encode(
        {"id": user_id, "username": username, "role": role, "tv": tv, "jti": "e2e-browser"},
        secret,
        algorithm="HS256",
    )


def _api(path: str, method: str = "GET", body=None, token: str | None = None, timeout: int = 60):
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.request(method, f"{_base()}/api{path}", json=body, headers=headers, timeout=timeout)


def _find_admin():
    """Return (id, username) of the real admin via the API (needs only a validly signed token)."""
    probe = _token_for("e2e-unknown-probe", "probe", "admin", 0, _secret())
    res = _api("/auth/status", token=probe)
    if res.status_code != 200:
        raise SystemExit(f"server not healthy: {res.status_code} {res.text[:200]}")
    data = res.json()
    if not data.get("hasUser"):
        raise SystemExit("no user configured in the server — run setup first")
    lst = _api("/users", token=probe)
    if lst.status_code != 200:
        raise SystemExit(f"could not list users: {lst.status_code} {lst.text[:200]}")
    for u in lst.json() or []:
        if u.get("role") == "admin":
            return u["id"], u["username"]
    raise SystemExit("no admin user found")


def _cleanup(token: str) -> None:
    res = _api("/projects", token=token)
    if res.status_code != 200:
        return
    for p in res.json().get("projects") or []:
        if p.get("slug", "").startswith("e2e-"):
            _api(f"/projects/{p['slug']}", method="DELETE", token=token)


def _project(token: str, slug: str) -> dict:
    res = _api(f"/projects/{slug}", token=token)
    if res.status_code != 200:
        return {}
    return res.json().get("project") or {}


def _wait_limits(token: str, slug: str, want: dict, timeout: float = 15.0) -> bool:
    """Poll the project meta until its limits equal the wanted subset (or timeout)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        lims = _project(token, slug).get("limits") or {}
        if all(lims.get(k) == v for k, v in want.items()):
            return True
        time.sleep(0.5)
    return False


def _create_via_modal(pg, name: str, ports: list[str], cpu: str, mem: str) -> bool:
    """Fill the New Project modal and submit; returns True when we navigated into the project."""
    for port in ports:
        pg.locator('input[placeholder="Project name"]').fill(name)
        pg.locator('input[placeholder*="CPU limit"]').fill(cpu)
        pg.locator('input[placeholder*="Memory limit"]').fill(mem)
        if port:
            pg.locator('input[placeholder*="Ports (optional, defaults to 8000)"]').fill(port)
        pg.locator('button', has_text='Create').first.click()
        try:
            pg.wait_for_url(re.compile(re.escape(f"#/project/{name}")), timeout=20000)
            return True
        except Exception:  # noqa: BLE001
            modal_err = pg.locator('.login-error')
            text = modal_err.nth(0).inner_text() if modal_err.count() else ""
            # Retry on any port-level create rejection: conflict, and host-side
            # bind failures (Windows "excluded port range" gives a 500 with
            # 'ports are not available: exposing port ... bind').
            if "already in use" in text.lower() or "taken" in text.lower() or "ports are not available" in text.lower():
                print(f"  . port {port} unavailable ({text.strip()}), retrying with another")
                continue
            print(f"  . create failed: {text}")
            return False
    return False


def main() -> int:
    secret = _secret()
    if not secret:
        print("SKIP: JWT_SECRET not found in env or repo .env")
        return 42
    admin_id, admin_name = _find_admin()
    admin = _token_for(admin_id, admin_name, "admin", 0, secret)
    print(f". admin session forged for '{admin_name}'")

    _cleanup(admin)

    checks: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append((name, bool(ok), detail))
        print(("PASS " if ok else "FAIL ") + name + (f"  {detail}" if detail else ""))

    browser = None
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            init = f"localStorage.setItem('wsd.token', '{admin}');"

            # ── Signed-in session boots into the app ──
            pg = browser.new_page()
            pg.add_init_script(init)
            pg.goto(f"{_base()}/#/projects", wait_until="load")
            pg.wait_for_timeout(1200)
            land = pg.locator('button', has_text='+ New Project').count() == 1
            check("forged admin session boots the app (Projects toolbar visible)", land)
            pg.close()

            # ── 1 + 2: create with limits ──
            pg = browser.new_page()
            pg.add_init_script(init)
            pg.goto(f"{_base()}/#/projects", wait_until="load")
            pg.locator('button', has_text='+ New Project').first.wait_for(state='visible', timeout=10000)
            pg.locator('button', has_text='+ New Project').first.click()
            pg.locator('.create-title', has_text='New Project').first.wait_for(state='visible', timeout=5000)
            cpu_m = pg.locator('input[placeholder*="CPU limit"]')
            mem_m = pg.locator('input[placeholder*="Memory limit"]')
            check("create modal exposes CPU + Memory limit inputs",
                  cpu_m.count() == 1 and mem_m.count() == 1,
                  f"cpu={cpu_m.count()} mem={mem_m.count()}")

            created_ok = _create_via_modal(pg, "e2e-limited",
                                           [str(random.randint(20000, 49000)) for _ in range(5)],
                                           "1", "256Mi")
            check("create-with-limits navigates to the project page", created_ok)
            if not created_ok:
                raise SystemExit("create flow failed — aborting remaining UI checks")
            pg.wait_for_selector('.main', timeout=15000)

            persisted = _wait_limits(admin, "e2e-limited", {"cpu": "1", "memory": "256Mi"})
            check("created project stores cpu=1 + memory=256Mi immediately", persisted)

            live = _project(admin, "e2e-limited").get("liveLimits") or {}
            check("creation-time limits applied to the container at once",
                  live.get("cpu") == "1" and live.get("memory") == "256Mi", repr(live))

            pg.locator('input[placeholder*="blank = no limit"]').first.wait_for(state='visible', timeout=15000)
            check("project page shows the Resource-limits inputs", True)
            pg.close()

            # ── 3: edit → honest pending banner ──
            pg = browser.new_page()
            pg.add_init_script(init)
            pg.goto(f"{_base()}/#/project/e2e-limited", wait_until="load")
            pg.locator('input[placeholder*="CPU e.g."]').first.wait_for(state='visible', timeout=15000)
            pg.locator('input[placeholder*="CPU e.g."]').fill("2")
            pg.locator('button', has_text='Save limits').first.click()
            pg.get_by_text(re.compile("container still runs on", re.IGNORECASE)).first.wait_for(
                state='visible', timeout=15000)
            check("limits edit shows 'container still runs on … Recreate to apply' banner", True)

            # ── 4: blanking both fields removes the configured limits → still pending (cap live) ──
            pg.locator('input[placeholder*="CPU e.g."]').fill("")
            pg.locator('input[placeholder*="Memory e.g."]').fill("")
            pg.locator('button', has_text='Save limits').first.click()
            pg.wait_for_timeout(4000)
            # meta must end up without limits…
            removed = False
            deadline = time.time() + 15.0
            while time.time() < deadline:
                if not (_project(admin, "e2e-limited").get("limits") or {}):
                    removed = True
                    break
                time.sleep(0.4)
            check("blanking both fields removes limits from meta", bool(removed))
            # …and the honest banner persists until a recreate actually drops the cap
            banner_still = pg.get_by_text(re.compile("container still runs on", re.IGNORECASE)).count()
            check("removal keeps the pending 'Recreate to apply' banner (cap still live)",
                  banner_still >= 1, f"banners={banner_still}")
            pg.close()

            # ── 5: chips (set limits, then check the three overview surfaces) ──
            set_res = _api("/projects/e2e-limited/limits", method="PUT",
                           body={"cpu": "1", "memory": "256Mi"}, token=admin)
            now_set = _wait_limits(admin, "e2e-limited", {"cpu": "1", "memory": "256Mi"})
            check("re-set limits via API for the chip assertions",
                  set_res.status_code in (200, 201) and now_set)

            pg = browser.new_page()
            pg.add_init_script(init)
            pg.goto(f"{_base()}/#/projects", wait_until="load")
            pg.wait_for_timeout(1500)
            card = pg.locator('.project-card', has_text='e2e-limited').first
            cpu_chip = card.locator('.meta-chip', has_text=re.compile(r'^CPU ')).count()
            mem_chip = card.locator('.meta-chip', has_text=re.compile(r'^RAM ')).count()
            check("Projects card shows CPU + RAM meta-chips", cpu_chip == 1 and mem_chip == 1,
                  f"cpu={cpu_chip} ram={mem_chip}")
            pg.close()

            pg = browser.new_page()
            pg.add_init_script(init)
            pg.goto(f"{_base()}/#/", wait_until="load")
            pg.wait_for_timeout(1500)
            dcard = pg.locator('.project-card', has_text='e2e-limited').first
            check("Dashboard card shows the CPU meta-chip",
                  dcard.locator('.meta-chip', has_text=re.compile(r'^CPU ')).count() == 1)
            pg.close()

            pg = browser.new_page()
            pg.add_init_script(init)
            pg.goto(f"{_base()}/#/planner", wait_until="load")
            pg.wait_for_timeout(1500)
            pcard = pg.locator('.planner-card', has_text='e2e-limited').first
            pl_cpu = pcard.locator('.meta-chip', has_text=re.compile(r'^CPU ')).count()
            pl_mem = pcard.locator('.meta-chip', has_text=re.compile(r'^RAM ')).count()
            check("Planner card shows CPU + RAM meta-chips", pl_cpu == 1 and pl_mem == 1,
                  f"cpu={pl_cpu} ram={pl_mem}")
            pg.close()

    except Exception as exc:  # noqa: BLE001
        checks.append(("run completed without exceptions", False, str(exc)))
        print("ERROR:", type(exc).__name__, str(exc)[:300])
        try:
            browser.close()
        except Exception:  # noqa: BLE001
            pass
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:  # noqa: BLE001
                pass
        _cleanup(admin)

    failed = [n for n, ok, _ in checks if not ok]
    print()
    print(f"RESULT: {'OK' if not failed else 'FAIL'}  {len(checks) - len(failed)}/{len(checks)} checks passed")
    if failed:
        print("FAILED:", "; ".join(failed))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())