"""Edge-case browser checks: rejected photo, sign-up with confirmation code, bad password, expired session.
Starts its own dev servers (ports 8789 and 8790). Usage: python3 dev/e2e_edge.py"""
import io, os, random, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image
SERVER = str(Path(__file__).parent / "server.py")
procs = [subprocess.Popen([sys.executable, SERVER, "--port", "8789"], env={**os.environ, "DEV_REK": "person"}, stdout=subprocess.DEVNULL),
         subprocess.Popen([sys.executable, SERVER, "--port", "8790"], stdout=subprocess.DEVNULL)]
time.sleep(1.5)
res = []
def check(n, c, d=""):
    print(("PASS " if c else "FAIL ") + n + (f" [{d}]" if d and not c else "")); res.append(c)
def png():
    img = Image.new("L", (120, 90)); r = random.Random(1)
    img.putdata([255 if r.random() < .5 else 0 for _ in range(120*90)]); b = io.BytesIO(); img.convert("RGB").save(b, "PNG"); return b.getvalue()
with sync_playwright() as pw:
    b = pw.chromium.launch(); page = b.new_context(viewport={"width":1366,"height":800}).new_page()
    # rejected photo (server running with Rekognition returning Person/Selfie)
    page.goto("http://localhost:8789"); page.click("#covL"); page.wait_for_selector("#authDlg[open]")
    page.click("#authForm [data-demo='1']"); page.wait_for_selector("#rMap .bin"); page.wait_for_timeout(1300)
    page.click("#rMap .bin[data-id='B-05']")
    before = page.inner_text("#rInsp")
    page.set_input_files("#photo", {"name":"x.png","mimeType":"image/png","buffer":png()})
    page.wait_for_selector("#toast.on", timeout=15000)
    check("non-bin photo rejected with a reason", "does not look like a bin" in page.inner_text("#toast"), page.inner_text("#toast"))
    page.wait_for_timeout(400)
    check("rejected photo leaves the bin alone", page.inner_text("#rInsp") == before)
    check("reporter can still pick a level by hand afterwards", page.locator(".sample[data-lv='2']").is_enabled())
    # sign up + confirm on the normal server
    p2 = b.new_context().new_page(); p2.goto("http://localhost:8790"); p2.click("#covL"); p2.wait_for_selector("#authDlg[open]")
    p2.click("#authTabs [data-m='up']"); p2.fill("#authEmail", "new.person@example.org"); p2.fill("#authPw", "Sup3r-secret!")
    check("password hint shown when creating an account", p2.is_visible("#pwHint"))
    p2.click("#authGo"); p2.wait_for_selector("#codeField:not([hidden])")
    p2.fill("#authCode", "000000"); p2.click("#authGo"); p2.wait_for_selector("#authErr:not([hidden])")
    check("wrong code explained", "code is not right" in p2.inner_text("#authErr"), p2.inner_text("#authErr"))
    p2.fill("#authCode", "123456"); p2.click("#authGo")
    p2.wait_for_selector("#gate[data-open='l']", timeout=8000)
    check("new account confirmed and signed in", "new.person@example.org" in p2.inner_text("#userChip"))
    # wrong password
    p3 = b.new_context().new_page(); p3.goto("http://localhost:8790"); p3.click("#covR"); p3.wait_for_selector("#authDlg[open]")
    p3.fill("#authEmail", "demo.collector@smartwaste.example"); p3.fill("#authPw", "not-the-password"); p3.click("#authGo")
    p3.wait_for_selector("#authErr:not([hidden])")
    check("wrong password message", "do not match" in p3.inner_text("#authErr"))
    # expired session -> back to sign-in
    p3.click("#authForm [data-demo='0']"); p3.wait_for_selector("#gate[data-open='r']"); p3.wait_for_selector("#cMap .bin")
    p3.evaluate("sessionStorage.setItem('sw-session', JSON.stringify({idToken:'bad.bad.bad', refreshToken:'nope', exp:1, email:'x', groups:['collectors']}))")
    p3.click("#btnPlan"); p3.wait_for_selector("#gate:not([data-open])", timeout=8000)
    p3.wait_for_timeout(1300)
    check("expired session returns to the gateway", p3.is_visible("#covL") and p3.evaluate("document.querySelector('#covL').getBoundingClientRect().width") > 300)
    check("user is told why", "session ended" in p3.inner_text("#toast"))
    check("signed out chip hidden", p3.is_hidden("#userChip"))
    b.close()
for p in procs:
    p.terminate()
print("\nall passed" if all(res) else "\nSOME FAILED"); sys.exit(0 if all(res) else 1)
