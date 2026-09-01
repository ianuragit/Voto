import { esc } from '../../domain/escape.js';

/**
 * Server-rendered, no SPA, no client-side state, no analytics (§8, §13).
 * The stylesheet is served from /static/app.css because the CSP forbids
 * inline anything — `script-src 'none'` means there is no JavaScript on any
 * page of this application at all.
 */
export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · Voto</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<main class="wrap">
${body}
</main>
<footer class="foot">
  <p><strong>Voto</strong> — anonymous, all-or-nothing decisions. Nobody can see how you voted, including whoever created the poll and whoever runs the server.</p>
</footer>
</body>
</html>`;
}

export const STYLESHEET = `
:root{--ink:#181817;--muted:#6b6b66;--line:#e3e2db;--bg:#f7f6f2;--card:#fff;--accent:#1a1a1a;--warn:#8a5a00;--warnbg:#fdf5e3;--bad:#8a1c1c;--badbg:#fdeeee;--good:#1f5c34;--goodbg:#edf7f0}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.wrap{max-width:640px;margin:0 auto;padding:40px 20px 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:26px;margin-bottom:20px}
h1{font-size:24px;line-height:1.25;margin:0 0 16px}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:26px 0 10px;font-weight:600}
p{margin:0 0 14px}
.muted{color:var(--muted);font-size:14px}
.kicker{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:0 0 6px}
label{display:block;font-weight:600;margin:0 0 6px;font-size:14px}
input[type=text],input[type=email],input[type=datetime-local],textarea{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:8px;font:inherit;background:#fff;color:var(--ink)}
textarea{min-height:88px;resize:vertical}
.field{margin-bottom:18px}
.hint{font-size:13px;color:var(--muted);margin:6px 0 0}
button{font:inherit;font-weight:600;padding:12px 22px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
button.secondary{background:#fff;color:var(--ink);border-color:var(--line)}
button.danger{background:#fff;color:var(--bad);border-color:#e6c9c9}
.choices{list-style:none;margin:0 0 20px;padding:0}
.choices li{margin:0 0 10px}
.choice{display:flex;gap:12px;align-items:center;border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:#fff;cursor:pointer;font-weight:500}
.choice:hover{border-color:#c9c8bf}
.choice input{margin:0;width:18px;height:18px;accent-color:var(--accent)}
.bar{height:8px;background:#eceae2;border-radius:99px;overflow:hidden;margin:10px 0}
.bar span{display:block;height:100%;background:var(--accent)}
.rowbar{height:26px;background:#f1efe8;border-radius:6px;overflow:hidden;margin:4px 0 2px}
.rowbar span{display:block;height:100%;background:var(--accent)}
.note{border-radius:8px;padding:13px 15px;font-size:14px;margin:0 0 18px}
.note.warn{background:var(--warnbg);color:var(--warn);border:1px solid #f0e0bb}
.note.bad{background:var(--badbg);color:var(--bad);border:1px solid #f2d5d5}
.note.good{background:var(--goodbg);color:var(--good);border:1px solid #cfe6d8}
.hash{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all;color:var(--muted)}
.code-in{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:22px;letter-spacing:.14em;text-align:center;text-transform:uppercase}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
ul.roster{margin:0;padding-left:20px;font-size:14px;color:var(--muted)}
.big{font-size:30px;font-weight:700;letter-spacing:-.02em}
.foot{max-width:640px;margin:0 auto;padding:8px 20px 48px;color:var(--muted);font-size:12px}
.pill{display:inline-block;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:3px 9px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
.pill.open{background:#eef3fb;color:#2a4d80;border-color:#d4e0f0}
.pill.completed{background:var(--goodbg);color:var(--good);border-color:#cfe6d8}
.pill.failed,.pill.cancelled{background:var(--badbg);color:var(--bad);border-color:#f2d5d5}
.pill.at_risk{background:var(--warnbg);color:var(--warn);border-color:#f0e0bb}
.actions{display:flex;gap:10px;flex-wrap:wrap}
a{color:var(--ink)}
`;
