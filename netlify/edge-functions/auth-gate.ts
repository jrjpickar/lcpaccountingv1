// Gates the page itself (public/index.html and anything else static) - see
// netlify/shared/auth.ts. Without a valid session (signed AND still on the
// access list) it serves a small sign-in screen instead of the app, so none
// of the app's HTML (or the webhook URLs inside it) is visible before
// signing in.
//
// The sign-in screen:
//   - inside GHL: asks GHL for the logged-in user (REQUEST_USER_DATA) and
//     signs in with it automatically - no typing.
//   - outside GHL: email + LEDGER_PIN, if LEDGER_PIN is set; otherwise
//     "open the Ledger inside GHL".
//
// /api/* and /.netlify/* are excluded here on purpose: every function checks
// the session itself (netlify/functions/lib/auth-guard.mts), because
// /.netlify/functions/* can't be covered by an edge function anyway, and a
// couple of Make callbacks need to reach their functions without a session.
//
// A session arrives either as the cookie, or - for the one hop right after
// sign-in inside GHL's iframe, where the cookie may be blocked - as
// ?auth=<token> on the URL, which the page immediately strips and keeps in
// localStorage.

import { getPin, ghlSignInConfigured, isAuthenticated, principalFromToken } from "../shared/auth.ts";

export default async (req: Request, context: any) => {
  const url = new URL(req.url);
  const pin = !!getPin(), ghl = ghlSignInConfigured();
  if (!pin && !ghl) return signinPage(503, { pin, ghl, notConfigured: true });
  const qToken = url.searchParams.get("auth");
  if ((qToken && (await principalFromToken(qToken))) || (await isAuthenticated(req))) {
    const res = await context.next();
    res.headers.set("cache-control", "no-store");
    return res;
  }
  return signinPage(401, { pin, ghl, notConfigured: false });
};

