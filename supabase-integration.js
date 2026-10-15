(() => {
  const cfg = window.APEX_CONFIG || {};
  if (cfg.backendMode !== "supabase") return;

  const invalidConfig = !cfg.supabaseUrl || !cfg.supabasePublishableKey ||
    cfg.supabaseUrl.includes("YOUR-PROJECT") || cfg.supabasePublishableKey.includes("YOUR-");

  const style = document.createElement("style");
  style.textContent = `
    #apex-auth-gate{position:fixed;inset:0;z-index:10000;background:#e5e5e5;display:grid;place-items:center;font:14px Arial,sans-serif}
    #apex-auth-card{width:min(410px,92vw);background:#fff;border:1px solid #666;box-shadow:0 12px 40px #0003;padding:26px}
    #apex-auth-card h1{margin:0 0 4px;font:700 25px Georgia,serif}
    #apex-auth-card p{color:#555;line-height:1.45}
    #apex-auth-card label{display:grid;gap:4px;margin-top:12px;font-size:11px;font-weight:bold;text-transform:uppercase}
    #apex-auth-card input{padding:10px;border:1px solid #888;font:14px Arial,sans-serif}
    #apex-auth-card button{margin-top:16px;width:100%;padding:10px;border:1px solid #111;background:#111;color:#fff;font-weight:bold;cursor:pointer}
    #apex-auth-error{color:#a40000;min-height:18px;margin-top:10px}
    #apex-cloud-user{position:fixed;right:10px;bottom:10px;z-index:9999;background:#222;color:#fff;padding:6px 9px;font:11px Arial,sans-serif;box-shadow:0 2px 10px #0004}
    #apex-cloud-user button{margin-left:8px;border:1px solid #aaa;background:#fff;color:#111;cursor:pointer}
    @media print{#apex-auth-gate,#apex-cloud-user{display:none!important}}
  `;
  document.head.appendChild(style);

  const gate = document.createElement("div");
  gate.id = "apex-auth-gate";
  gate.innerHTML = `<div id="apex-auth-card">
    <h1>APEX AUTO</h1><div>SERVICE INVOICE</div>
    <p>Sign in to access invoice records.</p>
    <label>Email<input id="apex-login-email" type="email" autocomplete="username"></label>
    <label>Password<input id="apex-login-password" type="password" autocomplete="current-password"></label>
    <button id="apex-login-button" type="button">Sign In</button>
    <div id="apex-auth-error"></div>
  </div>`;
  document.documentElement.appendChild(gate);

  if (invalidConfig || !window.supabase?.createClient) {
    gate.querySelector("#apex-auth-error").textContent = invalidConfig
      ? "Supabase configuration is incomplete. Update supabase-config.js."
      : "The Supabase library could not be loaded.";
    gate.querySelector("#apex-login-button").disabled = true;
    return;
  }

  const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  window.apexSupabase = client;

  let currentUser = null;
  let readyResolve;
  const ready = new Promise(resolve => readyResolve = resolve);
  window.apexSupabaseReady = ready;

  function allowed(user) {
    return !!user && (!cfg.allowedEmail || user.email?.toLowerCase() === cfg.allowedEmail.toLowerCase());
  }

  function showSignedIn(user) {
    currentUser = user;
    gate.style.display = "none";
    let badge = document.getElementById("apex-cloud-user");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "apex-cloud-user";
      document.body.appendChild(badge);
    }
    badge.innerHTML = `Cloud: ${escapeHtml(user.email || "Signed in")}<button type="button">Sign Out</button>`;
    badge.querySelector("button").onclick = async () => { await client.auth.signOut(); location.reload(); };
    readyResolve(user);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  async function initializeAuth() {
    const { data: { session } } = await client.auth.getSession();
    if (allowed(session?.user)) showSignedIn(session.user);
    else if (session?.user) {
      await client.auth.signOut();
      gate.querySelector("#apex-auth-error").textContent = "This account is not authorized for this app.";
    }
  }

  gate.querySelector("#apex-login-button").onclick = async () => {
    const email = gate.querySelector("#apex-login-email").value.trim();
    const password = gate.querySelector("#apex-login-password").value;
    const errorBox = gate.querySelector("#apex-auth-error");
    errorBox.textContent = "Signing in...";
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) { errorBox.textContent = error.message; return; }
    if (!allowed(data.user)) {
      await client.auth.signOut();
      errorBox.textContent = "This account is not authorized for this app.";
      return;
    }
    errorBox.textContent = "";
    showSignedIn(data.user);
    location.reload();
  };
  gate.querySelector("#apex-login-password").addEventListener("keydown", e => {
    if (e.key === "Enter") gate.querySelector("#apex-login-button").click();
  });

  initializeAuth();

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("/api/invoices")) return nativeFetch(input, init);

    await ready;
    if (!currentUser) return new Response("Unauthorized", { status: 401 });
    return (init.method || "GET").toUpperCase() === "POST"
      ? saveMaster(String(init.body || ""))
      : loadMaster();
  };

  async function createDailyBackup(csvText) {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await client.from("invoice_backups")
      .select("backup_date").eq("user_id", currentUser.id).eq("backup_date", today).maybeSingle();
    if (error) throw error;
    if (data) return false;
    const { error: insertError } = await client.from("invoice_backups").insert({
      user_id: currentUser.id, backup_date: today, csv_text: csvText
    });
    if (insertError && insertError.code !== "23505") throw insertError;
    return !insertError;
  }

  async function loadMaster() {
    const { data, error } = await client.from("invoice_master")
      .select("csv_text").eq("user_id", currentUser.id).maybeSingle();
    if (error) return new Response(error.message, { status: 500 });
    if (!data) return new Response("Master invoice file not found", { status: 404 });
    try { await createDailyBackup(data.csv_text); }
    catch (e) { return new Response(e.message, { status: 500 }); }
    return new Response(data.csv_text, { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8" } });
  }

  async function saveMaster(csvText) {
    let backupCreated = false;
    const { data: existing, error: readError } = await client.from("invoice_master")
      .select("csv_text").eq("user_id", currentUser.id).maybeSingle();
    if (readError) return new Response(readError.message, { status: 500 });
    try { if (existing?.csv_text) backupCreated = await createDailyBackup(existing.csv_text); }
    catch (e) { return new Response(e.message, { status: 500 }); }

    const { error } = await client.from("invoice_master").upsert({
      user_id: currentUser.id, csv_text: csvText, updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });
    if (error) return new Response(error.message, { status: 500 });
    return new Response(JSON.stringify({ saved: true, backupCreated }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  }
})();
