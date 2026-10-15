/*!
 * Porchbook Calls — Telegram-style 1-to-1 voice & video calls.
 * Add to any page with:
 *   <script src="https://YOUR-CALL-SERVER/porchbook-calls.js"></script>
 * Optional: data-server="wss://other-host" to point at a different call server.
 *
 * Security model (same idea as Telegram secret calls):
 *  - The server only rings and passes setup messages. Audio/video are end-to-end
 *    encrypted between the two phones (WebRTC DTLS-SRTP).
 *  - Commit-then-reveal: the caller commits to a hash of its key fingerprint before
 *    seeing the other side's, so an attacker can't search for matching emojis.
 *  - Both screens show 4 emojis from both key fingerprints. Same emojis = private call.
 */
(function () {
  if (window.__porchbookCalls) return;
  window.__porchbookCalls = true;

  // ------------------------------------------------------------------ config
  const script = document.currentScript;
  const SERVER_URL = (() => {
    const attr = script && script.getAttribute("data-server");
    if (attr) return attr;
    const src = new URL(script ? script.src : location.href);
    return (src.protocol === "https:" ? "wss://" : "ws://") + src.host;
  })();
  const store = {
    get(k, d) { try { const v = localStorage.getItem("pbcalls:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("pbcalls:" + k, JSON.stringify(v)); } catch {} },
  };

  // ------------------------------------------------------------------ crypto helpers
  const EMOJI = [
    "😀","😎","🤖","👻","🐶","🐱","🦊","🐼","🐸","🐵","🦁","🐯","🐨","🐙","🦋","🐢",
    "🌵","🌲","🌻","🍀","🍎","🍌","🍉","🍇","🍓","🍒","🍍","🥑","🌽","🥕","🍕","🍔",
    "🍩","🍪","🎂","☕","⚽","🏀","🎸","🎧","🎲","🚗","🚀","✈️","🚲","⛵","🏠","⏰",
    "💡","🔑","🔒","📷","📚","✏️","🎁","🎈","⭐","🌙","☀️","🌈","❄️","🔥","💧","⚡",
  ];
  async function sha256(str) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)));
  }
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const certFp = (cert) => cert.getFingerprints().find((f) => f.algorithm === "sha-256").value.toUpperCase();
  const sdpFp = (sdp) => { const m = sdp.match(/a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/); return m ? m[1].toUpperCase() : null; };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : hex(crypto.getRandomValues(new Uint8Array(16))));

  // ------------------------------------------------------------------ call engine
  class CallClient {
    constructor({ url, allowP2P = true, ringTimeoutMs = 45000 }) {
      this.url = url; this.allowP2P = allowP2P; this.ringTimeoutMs = ringTimeoutMs;
      this.iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
      this.h = {}; this.c = null; this.online = [];
    }
    on(e, fn) { (this.h[e] = this.h[e] || []).push(fn); return this; }
    emit(e, d) { (this.h[e] || []).forEach((fn) => fn(d)); }

    connect(name) {
      return new Promise((resolve, reject) => {
        this.closing = false;
        const ws = (this.ws = new WebSocket(this.url));
        let done = false, registered = false;
        ws.onopen = () => this.send({ type: "register", name });
        ws.onerror = () => { if (!done) { done = true; reject(new Error("Can't reach the call server")); } };
        ws.onclose = () => {
          if (this.ws !== ws) return;
          this.cleanup("signaling-lost");
          if (!done) { done = true; reject(new Error("Can't reach the call server")); }
          if (registered) this.emit("disconnected", { intentional: this.closing });
        };
        ws.onmessage = (e) => {
          let msg; try { msg = JSON.parse(e.data); } catch { return; }
          if (msg.type === "registered") {
            this.me = msg.userId; this.myName = msg.name;
            if (Array.isArray(msg.iceServers) && msg.iceServers.length) this.iceServers = msg.iceServers;
            done = true; registered = true; return resolve(msg);
          }
          if (msg.type === "register-error") { done = true; this.closing = true; ws.close(); return reject(new Error(msg.reason)); }
          if (msg.type === "presence") { this.online = msg.online.filter((u) => u.id !== this.me); return this.emit("presence", this.online); }
          this.handle(msg).catch((err) => { console.error("[Porchbook calls]", err); this.end("error", true); });
        };
      });
    }
    disconnect() { this.closing = true; this.end("hangup", true); this.ws && this.ws.close(); }
    send(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
    sendPeer(type, extra) { const c = this.c; if (c) this.send(Object.assign({ type, to: c.peer, callId: c.id }, extra || {})); }

    async call(peer, peerName, video) {
      if (this.c) throw new Error("Already in a call");
      this.c = { id: uuid(), peer, peerName, video, role: "caller", pendingIce: [] };
      this.emit("state", "preparing");
      const c = this.c;
      try {
        c.cert = await RTCPeerConnection.generateCertificate({ name: "ECDSA", namedCurve: "P-256" });
        c.myFp = certFp(c.cert);
        c.local = await this.media(video);
      } catch (e) { this.cleanup(e.name === "NotAllowedError" ? "no-permission" : "error"); throw e; }
      if (this.c !== c) return;
      this.emit("local", c.local);
      this.sendPeer("ring", { video, commit: hex(await sha256(c.myFp)) }); // Step 1: commit
      this.emit("state", "ringing");
      c.timer = setTimeout(() => this.end("no-answer", true), this.ringTimeoutMs);
    }

    async accept() {
      const c = this.c;
      if (!c || c.role !== "callee" || c.accepted) return;
      c.accepted = true; clearTimeout(c.timer);
      this.emit("state", "connecting");
      try {
        c.cert = await RTCPeerConnection.generateCertificate({ name: "ECDSA", namedCurve: "P-256" });
        c.myFp = certFp(c.cert);
        c.local = await this.media(c.video);
      } catch (e) { return this.end(e.name === "NotAllowedError" ? "no-permission" : "error", true); }
      if (this.c !== c) return;
      this.emit("local", c.local);
      this.peer();
      this.sendPeer("accept", { fp: c.myFp }); // Step 2: callee reveals first
    }
    decline() { if (this.c) { this.sendPeer("decline"); this.cleanup("declined"); } }
    hangup() { this.end("hangup", true); }
    setMuted(m) { this.c && this.c.local && this.c.local.getAudioTracks().forEach((t) => (t.enabled = !m)); }
    setCameraOff(o) { this.c && this.c.local && this.c.local.getVideoTracks().forEach((t) => (t.enabled = !o)); }

    async handle(msg) {
      if (msg.type === "ring") {
        if (this.c) return this.send({ type: "busy", to: msg.from, callId: msg.callId });
        this.c = { id: msg.callId, peer: msg.from, peerName: msg.fromName || msg.from, video: !!msg.video,
          role: "callee", commit: msg.commit, pendingIce: [] };
        this.c.timer = setTimeout(() => this.cleanup("missed"), this.ringTimeoutMs);
        return this.emit("incoming", { from: msg.from, name: this.c.peerName, video: !!msg.video });
      }
      const c = this.c;
      if (!c || msg.callId !== c.id || msg.from !== c.peer) return;

      switch (msg.type) {
        case "accept": {
          if (c.role !== "caller" || c.peerFp || typeof msg.fp !== "string") return;
          clearTimeout(c.timer);
          c.peerFp = msg.fp.toUpperCase();
          this.emit("state", "connecting");
          this.peer();
          await c.pc.setLocalDescription(await c.pc.createOffer());
          return this.sendPeer("offer", { sdp: c.pc.localDescription.sdp }); // Step 3: reveal
        }
        case "offer": {
          if (c.role !== "callee" || !c.pc) return;
          const fp = sdpFp(msg.sdp);
          if (!fp || hex(await sha256(fp)) !== c.commit) return this.end("security-check-failed", true);
          c.peerFp = fp;
          await c.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
          c.local.getTracks().forEach((t) => c.pc.addTrack(t, c.local));
          await c.pc.setLocalDescription(await c.pc.createAnswer());
          this.sendPeer("answer", { sdp: c.pc.localDescription.sdp });
          await this.flush(); return this.emojis();
        }
        case "answer": {
          if (c.role !== "caller" || !c.pc) return;
          if (sdpFp(msg.sdp) !== c.peerFp) return this.end("security-check-failed", true);
          await c.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          await this.flush(); return this.emojis();
        }
        case "ice":
          if (c.pc && c.pc.remoteDescription) await c.pc.addIceCandidate(msg.candidate).catch(() => {});
          else c.pendingIce.push(msg.candidate);
          return;
        case "decline": return this.cleanup("declined");
        case "busy": return this.cleanup("busy");
        case "unavailable": return this.cleanup("unavailable");
        case "hangup": return this.cleanup("remote-hangup");
      }
    }

    media(video) {
      return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: video ? { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    }

    peer() {
      const c = this.c;
      const pc = (c.pc = new RTCPeerConnection({
        iceServers: this.iceServers,
        certificates: [c.cert],
        iceTransportPolicy: this.allowP2P ? "all" : "relay",
      }));
      if (c.role === "caller") c.local.getTracks().forEach((t) => pc.addTrack(t, c.local));
      pc.onicecandidate = (e) => e.candidate && this.sendPeer("ice", { candidate: e.candidate });
      pc.ontrack = (e) => this.emit("remote", e.streams[0]);
      pc.onconnectionstatechange = async () => {
        if (this.c !== c) return;
        const s = pc.connectionState;
        if (s === "connected") {
          clearTimeout(c.dropTimer);
          c.startedAt = c.startedAt || Date.now();
          this.emit("state", "connected");
          this.emit("route", await this.route());
        } else if (s === "disconnected") {
          this.emit("state", "reconnecting");
          c.dropTimer = setTimeout(() => this.end("connection-lost", true), 15000);
        } else if (s === "failed") this.end("connection-failed", true);
      };
    }
    async flush() { const c = this.c; for (const x of c.pendingIce.splice(0)) await c.pc.addIceCandidate(x).catch(() => {}); }
    async emojis() {
      const c = this.c;
      const [a, b] = c.role === "caller" ? [c.myFp, c.peerFp] : [c.peerFp, c.myFp];
      const h = await sha256(a + "|" + b);
      this.emit("emojis", [0, 1, 2, 3].map((i) => EMOJI[h[i] % EMOJI.length]));
    }
    async route() {
      const st = await this.c.pc.getStats(); let pair;
      st.forEach((r) => { if (r.type === "transport" && r.selectedCandidatePairId) pair = st.get(r.selectedCandidatePairId); });
      if (!pair) st.forEach((r) => { if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pair = r; });
      const l = pair && st.get(pair.localCandidateId);
      return l && l.candidateType === "relay" ? "relay" : "p2p";
    }
    end(reason, notify) { if (notify) this.sendPeer("hangup"); this.cleanup(reason); }
    cleanup(reason) {
      const c = this.c; if (!c) return;
      clearTimeout(c.timer); clearTimeout(c.dropTimer);
      c.pc && c.pc.close();
      c.local && c.local.getTracks().forEach((t) => t.stop());
      this.c = null;
      this.emit("ended", { reason, duration: c.startedAt ? Math.round((Date.now() - c.startedAt) / 1000) : 0, peerName: c.peerName });
    }
  }

  // ------------------------------------------------------------------ UI
  const host = document.createElement("div");
  host.id = "porchbook-calls";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; }
  button { font: inherit; cursor: pointer; border: 0; }
  .fab { position: fixed; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom)); z-index: 2147483000;
    width: 56px; height: 56px; border-radius: 50%; background: #2fb36d; color: #fff; display: grid; place-items: center;
    box-shadow: 0 6px 20px rgba(0,0,0,.45); }
  .fab .dot { position: absolute; top: 6px; right: 6px; min-width: 18px; height: 18px; border-radius: 9px; background: #fff;
    color: #1d7a49; font-size: 11px; font-weight: 600; display: none; place-items: center; padding: 0 5px; }
  .sheet { position: fixed; inset: auto 0 0 0; z-index: 2147483001; max-height: 80vh; background: #111; color: #eee;
    border-radius: 18px 18px 0 0; padding: 18px 16px calc(18px + env(safe-area-inset-bottom)); overflow: auto;
    box-shadow: 0 -10px 40px rgba(0,0,0,.6); display: none; }
  @media (min-width: 600px) { .sheet { left: auto; right: 16px; bottom: 84px; width: 360px; border-radius: 18px; } }
  .row { display: flex; align-items: center; gap: 10px; }
  .between { justify-content: space-between; }
  h3 { margin: 0; font-size: 18px; font-weight: 600; color: #fff; }
  .muted { color: #9a9a9a; font-size: 13px; }
  input[type=text] { width: 100%; padding: 12px 14px; border-radius: 12px; border: 1px solid #333; background: #1c1c1c;
    color: #fff; font-size: 16px; margin: 12px 0 8px; }
  .btn { padding: 12px 16px; border-radius: 12px; background: #2fb36d; color: #fff; font-weight: 600; width: 100%; }
  .btn.ghost { background: #222; color: #ddd; }
  .x { background: none; color: #aaa; font-size: 22px; line-height: 1; padding: 4px 8px; }
  .err { color: #ff7a7a; font-size: 13px; min-height: 18px; }
  .toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; font-size: 14px; }
  .switch { width: 44px; height: 26px; border-radius: 13px; background: #444; position: relative; flex: none; }
  .switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: left .15s; }
  .switch.on { background: #2fb36d; } .switch.on::after { left: 21px; }
  .list { margin: 10px 0; }
  .member { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #222; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; background: #2a3a32; color: #8fe0b4; display: grid; place-items: center;
    font-weight: 600; flex: none; }
  .member .name { flex: 1; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .icon { width: 40px; height: 40px; border-radius: 50%; background: #1f2e26; color: #2fb36d; display: grid; place-items: center; }
  .empty { padding: 24px 0; text-align: center; }
  .screen { position: fixed; inset: 0; z-index: 2147483002; background: #000; color: #fff; display: none; flex-direction: column; }
  .remote { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: #000; }
  .local { position: absolute; right: 14px; top: calc(14px + env(safe-area-inset-top)); width: 28vw; max-width: 160px;
    aspect-ratio: 3/4; object-fit: cover; border-radius: 12px; background: #222; transform: scaleX(-1); display: none; z-index: 2; }
  .top { position: relative; z-index: 1; text-align: center; padding: calc(48px + env(safe-area-inset-top)) 16px 0;
    text-shadow: 0 1px 6px rgba(0,0,0,.7); }
  .big-avatar { width: 112px; height: 112px; border-radius: 50%; margin: 0 auto 16px; background: #2a3a32; color: #8fe0b4;
    display: grid; place-items: center; font-size: 44px; font-weight: 600; }
  .callname { font-size: 26px; font-weight: 600; }
  .status { margin-top: 6px; color: #cfcfcf; font-size: 15px; }
  .emo { margin-top: 14px; font-size: 30px; letter-spacing: 6px; min-height: 38px; cursor: pointer; }
  .emohelp { font-size: 13px; color: #cfcfcf; max-width: 300px; margin: 6px auto 0; display: none; }
  .badge { display: inline-block; margin-top: 8px; font-size: 12px; padding: 3px 10px; border-radius: 10px; background: rgba(255,255,255,.12); }
  .controls { position: absolute; left: 0; right: 0; bottom: calc(36px + env(safe-area-inset-bottom)); z-index: 1;
    display: flex; justify-content: center; gap: 22px; }
  .cbtn { width: 64px; height: 64px; border-radius: 50%; background: rgba(255,255,255,.16); color: #fff; display: grid; place-items: center; }
  .cbtn.off { background: #fff; color: #111; }
  .cbtn.red { background: #e5484d; } .cbtn.green { background: #2fb36d; }
  .clabel { font-size: 12px; text-align: center; margin-top: 6px; color: #ddd; }
  .hidden { display: none !important; }
  svg { width: 24px; height: 24px; }
</style>

<button class="fab" aria-label="Calls">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l2 5l-2.5 1.5a11 11 0 0 0 5 5l1.5-2.5l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>
  <span class="dot"></span>
</button>

<div class="sheet" role="dialog" aria-label="Porchbook calls">
  <div class="join">
    <div class="row between"><h3>Calls</h3><button class="x close" aria-label="Close">×</button></div>
    <p class="muted">Enter the name other members will see. You can receive calls while Porchbook is open.</p>
    <input type="text" class="name" maxlength="30" placeholder="Your name" autocomplete="nickname" />
    <div class="err"></div>
    <button class="btn go">Go online</button>
  </div>
  <div class="online hidden">
    <div class="row between"><div><h3>Members online</h3><div class="muted me"></div></div><button class="x close" aria-label="Close">×</button></div>
    <div class="list"></div>
    <div class="toggle"><span>Peer-to-peer<br><span class="muted">Off hides your IP address but uses a relay</span></span><button class="switch p2p" aria-label="Peer-to-peer"></button></div>
    <button class="btn ghost leave">Go offline</button>
  </div>
</div>

<div class="screen">
  <video class="remote" autoplay playsinline></video>
  <video class="local" autoplay playsinline muted></video>
  <div class="top">
    <div class="big-avatar"></div>
    <div class="callname"></div>
    <div class="status"></div>
    <div class="emo" title="Tap to learn what these mean"></div>
    <div class="emohelp">If you both see the same four emojis, this call is end-to-end encrypted and nobody is listening in.</div>
    <span class="badge hidden"></span>
  </div>
  <div class="controls incoming-controls">
    <div><button class="cbtn red decline" aria-label="Decline">${icon("end")}</button><div class="clabel">Decline</div></div>
    <div><button class="cbtn green accept" aria-label="Accept">${icon("phone")}</button><div class="clabel">Accept</div></div>
  </div>
  <div class="controls active-controls hidden">
    <div><button class="cbtn mute" aria-label="Mute">${icon("mic")}</button><div class="clabel">Mute</div></div>
    <div class="camwrap"><button class="cbtn cam" aria-label="Camera">${icon("cam")}</button><div class="clabel">Camera</div></div>
    <div><button class="cbtn red hang" aria-label="End call">${icon("end")}</button><div class="clabel">End</div></div>
  </div>
</div>`;

  function icon(n) {
    const p = {
      phone: '<path d="M5 4h4l2 5l-2.5 1.5a11 11 0 0 0 5 5l1.5-2.5l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
      end: '<path d="M5 4h4l2 5l-2.5 1.5a11 11 0 0 0 5 5l1.5-2.5l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" transform="rotate(135 12 12)"/>',
      mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
      cam: '<rect x="3" y="7" width="12" height="10" rx="2"/><path d="M15 10l6-3v10l-6-3z"/>',
      video: '<rect x="3" y="7" width="12" height="10" rx="2"/><path d="M15 10l6-3v10l-6-3z"/>',
    }[n];
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + "</svg>";
  }

  const $ = (s) => root.querySelector(s);
  const $$ = (s) => root.querySelectorAll(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const initials = (n) => String(n).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

  const client = new CallClient({ url: SERVER_URL, allowP2P: store.get("p2p", true) });
  let online = false, muted = false, camOff = false, tick = null, ringer = null, reconnectTimer = null;

  const showSheet = (v) => ($(".sheet").style.display = v ? "block" : "none");
  const showScreen = (v) => ($(".screen").style.display = v ? "flex" : "none");
  function setView(isOnline) { $(".join").classList.toggle("hidden", isOnline); $(".online").classList.toggle("hidden", !isOnline); }
  function setP2P(on) { client.allowP2P = on; store.set("p2p", on); $(".p2p").classList.toggle("on", on); }
  setP2P(client.allowP2P);
  $(".name").value = store.get("name", "");

  $(".fab").onclick = () => showSheet($(".sheet").style.display !== "block");
  $$(".close").forEach((b) => (b.onclick = () => showSheet(false)));
  $(".p2p").onclick = () => setP2P(!client.allowP2P);
  $(".name").onkeydown = (e) => { if (e.key === "Enter") $(".go").click(); };

  async function goOnline(name) {
    $(".err").textContent = ""; $(".go").disabled = true; $(".go").textContent = "Connecting…";
    try {
      await client.connect(name);
      online = true; store.set("name", name); store.set("auto", true);
      $(".me").textContent = "You're online as " + client.myName;
      setView(true);
    } catch (e) {
      $(".err").textContent = e.message || "Couldn't connect";
      // Free hosts sleep when idle and take ~1 minute to wake: keep trying quietly.
      if (store.get("auto", false) && !/name/i.test(e.message || "")) { online = true; reconnect(5000); }
    } finally { $(".go").disabled = false; $(".go").textContent = "Go online"; }
  }
  $(".go").onclick = () => {
    const name = $(".name").value.trim();
    if (name.length < 2) { $(".err").textContent = "Enter at least 2 characters"; return; }
    goOnline(name);
  };
  $(".leave").onclick = () => { store.set("auto", false); online = false; client.disconnect(); setView(false); renderList([]); };

  function renderList(list) {
    const dot = $(".dot");
    dot.style.display = list.length ? "grid" : "none"; dot.textContent = list.length;
    $(".list").innerHTML = list.length ? list.map((u) => `
      <div class="member">
        <div class="avatar">${esc(initials(u.name))}</div>
        <div class="name">${esc(u.name)}</div>
        <button class="icon" data-id="${esc(u.id)}" data-name="${esc(u.name)}" data-video="0" aria-label="Voice call ${esc(u.name)}">${icon("phone")}</button>
        <button class="icon" data-id="${esc(u.id)}" data-name="${esc(u.name)}" data-video="1" aria-label="Video call ${esc(u.name)}">${icon("video")}</button>
      </div>`).join("")
      : '<div class="empty muted">No one else is online right now.</div>';
    $$(".list .icon").forEach((b) => (b.onclick = () => startCall(b.dataset.id, b.dataset.name, b.dataset.video === "1")));
  }
  client.on("presence", renderList);

  client.on("disconnected", ({ intentional }) => {
    renderList([]);
    if (intentional || !online) return;
    $(".me").textContent = "Reconnecting…";
    reconnect(3000);
  });
  function reconnect(delay) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => {
      if (!online) return;
      try {
        await client.connect(store.get("name", ""));
        $(".me").textContent = "You're online as " + client.myName;
        $(".err").textContent = ""; setView(true);
      } catch { reconnect(Math.min(delay * 2, 30000)); }
    }, delay);
  }

  // ---------- call screen
  const STATUS = { preparing: "Starting…", ringing: "Ringing…", connecting: "Connecting…", reconnecting: "Reconnecting…" };
  const ENDED = {
    hangup: "Call ended", "remote-hangup": "Call ended", declined: "Declined", busy: "Busy on another call",
    unavailable: "Not online", "no-answer": "No answer", missed: "Missed call", "connection-failed": "Couldn't connect",
    "connection-lost": "Connection lost", "security-check-failed": "Security check failed — call stopped",
    "signaling-lost": "Connection lost", "no-permission": "Microphone/camera permission denied", error: "Call failed",
  };

  function openScreen(name, video, incoming) {
    showSheet(false);
    muted = false; camOff = false;
    $(".mute").classList.remove("off"); $(".cam").classList.remove("off");
    $(".big-avatar").textContent = initials(name);
    $(".big-avatar").classList.remove("hidden");
    $(".callname").textContent = name;
    $(".emo").textContent = ""; $(".emohelp").style.display = "none";
    $(".badge").classList.add("hidden");
    $(".camwrap").classList.toggle("hidden", !video);
    $(".incoming-controls").classList.toggle("hidden", !incoming);
    $(".active-controls").classList.toggle("hidden", incoming);
    $(".remote").srcObject = null; $(".local").srcObject = null; $(".local").style.display = "none";
    showScreen(true);
  }

  async function startCall(id, name, video) {
    openScreen(name, video, false);
    $(".status").textContent = "Starting…";
    try { await client.call(id, name, video); } catch (e) { /* "ended" handler shows the reason */ }
  }

  client.on("incoming", ({ name, video }) => {
    openScreen(name, video, true);
    $(".status").textContent = video ? "Incoming video call" : "Incoming voice call";
    startRinging();
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      try { new Notification("Porchbook call", { body: name + " is calling" }); } catch {}
    }
  });
  $(".accept").onclick = () => {
    stopRinging();
    $(".incoming-controls").classList.add("hidden");
    $(".active-controls").classList.remove("hidden");
    client.accept();
  };
  $(".decline").onclick = () => { stopRinging(); client.decline(); };
  $(".hang").onclick = () => client.hangup();
  $(".mute").onclick = () => { muted = !muted; client.setMuted(muted); $(".mute").classList.toggle("off", muted); };
  $(".cam").onclick = () => { camOff = !camOff; client.setCameraOff(camOff); $(".cam").classList.toggle("off", camOff); };
  $(".emo").onclick = () => { const h = $(".emohelp"); h.style.display = h.style.display === "block" ? "none" : "block"; };

  client.on("state", (s) => {
    if (s === "connected") {
      const t0 = Date.now(); clearInterval(tick);
      const fmt = () => { const s = Math.floor((Date.now() - t0) / 1000); $(".status").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
      fmt(); tick = setInterval(fmt, 1000);
    } else { clearInterval(tick); $(".status").textContent = STATUS[s] || s; }
  });
  client.on("local", (stream) => {
    if (stream.getVideoTracks().length) { $(".local").srcObject = stream; $(".local").style.display = "block"; }
  });
  client.on("remote", (stream) => {
    const v = $(".remote"); v.srcObject = stream; v.play && v.play().catch(() => {});
    if (stream.getVideoTracks().length) $(".big-avatar").classList.add("hidden");
  });
  client.on("emojis", (e) => ($(".emo").textContent = e.join(" ")));
  client.on("route", (r) => {
    const b = $(".badge"); b.textContent = r === "p2p" ? "Direct connection" : "Via relay"; b.classList.remove("hidden");
  });
  client.on("ended", ({ reason }) => {
    stopRinging(); clearInterval(tick);
    $(".status").textContent = ENDED[reason] || "Call ended";
    $(".incoming-controls").classList.add("hidden"); $(".active-controls").classList.add("hidden");
    $(".remote").srcObject = null; $(".local").srcObject = null;
    setTimeout(() => { if (!client.c) showScreen(false); }, 1800);
  });

  // ---------- ringtone (works once the person has tapped anything on the page)
  let audioCtx = null;
  document.addEventListener("pointerdown", () => {
    try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch {}
  }, { passive: true });
  function startRinging() {
    stopRinging();
    const beep = () => {
      if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
      if (!audioCtx) return;
      const t = audioCtx.currentTime;
      [0, 0.5].forEach((off) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = 440; o.connect(g); g.connect(audioCtx.destination);
        g.gain.setValueAtTime(0.0001, t + off); g.gain.exponentialRampToValueAtTime(0.25, t + off + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.4);
        o.start(t + off); o.stop(t + off + 0.42);
      });
    };
    beep(); ringer = setInterval(beep, 2500);
  }
  function stopRinging() { clearInterval(ringer); ringer = null; if (navigator.vibrate) navigator.vibrate(0); }

  // ---------- mount
  function mount() {
    document.body.appendChild(host);
    if (!window.RTCPeerConnection || !navigator.mediaDevices) {
      $(".fab").onclick = () => alert("This browser doesn't support calls. Try the latest Chrome or Safari.");
      return;
    }
    if (store.get("auto", false) && store.get("name", "")) goOnline(store.get("name", ""));
    if ("Notification" in window && Notification.permission === "default") {
      $(".go").addEventListener("click", () => { try { Notification.requestPermission(); } catch {} }, { once: true });
    }
  }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
