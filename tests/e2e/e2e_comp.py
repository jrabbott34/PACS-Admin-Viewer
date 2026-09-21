import sys
from playwright.sync_api import sync_playwright
from PIL import Image
import io
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist","--enable-webgl"])
    pg = b.new_page(viewport={"width":1440,"height":860})
    errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)[:200])); pg.on("console", lambda m: errs.append(m.text[:200]) if m.type=="error" else None)
    pg.goto(sys.argv[1]); pg.wait_for_function("window.__viewer !== undefined", timeout=20000); pg.click("#splash-open")
    import glob
    pg.set_input_files("#file-input", ["ct/ct_012.dcm"] + sorted(glob.glob("comp/*.dcm"))); pg.wait_for_timeout(4000)
    print("status:", pg.inner_text("#status"))
    ref = None
    for label in ["Chest phantom 5mm", "RLE", "J2K", "JLS"]:
        found=False
        for i in pg.query_selector_all(".series-item"):
            t = i.inner_text()
            if label in t or label.lower() in t.lower():
                i.click(); pg.wait_for_timeout(2000); found=True; break
        if not found: print(label, "NOT IN LIST"); continue
        # Element screenshots capture the visual region, not just that element's own DOM
        # subtree, so the per-cell overlay text (a positioned sibling) still shows up here
        # and differs by series description between these compressed variants. Crop to a
        # central region clear of all four corners' overlay text before comparing.
        pg.locator(".cell.active").screenshot(path=f"/tmp/c_{label[:3]}.png")
        im = Image.open(f"/tmp/c_{label[:3]}.png").convert("L")
        w, h = im.size
        im = im.crop((int(w * 0.15), int(h * 0.15), int(w * 0.85), int(h * 0.85)))
        if ref is None: ref = im
        from PIL import ImageChops
        diff = ImageChops.difference(ref, im).getbbox()
        print(f"{label:20s} TS series shown; identical-to-uncompressed render: {diff is None}", "| BR:", pg.inner_text(".ov.br").replace("\n"," "))
    print("ERRORS:", errs[:5]); b.close()
