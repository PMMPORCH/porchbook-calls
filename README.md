# Porchbook Calls — setup guide

Telegram-style 1-to-1 voice and video calls for Porchbook:
ringing, online-members list, end-to-end encryption, 4-emoji security check,
direct connection with relay fallback, and a peer-to-peer on/off switch.

```
porchbook-calls/
├── server.js                  call server (ringing, online list, serves the widget)
├── package.json
├── render.yaml                one-click settings for Render
└── porchbook-calls.js         the call button + screens that appear on Porchbook
```

Your Grok site can't run a server itself, so the call server lives on a free host
and Porchbook just loads one script from it. About 15 minutes total.

---

## Step 1 — Get a free TURN relay (5 min)

Needed for calls on mobile data and strict Wi-Fi, and for "Peer-to-peer: off".

1. Sign up at **metered.ca** → TURN Server → free plan (20 GB/month).
2. In the dashboard, create a credential. Note:
   - the TURN URLs (e.g. `turn:global.relay.metered.ca:80`, `turns:global.relay.metered.ca:443?transport=tcp`)
   - the username and password

(Cloudflare Calls TURN or your own `coturn` server also work.)

## Step 2 — Put the server online (10 min)

1. Create a free **GitHub** account and a new repository called `porchbook-calls`.
   Upload all five files in this folder.
2. Sign up at **render.com** → New → **Blueprint** → pick the repository.
   Render reads `render.yaml` and asks for:
   - `TURN_URLS` → the URLs from step 1, separated by commas
   - `TURN_USERNAME` → the username
   - `TURN_CREDENTIAL` → the password
3. Deploy. You get an address like `https://porchbook-calls.onrender.com`.
4. Test: open `https://porchbook-calls.onrender.com/demo` on two phones, go online
   with two names, and call. Both screens should show the same four emojis.

## Step 3 — Add it to Porchbook

Paste this into Grok (replace the address with yours):

> Add this script tag just before the closing `</body>` tag on every page of Porchbook,
> exactly as written, and don't change anything else:
> `<script src="https://porchbook-calls.onrender.com/porchbook-calls.js"></script>`

A green call button appears at the bottom-right. Members tap it, enter a name,
and see who else is online.

If Porchbook ever moves to a new address, update `ALLOWED_ORIGINS` on Render
(comma-separated), or the server will refuse connections from the new address.

---

## Good to know

- **Free Render servers sleep after 15 minutes idle** and take about a minute to wake.
  The widget keeps retrying on its own. For instant availability, use Render's
  paid Starter plan (~$7/month) or ping the server every 10 minutes with a free
  uptime monitor such as UptimeRobot.
- **People can only receive calls while Porchbook is open** in their browser.
  Ringing a closed phone needs Web Push notifications, which can be added later.
- **Names are first-come** because Porchbook has no accounts yet: the server only stops
  two people using the same name *at the same time*. When you add logins, check the
  member's login in the `register` section of `server.js`.
- **iPhone:** works in Safari. Members should tap anywhere on the page once so the
  ringtone is allowed to play.
- **What the server sees:** who calls whom and when. It never receives the audio,
  video or encryption keys.

## How the security works (same idea as Telegram)

1. The caller sends a hash of its key fingerprint when ringing (a commitment).
2. The callee reveals its fingerprint when accepting.
3. The caller reveals its real fingerprint; the callee checks it matches the hash.
   Any mismatch stops the call with "Security check failed".
4. Both phones turn both fingerprints into 4 emojis. Same emojis on both screens
   means nobody is in the middle.
5. Audio and video are encrypted end-to-end by WebRTC (DTLS-SRTP).
