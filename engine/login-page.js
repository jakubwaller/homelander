// Kaufradar login form — one static page, no external assets.

export function renderLoginPage() {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kaufradar — Anmelden</title>
<style>
  :root { --gold:#D9A441; --bg:#0f0f11; --card:#1a1a1e; --border:#2e2e36; --text:#ededef; --dim:#9d9da5; --red:#f87171; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:15px/1.45 -apple-system,"Segoe UI",Roboto,sans-serif; min-height:100dvh; display:grid; place-items:center; padding:16px; }
  form { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:24px; width:100%; max-width:340px; display:flex; flex-direction:column; gap:12px; }
  h1 { font-size:18px; color:var(--gold); }
  input, button { font:inherit; font-size:16px; border-radius:8px; padding:9px 12px; }
  input { background:var(--bg); color:var(--text); border:1px solid var(--border); outline:none; }
  input:focus { border-color:var(--gold); }
  button { background:var(--gold); color:#1a1200; border:0; font-weight:600; cursor:pointer; }
  #err { color:var(--red); font-size:13px; min-height:1.2em; }
</style>
</head>
<body>
<form id="f">
  <h1>⌂ Kaufradar</h1>
  <input id="name" name="username" placeholder="Name" autocomplete="username" autocapitalize="none" required autofocus>
  <input id="pw" name="password" type="password" placeholder="Passwort" autocomplete="current-password" required>
  <div id="err" role="alert"></div>
  <button type="submit">Anmelden</button>
</form>
<script>
document.getElementById('f').addEventListener('submit', function (e) {
  e.preventDefault();
  var err = document.getElementById('err');
  err.textContent = '';
  fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: document.getElementById('name').value, password: document.getElementById('pw').value })
  }).then(function (r) {
    return r.json().then(function (d) { return { ok: r.ok, d: d }; });
  }).then(function (x) {
    if (x.ok) location.href = '/'; else err.textContent = x.d.error || 'Anmeldung fehlgeschlagen.';
  }).catch(function () { err.textContent = 'Netzwerkfehler.'; });
});
</script>
</body>
</html>`;
}
