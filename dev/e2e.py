#!/usr/bin/env python3
"""Browser test against dev/server.py. Usage: python3 dev/e2e.py [base_url] [--local]
Needs the playwright Python package and Chromium. Saves screenshots to dev/shots/."""
import io
import random
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

args = [a for a in sys.argv[1:] if not a.startswith("--")]
LOCAL = "--local" in sys.argv
BASE = args[0] if args else ("http://localhost:8788" if LOCAL else "http://localhost:8787")
SHOTS = Path(__file__).parent / "shots"
fails, errors = [], []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        fails.append(name)


def busy_png():
    from PIL import Image
    rnd = random.Random(3)
    img = Image.new("L", (160, 120))
    img.putdata([255 if rnd.random() < 0.5 else 0 for _ in range(160 * 120)])
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "PNG")
    return buf.getvalue()


with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width": 1366, "height": 800})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(BASE)
    page.wait_for_selector("#covL")

    # ---- gateway: hover widens, layout is split
    wl0 = page.eval_on_selector("#covL", "e=>e.getBoundingClientRect().width")
    wr0 = page.eval_on_selector("#covR", "e=>e.getBoundingClientRect().width")
    check("gateway starts roughly 50/50", abs(wl0 - wr0) < 140, f"{wl0:.0f} vs {wr0:.0f}")
    page.hover("#covL"); page.wait_for_timeout(1100)
    wl1 = page.eval_on_selector("#covL", "e=>e.getBoundingClientRect().width")
    check("hovering the left side widens it", wl1 > wl0 + 80, f"{wl0:.0f} -> {wl1:.0f}")
    page.hover("#covR"); page.wait_for_timeout(1100)
    wr1 = page.eval_on_selector("#covR", "e=>e.getBoundingClientRect().width")
    check("hovering the right side widens it", wr1 > wr0 + 80, f"{wr0:.0f} -> {wr1:.0f}")
    page.mouse.move(683, 790); page.wait_for_timeout(300)
    page.screenshot(path=str(SHOTS / "1-gateway.png"))
    pill_visible = page.is_visible("#modePill")
    check("offline pill matches mode", pill_visible == LOCAL)

    # ---- reporter portal
    page.click("#covL")
    if not LOCAL:
        page.wait_for_selector("#authDlg[open]")
        check("sign-in dialog opens in cloud mode", True)
        page.screenshot(path=str(SHOTS / "2-signin.png"))
        page.click("#authForm [data-demo='1']")  # Reporter
        page.wait_for_function("!document.querySelector(\'#authDlg\').open")
    page.wait_for_selector("#gate[data-open='l']")
    page.wait_for_selector("#rMap .bin")
    page.wait_for_timeout(1300)
    check("24 bins on the reporter map", page.locator("#rMap .bin").count() == 24)
    check("back button visible", page.is_visible("#btnBack"))
    if not LOCAL:
        check("user chip shows contributor", "contributor" in page.inner_text("#userChip").lower())
    over0 = int(page.inner_text("#rPulse .hot b"))
    page.click("#rMap .bin[data-id='B-05']")
    check("selecting a bin updates the inspector", "B-05" in page.inner_text("#rInsp"))
    page.click(".sample[data-lv='3']")
    page.wait_for_selector(".result", timeout=8000)
    check("sample report detected", "Overflowing" in page.inner_text(".result"))
    over1 = int(page.inner_text("#rPulse .hot b"))
    check("overflow forecast count went up", over1 == over0 + 1, f"{over0}->{over1}")
    # correct it
    page.click(".chip[data-fix='1']"); page.wait_for_timeout(900)
    check("correction replaces the report", "Medium" in page.inner_text(".result b"))
    check("overflow count back after correction", int(page.inner_text("#rPulse .hot b")) == over0)
    # real photo upload
    page.click("#rMap .bin[data-id='B-19']")
    page.set_input_files("#photo", {"name": "bin.png", "mimeType": "image/png", "buffer": busy_png()})
    page.wait_for_selector(".result", timeout=20000)
    check("photo upload analysed", "Detected" in page.inner_text(".result b"), page.inner_text("#rRep")[:200])
    page.screenshot(path=str(SHOTS / "3-reporter.png"), full_page=False)

    # ---- back to the gateway, then collector gating
    page.click("#btnBack"); page.wait_for_function("!document.querySelector('#gate').hasAttribute('data-open')")
    page.wait_for_timeout(1000)
    if not LOCAL:
        page.click("#covR"); page.wait_for_selector("#gate[data-open='r']")
        page.wait_for_selector("#denyR:not([hidden])")
        check("contributor is told the console is for collectors", "Collector access only" in page.inner_text("#denyR"))
        page.wait_for_timeout(1300)
        page.screenshot(path=str(SHOTS / "4-denied.png"))
        page.click("[data-deny='switch']")
        page.wait_for_selector("#authDlg[open]")
        page.click("#authForm [data-demo='0']")
        page.wait_for_function("!document.querySelector(\'#authDlg\').open")
        page.wait_for_selector("#gate[data-open='r']")
        check("deny panel gone for collector", page.is_hidden("#denyR"))
    else:
        page.click("#covR"); page.wait_for_selector("#gate[data-open='r']")
    page.wait_for_selector("#cMap .bin"); page.wait_for_timeout(1300)
    check("collector sees the console", page.is_visible("#btnPlan"))
    check("no route yet", "No route yet" in page.inner_text("#cStats"))
    page.click("#btnPlan")
    page.wait_for_selector("#cStats.stats", timeout=8000)
    stops = page.locator("#cTasks .task").count()
    check("planner produced stops", stops >= 5, str(stops))
    check("route drawn", page.locator("#routeLine").count() == 1)
    check("B-19 report made it into the plan inputs", "B-19" in page.inner_text("#tbl"))
    page.click("#cTasks .tick >> nth=0"); page.wait_for_timeout(500)
    check("tick marks first stop", page.locator("#cTasks .task.ok").count() == 1)
    page.click("#btnPlay"); page.wait_for_timeout(600)
    page.screenshot(path=str(SHOTS / "5-collector.png"))
    page.wait_for_timeout(1200)
    # tuning
    page.evaluate("document.querySelector('details.tune').open = true")
    page.fill("#sCap", "3000") if False else page.eval_on_selector("#sCap", "e=>{e.value=3000;e.dispatchEvent(new Event('input',{bubbles:true}))}")
    page.wait_for_timeout(1500)
    check("smaller truck defers bins", "Left for later" in page.inner_text("#cTasks"))
    # collect
    page.click("#btnCollect"); page.wait_for_selector("#cStats.empty", timeout=8000)
    check("collection completes and clears the plan", page.locator("#cTasks .task").count() == 0)
    page.click("#btnReset"); page.wait_for_timeout(300)  # confirm() auto-dismissed in headless -> false in cloud
    # ---- phone width
    mob = b.new_context(viewport={"width": 390, "height": 760}, device_scale_factor=2)
    mp = mob.new_page(); mp.on("pageerror", lambda e: errors.append("mobile: " + str(e)))
    mp.goto(BASE); mp.wait_for_selector("#covL"); mp.wait_for_timeout(600)
    mp.screenshot(path=str(SHOTS / "6-mobile-gateway.png"))
    sw = mp.evaluate("document.documentElement.scrollWidth")
    check("no horizontal scroll on phone gateway", sw <= 390, str(sw))
    mp.click("#covR")
    if not LOCAL:
        mp.wait_for_selector("#authDlg[open]"); mp.click("#authForm [data-demo='0']"); mp.wait_for_function("!document.querySelector(\'#authDlg\').open")
    mp.wait_for_selector("#cMap .bin"); mp.wait_for_timeout(1400)
    mp.screenshot(path=str(SHOTS / "7-mobile-collector.png"))
    check("no horizontal scroll on phone console", mp.evaluate("document.querySelector('#conR').scrollWidth") <= 392,
          str(mp.evaluate("document.querySelector('#conR').scrollWidth")))
    # dark theme
    page.click("#btnBack"); page.wait_for_timeout(1000)
    page.click("#themeSeg [data-t='dark']"); page.wait_for_timeout(300)
    page.screenshot(path=str(SHOTS / "8-gateway-dark.png"))
    b.close()

real_errors = [e for e in errors if "favicon" not in e and "fonts.g" not in e and "ERR_" not in e and "Failed to load resource" not in e]
check("no console or page errors", not real_errors, "; ".join(real_errors[:3]))
print(f"\n{len(fails)} failed" if fails else "\nall checks passed")
sys.exit(1 if fails else 0)
