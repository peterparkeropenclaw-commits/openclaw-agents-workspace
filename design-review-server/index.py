from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, unquote
import os, json, shutil

PORT = 3400
BASE_DIR = "/Users/robotmac/Desktop/optilyst-designs"
REF_DIR = os.path.join(BASE_DIR, "references")
GEN_DIR = os.path.join(BASE_DIR, "generated")
APPROVED_DIR = os.path.join(BASE_DIR, "approved")
APPROVE_TOKEN = os.environ.get("DESIGN_REVIEW_APPROVE_TOKEN", "change-me-now")

for d in [BASE_DIR, REF_DIR, GEN_DIR, APPROVED_DIR]:
    os.makedirs(d, exist_ok=True)

def list_images(folder):
    if not os.path.exists(folder):
        return []
    files = [f for f in os.listdir(folder) if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]
    files.sort(reverse=True)
    return files

def latest_generated():
    files = list_images(GEN_DIR)
    return files[0] if files else None

def approve_file(filename):
    base = filename
    for ext in [".png", ".jpg", ".jpeg", ".webp", ".json"]:
        if base.lower().endswith(ext):
            base = base[:-len(ext)]
            break

    src_png = os.path.join(GEN_DIR, base + ".png")
    src_json = os.path.join(GEN_DIR, base + ".json")
    dst_png = os.path.join(APPROVED_DIR, base + ".png")
    dst_json = os.path.join(APPROVED_DIR, base + ".json")

    if not os.path.exists(src_png):
        raise FileNotFoundError(f"Generated file not found: {base}.png")

    shutil.copy2(src_png, dst_png)

    meta = {
        "id": base,
        "status": "approved",
        "approvedPath": dst_png
    }

    if os.path.exists(src_json):
        try:
            with open(src_json, "r") as f:
                meta = json.load(f)
        except Exception:
            pass

    meta["status"] = "approved"
    meta["approvedPath"] = dst_png

    with open(dst_json, "w") as f:
        json.dump(meta, f, indent=2)

class Handler(BaseHTTPRequestHandler):

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()

    def _send(self, code, body, content_type="text/html; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.end_headers()
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            return self._send(200, json.dumps({
                "ok": True,
                "service": "design-review-server",
                "port": PORT,
                "baseDir": BASE_DIR
            }, indent=2), "application/json; charset=utf-8")

        if path == "/":
            refs = list_images(REF_DIR)
            gen = list_images(GEN_DIR)
            approved = list_images(APPROVED_DIR)

            def section(title, folder, items, can_approve=False):
                blocks = []
                for name in items:
                    enc = name.replace(" ", "%20")
                    approve = f'<div style="margin-top:8px;"><a href="/approve/{enc}?token={APPROVE_TOKEN}" style="padding:8px 12px;background:#111;color:#fff;text-decoration:none;border-radius:8px;">Approve</a></div>' if can_approve else ""
                    blocks.append(f"""
                    <div style="border:1px solid #ddd;border-radius:12px;padding:12px;margin:12px 0;background:#fff;">
                      <div style="font-weight:600;margin-bottom:8px;">{name}</div>
                      <div style="margin:8px 0;">
                        <img src="/files/{folder}/{enc}" style="max-width:320px;max-height:320px;border:1px solid #ddd;border-radius:8px;" />
                      </div>
                      <div style="display:flex;gap:12px;flex-wrap:wrap;">
                        <a href="/files/{folder}/{enc}" target="_blank">Open</a>
                        <a href="/files/{folder}/{enc}" download>Download</a>
                      </div>
                      {approve}
                    </div>
                    """)
                if not blocks:
                    blocks = ['<div style="color:#777;">No files yet.</div>']
                return f"<h2>{title}</h2>" + "".join(blocks)

            html = f"""
            <!doctype html>
            <html>
            <head>
              <meta charset="utf-8" />
              <title>Optilyst Design Review</title>
              <meta name="viewport" content="width=device-width, initial-scale=1" />
            </head>
            <body style="font-family:Arial,sans-serif;max-width:1100px;margin:0 auto;padding:24px;background:#f6f7fb;">
              <h1>Optilyst Design Review</h1>
              <div style="margin-bottom:16px;">
                <a href="/api/health">Health JSON</a> |
                <a href="/approve-latest?token={APPROVE_TOKEN}">Approve Latest Design</a>
              </div>
              {section("Approved", "approved", approved, False)}
              {section("Generated", "generated", gen, True)}
              {section("References", "references", refs, False)}
            </body>
            </html>
            """
            return self._send(200, html)

        if path.startswith("/files/"):
            parts = path.split("/")
            if len(parts) < 4:
                return self._send(404, "Not found", "text/plain; charset=utf-8")
            folder = parts[2]
            name = unquote("/".join(parts[3:]))

            root = {"references": REF_DIR, "generated": GEN_DIR, "approved": APPROVED_DIR}.get(folder)
            if not root:
                return self._send(404, "Not found", "text/plain; charset=utf-8")

            file_path = os.path.join(root, name)
            if not os.path.exists(file_path):
                return self._send(404, "Not found", "text/plain; charset=utf-8")

            ext = os.path.splitext(file_path)[1].lower()
            ctype = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".webp": "image/webp",
                ".json": "application/json; charset=utf-8",
            }.get(ext, "application/octet-stream")

            with open(file_path, "rb") as f:
                data = f.read()
            return self._send(200, data, ctype)

        if path.startswith("/approve/"):
            token = parsed.query.replace("token=", "")
            if token != APPROVE_TOKEN:
                return self._send(403, "Invalid token", "text/plain; charset=utf-8")

            filename = unquote(path[len("/approve/"):])
            try:
                approve_file(filename)
                self.send_response(302)
                self.send_header("Location", "/")
                self.end_headers()
            except Exception as e:
                return self._send(500, str(e), "text/plain; charset=utf-8")
            return

        if path == "/approve-latest":
            token = parsed.query.replace("token=", "")
            if token != APPROVE_TOKEN:
                return self._send(403, "Invalid token", "text/plain; charset=utf-8")
            latest = latest_generated()
            if not latest:
                return self._send(500, "No generated files found", "text/plain; charset=utf-8")
            try:
                approve_file(latest)
                self.send_response(302)
                self.send_header("Location", "/")
                self.end_headers()
            except Exception as e:
                return self._send(500, str(e), "text/plain; charset=utf-8")
            return

        return self._send(404, "Not found", "text/plain; charset=utf-8")

HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
