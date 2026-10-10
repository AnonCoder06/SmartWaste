#!/usr/bin/env python3
"""Check public console access and rejection of a non-bin photo. Usage: python3 dev/e2e_edge.py"""
import io
import os
import random
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

SERVER = str(Path(__file__).parent / "server.py")
proc = subprocess.Popen([sys.executable, SERVER, "--port", "8789"],
                        env={**os.environ, "DEV_REK": "person"}, stdout=subprocess.DEVNULL)
try:
    time.sleep(1.5)
    results = []

    def check(name, passed, detail=""):
        print(("PASS " if passed else "FAIL ") + name + (f" [{detail}]" if detail and not passed else ""))
        results.append(passed)

    img = Image.new("L", (120, 90))
    rng = random.Random(1)
    img.putdata([255 if rng.random() < .5 else 0 for _ in range(120 * 90)])
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "PNG")

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1366, "height": 800})
        page.goto("http://localhost:8789")
        page.click("#covL")
        page.wait_for_selector("#gate[data-open='l']")
        page.wait_for_selector("#rMap .bin")
        check("reporter console opens without login", page.is_visible("#rMap .bin"))
        page.click("#rMap .bin[data-id='B-05']")
        before = page.inner_text("#rInsp")
        page.set_input_files("#photo", {"name": "x.png", "mimeType": "image/png", "buffer": buf.getvalue()})
        page.wait_for_selector("#toast.on", timeout=15000)
        check("non-bin photo is rejected with a reason", "does not look like a bin" in page.inner_text("#toast"),
              page.inner_text("#toast"))
        page.wait_for_timeout(400)
        check("rejected photo leaves the bin unchanged", page.inner_text("#rInsp") == before)
        check("manual reporting remains available", page.locator(".sample[data-lv='2']").is_enabled())
        page.click("#btnBack")
        page.wait_for_timeout(1000)
        page.click("#covR")
        page.wait_for_selector("#gate[data-open='r']")
        page.wait_for_selector("#cMap .bin")
        check("field operations console also opens without login", page.is_visible("#btnPlan"))
        browser.close()

    print("\nall passed" if all(results) else "\nSOME FAILED")
    sys.exit(0 if all(results) else 1)
finally:
    proc.terminate()