function signinPage(status: number, o: { pin: boolean; ghl: boolean; notConfigured: boolean }): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>LocalCare Ledger - Sign in</title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap">
<script>(function(){var t=null;try{t=localStorage.getItem('ghl-ledger-theme')}catch(e){}if(t!=='light'&&t!=='dark'){t=(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light'}document.documentElement.setAttribute('data-theme',t)})();</script>
<style>
:root{--bg:#F2F7FB;--surface:#FFFFFF;--ink:#0E1E33;--muted:#5E7088;--line:#D3E2EE;--accent:#075d94;--on-accent:#fff;--err:#A3302A;--err-bg:#F8DCD9;--note-bg:#E2F6FC;
  --shadow:0 2px 4px rgba(0,45,105,.06),0 10px 24px -10px rgba(0,45,105,.22);color-scheme:light}
:root[data-theme="dark"]{--bg:#08131F;--surface:#0F1E2E;--ink:#E6EEF6;--muted:#8DA0B5;--line:#24394F;--accent:#55BFE7;--on-accent:#04121F;--err:#F29B8B;--err-bg:#3F1D1A;--note-bg:#0D3048;
  --shadow:0 1px 2px rgba(0,0,0,.35),0 10px 24px -12px rgba(0,0,0,.6);color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:var(--bg);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,sans-serif}
.card{position:relative;overflow:hidden;width:100%;max-width:380px;background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:34px 28px 28px;text-align:center}
.card::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#002d69,#00a9dc)}
.lock{width:44px;height:44px;border-radius:12px;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--accent)}
h1{font-size:20px;margin:0 0 6px;font-weight:800}
p{margin:0 0 18px;color:var(--muted);font-size:13.5px;line-height:1.5}
label{display:block;text-align:left;font-size:12px;font-weight:700;color:var(--muted);margin:0 0 6px;text-transform:uppercase;letter-spacing:.04em}
input{width:100%;font:inherit;font-size:15px;padding:11px 12px;border:1.5px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);margin-bottom:14px}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}
button{width:100%;font:inherit;font-weight:700;font-size:14.5px;padding:12px;border-radius:10px;border:1px solid var(--accent);background:var(--accent);color:var(--on-accent);cursor:pointer}
button:disabled{opacity:.6;cursor:default}
.msg{margin-top:12px;font-size:13px;font-weight:600;color:var(--err);min-height:18px}
.box{background:var(--err-bg);color:var(--err);border-radius:10px;padding:10px 12px;font-size:13px;font-weight:600;text-align:left;margin-bottom:14px}
.note{background:var(--note-bg);color:var(--ink);border-radius:10px;padding:10px 12px;font-size:13px;text-align:left;margin-bottom:14px;line-height:1.5}
.spin{width:22px;height:22px;border:3px solid var(--line);border-top-color:var(--accent);border-radius:50%;margin:6px auto 0;animation:s .8s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
[hidden]{display:none!important}
</style></head>
<body><div class="card">
<div class="lock"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>
<h1>LocalCare Ledger</h1>
${o.notConfigured
    ? `<p>Sign-in isn't set up yet.</p><div class="box">Set <b>LEDGER_PASSWORD</b> (12–256 characters) for outside-GHL access, or <b>GHL_APP_SHARED_SECRET</b> (the Ledger Marketplace app's Shared Secret) in Netlify → Site configuration → Environment variables, then redeploy.</div>`
    : `<div id="ghl" hidden><p>Signing you in with your GHL login…</p><div class="spin"></div></div>
<div id="denied" hidden></div>
<form id="pinForm" autocomplete="on" hidden>
  <p id="pinIntro">Outside GHL, sign in with your GHL login email and the Ledger password.</p>
  <label for="email">GHL login email</label><input id="email" type="email" autocomplete="username" required>
  <label for="pin">Ledger password</label><input id="pin" type="password" autocomplete="current-password" maxlength="256" required>
  <button type="submit" id="b">Sign in</button><div class="msg" id="m" role="alert"></div>
</form>
<div id="ghlOnly" hidden><p>Open the Ledger from inside GHL - it signs you in automatically there.</p></div>`}
</div>
${o.notConfigured ? "" : `<script>
(function(){
  var PIN=${o.pin ? "true" : "false"}, GHL=${o.ghl ? "true" : "false"}, KEY='ghl-ledger-auth', embedded=window.parent!==window;
  function $(id){return document.getElementById(id)}
  function go(token){try{localStorage.setItem(KEY,token)}catch(e){}var u=new URL(location.href);u.searchParams.set('auth',token);location.replace(u.toString())}
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
  // A saved session (e.g. the cookie was blocked in GHL's iframe)? Retry with
  // it once; if we're back here WITH it, it's stale (expired or access removed).
  try{
    var saved=localStorage.getItem(KEY), here=new URL(location.href);
    if(saved&&!here.searchParams.has('auth')){here.searchParams.set('auth',saved);location.replace(here.toString());return}
    if(here.searchParams.has('auth')){localStorage.removeItem(KEY);here.searchParams.delete('auth');history.replaceState(null,'',here.toString())}
  }catch(e){}
  function post(body){
    return fetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)})
      .then(function(r){return r.json().catch(function(){return{}}).then(function(d){return{ok:r.ok,status:r.status,d:d}})});
  }
  function fallback(problem){
    $('ghl').hidden=true;
    if(problem){$('denied').hidden=false;$('denied').innerHTML='<div class="box">'+esc(problem)+'</div>'}
    if(PIN){$('pinForm').hidden=false;if(problem)$('pinIntro').textContent='Or sign in with your GHL login email and the Ledger password.';$('email').focus()}
    else if(!problem){$('ghlOnly').hidden=false}
  }
  function askGhl(){
    return new Promise(function(resolve,reject){
      var t=setTimeout(function(){window.removeEventListener('message',on);reject(new Error('GHL did not answer. Open the Ledger from its menu item in GHL.'))},8000);
      function on(e){
        if(e.source!==window.parent||!e.data||e.data.message!=='REQUEST_USER_DATA_RESPONSE'||!e.data.payload)return;
        clearTimeout(t);window.removeEventListener('message',on);resolve(e.data.payload);
      }
      window.addEventListener('message',on);
      window.parent.postMessage({message:'REQUEST_USER_DATA'},'*');
    });
  }
  if(embedded&&GHL){
    $('ghl').hidden=false;
    askGhl().then(function(enc){return post({action:'ghl',encryptedData:enc})}).then(function(x){
      if(x.ok&&x.d.token)return go(x.d.token);
      if(x.d&&x.d.notListed){
        $('ghl').hidden=true;$('denied').hidden=false;
        $('denied').innerHTML='<div class="note"><b>No access yet.</b><br>'+esc(x.d.error)+'</div>';
        return;
      }
      fallback((x.d&&x.d.error)||'GHL sign-in failed.');
    }).catch(function(err){fallback(err.message)});
  } else fallback('');

  var form=$('pinForm'), busy=false;
  form.addEventListener('submit',function(e){
    e.preventDefault(); if(busy)return; busy=true; $('b').disabled=true; $('m').textContent='';
    post({action:'pin',email:$('email').value,pin:$('pin').value}).then(function(x){
      if(x.ok&&x.d.token)return go(x.d.token);
      busy=false;$('b').disabled=false;$('pin').value='';$('m').textContent=(x.d&&x.d.error)||'Could not sign in.';$('pin').focus();
    }).catch(function(){busy=false;$('b').disabled=false;$('m').textContent='Network error - try again.'});
  });
})();
</script>`}
</body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

export const config = {
  path: "/*",
  excludedPath: ["/api/*", "/.netlify/*"],
};
