// Tiny test app with a password login (user alice / password s3cret). Run: node examples/demo-app.mjs
// Then: DEMO_USER=alice DEMO_PASS=s3cret npm run crawl -- --config apps/demo.json
import http from "node:http";
const nav = `<nav><a href="/">Home</a> <a href="/reports">Reports</a> <a href="/settings">Settings</a> <a href="/delete-account">Delete account</a> <a href="/logout">Log out</a></nav>`;
const page = (t, body) => `<!doctype html><html><head><title>${t} - Demo</title></head><body>${nav}<h1>${t}</h1>${body}</body></html>`;
const authed = (req) => (req.headers.cookie || "").includes("sid=ok");
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, html, h = {}) => { res.writeHead(code, { "Content-Type": "text/html", ...h }); res.end(html); };
  if (u.pathname === "/login" && req.method === "POST") {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const p = new URLSearchParams(b);
      if (p.get("user") === "alice" && p.get("pass") === "s3cret") return send(302, "", { Location: "/", "Set-Cookie": "sid=ok; Path=/" });
      send(200, `<h1>Sign in</h1><p>Wrong user or password</p>` + form);
    }); return;
  }
  if (u.pathname === "/login") return send(200, `<title>Sign in</title><h1>Sign in</h1>` + form);
  if (!authed(req)) return send(302, "", { Location: "/login" });
  if (u.pathname === "/") return send(200, page("Home", "<p>Welcome back</p>"));
  if (u.pathname === "/reports") return send(200, page("Reports", `<h2>Monthly</h2><p>Revenue 100</p><a href="/reports/q1">Q1</a>`));
  if (u.pathname === "/reports/q1") return send(200, page("Q1 report", "<p>Q1 revenue 40</p>"));
  if (u.pathname === "/settings") return send(200, page("Settings", `<label>Display name <input name="n" placeholder="Name"></label>`));
  if (u.pathname === "/logout") return send(302, "", { Location: "/login", "Set-Cookie": "sid=; Max-Age=0; Path=/" });
  if (u.pathname === "/delete-account") return send(200, page("Account deleted", "<p>Gone</p>"));
  send(404, page("Not found", ""));
}).listen(5461, () => console.log("demo on 5461"));
const form = `<form method="post" action="/login"><label>Email <input name="user" type="text"></label><label>Password <input name="pass" type="password"></label><button type="submit">Sign in</button> <a href="/forgot">Forgot password</a></form>`;
