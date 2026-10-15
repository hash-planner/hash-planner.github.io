(() => {
  const ADAPTER_VERSION = "2026.10.15.4";
  const cfg = window.APEX_CONFIG || {};
  if (cfg.backendMode !== "supabase") return;

  const configured = cfg.supabaseUrl && cfg.supabasePublishableKey &&
    !cfg.supabaseUrl.includes("YOUR-PROJECT") && !cfg.supabasePublishableKey.includes("YOUR-");
  if (!configured || !window.supabase?.createClient) {
    alert("Supabase configuration is incomplete or the Supabase library did not load.");
    return;
  }

  const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  window.apexSupabase = client;
  let currentUser = null;

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
  gate.innerHTML = `<div id="apex-auth-card"><h1>APEX AUTO</h1><div>SERVICE INVOICE</div>
    <p>Sign in to access invoice records.</p>
    <label>Email<input id="apex-login-email" type="email" autocomplete="username"></label>
    <label>Password<input id="apex-login-password" type="password" autocomplete="current-password"></label>
    <button id="apex-login-button" type="button">Sign In</button><div id="apex-auth-error"></div></div>`;

  function mountGate(){ if(!gate.isConnected) (document.body || document.documentElement).appendChild(gate); }
  function allowed(user){ return !!user && (!cfg.allowedEmail || user.email?.toLowerCase() === cfg.allowedEmail.toLowerCase()); }
  function setStatus(text, good=false){
    const el=document.getElementById("folderStatus");
    if(el){ el.textContent=text; el.style.color=good?"#08734e":"#9a5a00"; }
  }
  function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]));}
  function showSignedIn(user){
    currentUser=user; gate.style.display="none";
    let badge=document.getElementById("apex-cloud-user");
    if(!badge){badge=document.createElement("div");badge.id="apex-cloud-user";(document.body||document.documentElement).appendChild(badge);}
    badge.innerHTML=`Cloud: ${escapeHtml(user.email||"Signed in")}<button type="button">Sign Out</button>`;
    badge.querySelector("button").onclick=async()=>{await client.auth.signOut();location.reload();};
    setStatus("Connected to Supabase v"+ADAPTER_VERSION+" | Loading cloud database...",true);
  }

  async function sessionUser(){
    if(currentUser) return currentUser;
    const {data,error}=await client.auth.getSession();
    if(error) throw error;
    const user=data.session?.user||null;
    if(user && allowed(user)){ showSignedIn(user); return user; }
    return null;
  }

  async function initialize(){
    mountGate();
    try{
      const user=await sessionUser();
      if(!user) gate.style.display="grid";
    }catch(e){gate.style.display="grid";gate.querySelector("#apex-auth-error").textContent=e.message;}
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",initialize,{once:true}); else initialize();

  gate.querySelector("#apex-login-button").onclick=async()=>{
    const email=gate.querySelector("#apex-login-email").value.trim();
    const password=gate.querySelector("#apex-login-password").value;
    const errorBox=gate.querySelector("#apex-auth-error");
    errorBox.textContent="Signing in...";
    const {data,error}=await client.auth.signInWithPassword({email,password});
    if(error){errorBox.textContent=error.message;return;}
    if(!allowed(data.user)){await client.auth.signOut();errorBox.textContent="This account is not authorized for this app.";return;}
    location.reload();
  };
  gate.querySelector("#apex-login-password").addEventListener("keydown",e=>{if(e.key==="Enter")gate.querySelector("#apex-login-button").click();});

  async function createSnapshotOnce(user,csvText){
    if(!csvText) return false;
    const day=new Date().toISOString().slice(0,10);
    const {data,error}=await client.from("invoice_backups").select("id").eq("user_id",user.id).eq("backup_date",day).maybeSingle();
    if(error) throw error;
    if(!data){
      const {error:insertError}=await client.from("invoice_backups").insert({user_id:user.id,backup_date:day,csv_text:csvText});
      if(insertError && insertError.code!=="23505") throw insertError;
    }
    const {data:all,error:listError}=await client.from("invoice_backups").select("id,backup_date").eq("user_id",user.id).order("backup_date",{ascending:false});
    if(listError) throw listError;
    const obsolete=(all||[]).slice(15).map(x=>x.id);
    if(obsolete.length){
      const {error:deleteError}=await client.from("invoice_backups").delete().eq("user_id",user.id).in("id",obsolete);
      if(deleteError) throw deleteError;
    }
    return !data;
  }

  async function verifyCopy(table,user,csvText){
    const {data,error}=await client.from(table).select("csv_text,updated_at").eq("user_id",user.id).single();
    if(error) throw error;
    if(data.csv_text!==csvText) throw new Error(table+" verification failed: stored data does not match.");
    return data;
  }

  async function cloudLoad(user){
    setStatus("Connected to Supabase v"+ADAPTER_VERSION+" | Loading cloud database...",true);
    const {data:master,error:masterError}=await client.from("invoice_master").select("csv_text,updated_at").eq("user_id",user.id).maybeSingle();
    if(masterError) throw masterError;
    const {data:mirror,error:mirrorError}=await client.from("invoice_mirror").select("csv_text,updated_at").eq("user_id",user.id).maybeSingle();
    if(mirrorError) throw mirrorError;
    if(!master && !mirror){setStatus("Connected to Supabase v"+ADAPTER_VERSION+" | New cloud database ready",true);return new Response("Not found",{status:404});}
    let csvText=master?.csv_text||mirror?.csv_text||"";
    let recovered=false;
    if(!master && mirror){
      const {error}=await client.from("invoice_master").upsert({user_id:user.id,csv_text:csvText,updated_at:new Date().toISOString()},{onConflict:"user_id"});
      if(error) throw error; recovered=true;
    }
    if(!mirror || mirror.csv_text!==csvText){
      const {error}=await client.from("invoice_mirror").upsert({user_id:user.id,csv_text:csvText,updated_at:new Date().toISOString()},{onConflict:"user_id"});
      if(error) throw error;
    }
    await createSnapshotOnce(user,csvText);
    setStatus("Connected to Supabase v"+ADAPTER_VERSION+" | "+(recovered?"Recovered from mirror":"Cloud database loaded"),true);
    return new Response(csvText,{status:200,headers:{"Content-Type":"text/csv; charset=utf-8"}});
  }

  async function cloudSave(user,csvText){
    if(!csvText || !csvText.includes("Invoice Number")) throw new Error("The generated invoice CSV is empty or invalid.");
    setStatus("Connected to Supabase v"+ADAPTER_VERSION+" | Saving master...",true);
    const {data:old,error:readError}=await client.from("invoice_master").select("csv_text").eq("user_id",user.id).maybeSingle();
    if(readError) throw readError;
    const snapshotCreated=old?.csv_text?await createSnapshotOnce(user,old.csv_text):false;
    const now=new Date().toISOString();
    const {error:masterError}=await client.from("invoice_master").upsert({user_id:user.id,csv_text:csvText,updated_at:now},{onConflict:"user_id"});
    if(masterError) throw masterError;
    await verifyCopy("invoice_master",user,csvText);
    setStatus("Connected to Supabase v"+ADAPTER_VERSION+" | Updating mirror...",true);
    const {error:mirrorError}=await client.from("invoice_mirror").upsert({user_id:user.id,csv_text:csvText,updated_at:now},{onConflict:"user_id"});
    if(mirrorError) throw mirrorError;
    const verified=await verifyCopy("invoice_mirror",user,csvText);
    setStatus("Connected to Supabase v"+ADAPTER_VERSION+" | Saved, mirrored and verified",true);
    return new Response(JSON.stringify({saved:true,backupCreated:snapshotCreated,mirrored:true,updatedAt:verified.updated_at}),{status:200,headers:{"Content-Type":"application/json"}});
  }

  const nativeFetch=window.fetch.bind(window);
  window.fetch=async(input,init={})=>{
    const raw=typeof input==="string"?input:input.url;
    let path;try{path=new URL(raw,location.href).pathname;}catch{path=raw;}
    if(path!=="/api/invoices") return nativeFetch(input,init);
    try{
      const user=await sessionUser();
      if(!user){mountGate();gate.style.display="grid";setStatus("Sign in to access the cloud database");return new Response("Unauthorized",{status:401});}
      return (init.method||"GET").toUpperCase()==="POST"?await cloudSave(user,String(init.body||"")):await cloudLoad(user);
    }catch(e){console.error("Supabase invoice operation failed",e);setStatus("Supabase error: "+e.message);return new Response(e.message,{status:500});}
  };
})();
