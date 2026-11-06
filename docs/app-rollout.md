# Installing ProcessGuard as an app

ProcessGuard is an installable web app (PWA). Once it is served over HTTPS, Edge and Chrome offer
**Install**, Android adds it like a normal app, and iPhone/iPad can add it to the home screen. It
opens in its own window with the ProcessGuard icon, and an installed copy still opens while the
server restarts.

Nothing below changes the M5 pagers or the Teams bridge.

> Examples use `andon.fivestar.local` as the hostname and `192.168.26.2` as the server. Replace
> both with your real values.

## What is needed

| Who | What |
|---|---|
| IT / DNS | A hostname that points to the app server |
| IT / security | A TLS certificate for that hostname (Option A or B below) |
| IT / server | Permission to install Caddy **or** configure IIS on the app VM; inbound TCP 443 open |
| IT / device management | Trust for the certificate on devices that are not domain-joined (Option A only); optional silent-install policy |
| App owner | The hostname to use, and which devices are company-managed |
| IT / network | For call notifications: the app server can reach the phone makers' push services over outbound HTTPS 443 (step 9) |

## Order of work

1. [Pick the hostname and add DNS](#1-hostname-and-dns)
2. [Get a certificate](#2-certificate)
3. [Put HTTPS in front of the app](#3-https-in-front-of-the-app)
4. [Update `.env` and restart](#4-update-env-and-restart)
5. [Keep port 5003 for pagers](#5-keep-port-5003-for-pagers)
6. [Check it from one PC](#6-check-it-from-one-pc)
7. [Install on devices](#7-install-on-devices)
8. [Retire the old address](#8-retire-the-old-address)
9. [Turn on call notifications](#9-call-notifications-on-phones)

---

## 1. Hostname and DNS

Create an internal DNS **A record**:

```text
andon.fivestar.local  ->  192.168.26.2
```

Check from any PC on the plant network:

```powershell
Resolve-DnsName andon.fivestar.local
```

## 2. Certificate

Browsers only install apps from addresses with a trusted certificate. A self-signed certificate is
**not** enough: the install option will not appear.

### Option A: company certificate authority (internal name)

Best when every device that will use the app is domain-joined or managed.

1. Request a **Web Server** certificate from the company CA (AD CS) with:
   - Subject alternative name (DNS): `andon.fivestar.local`
   - Exportable private key
2. Export it as a `.pfx` with the private key.
3. Domain-joined Windows PCs already trust the company CA. For anything else (Android tablets,
   iPhones, non-domain PCs), install the company **root CA** certificate through device management
   (Intune/MDM) or manually.

Caddy needs PEM files. Convert the `.pfx` with the OpenSSL that ships with Git for Windows:

```powershell
$openssl = "C:\Program Files\Git\usr\bin\openssl.exe"
New-Item -ItemType Directory -Force C:\certs | Out-Null
& $openssl pkcs12 -in andon.pfx -clcerts -nokeys -out C:\certs\andon.crt
& $openssl pkcs12 -in andon.pfx -nocerts -nodes -out C:\certs\andon.key
```

Restrict `C:\certs\andon.key` so only administrators and the service account can read it.

### Option B: public subdomain with Let's Encrypt

Best when phones or tablets are not managed, because every device already trusts Let's Encrypt.

- Use a subdomain of a domain the company owns, for example `andon.fivestar.com`.
- Point it at `192.168.26.2` in **internal** DNS only. The server does not need to be reachable
  from the internet.
- Prove ownership with a **DNS challenge**. This needs API access to the company's public DNS
  provider. Caddy does this when downloaded with that provider's DNS module
  (caddyserver.com/download); with IIS, use win-acme with DNS validation.
- Renewal is automatic every ~60 days.

## 3. HTTPS in front of the app

The app keeps running on port 5003. A reverse proxy listens on 443 with the certificate and forwards
to it. Use **one** of the two options.

### Option 1: Caddy (recommended)

Caddy is a single `.exe` and forwards the live-update WebSocket automatically.

1. Download `caddy.exe` to `C:\caddy\`.
2. Create `C:\caddy\Caddyfile`:

   ```text
   andon.fivestar.local {
       tls C:\certs\andon.crt C:\certs\andon.key
       reverse_proxy 127.0.0.1:5003
   }
   ```

   For Option B (Let's Encrypt), replace the `tls` line with the DNS-challenge settings for your
   DNS provider.

3. Test it in a console first:

   ```powershell
   C:\caddy\caddy.exe run --config C:\caddy\Caddyfile
   ```

4. Install it as a service with NSSM (the same tool `scripts\windows\install-service.ps1` uses):

   ```powershell
   nssm install Caddy C:\caddy\caddy.exe run --config C:\caddy\Caddyfile
   nssm set Caddy Start SERVICE_AUTO_START
   Start-Service Caddy
   ```

   If `nssm` is not found, install it with `winget install -e --id NSSM.NSSM` and open a new
   Administrator PowerShell.

### Option 2: IIS

Use this if IT standardises on IIS.

1. Install IIS with the **WebSocket Protocol** feature. Without it, pages load but live updates stop.
2. Install the **URL Rewrite** and **Application Request Routing (ARR)** modules.
3. IIS Manager -> server node -> Application Request Routing Cache -> Server Proxy Settings ->
   tick **Enable proxy**.
4. Create a site with an **https** binding on 443 for `andon.fivestar.local` using the certificate.
5. Add a URL Rewrite rule on that site: match `(.*)`, action **Rewrite** to
   `http://127.0.0.1:5003/{R:1}`.

### Open the firewall

```powershell
New-NetFirewallRule -DisplayName "ProcessGuard Andon HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow
```

## 4. Update `.env` and restart

Edit `.env` on the server:

```env
PUBLIC_URL="https://andon.fivestar.local"

# Keep the old address listed until every device has moved over (step 8).
CORS_ORIGIN="https://andon.fivestar.local,http://192.168.26.2:5003"

# The proxy is now in front of the app, so rate limits apply per device instead of to the proxy.
TRUST_PROXY=true
```

Keep `HOST=0.0.0.0` and `PORT=5003`. Then restart:

```powershell
Restart-Service ProcessGuardAndon
```

## 5. Keep port 5003 for pagers

The M5 pagers call `http://192.168.26.2:5003` (`PAGER_API_BASE_URL` in the firmware) and cannot use
HTTPS without a firmware change. **Do not close port 5003.**

Once the browser rollout is finished, you can narrow the existing 5003 firewall rule to the pager
addresses or subnet (and the server itself):

```powershell
Set-NetFirewallRule -DisplayName "ProcessGuard Andon 5003" -RemoteAddress 192.168.26.0/24
```

The Teams bridge talks to `http://127.0.0.1:5003` on the server and is not affected.

## 6. Check it from one PC

Open `https://andon.fivestar.local` in Edge.

- [ ] Padlock shows, with no certificate warning.
- [ ] Sign-in works and live updates arrive (raise and clear a test call from another device).
- [ ] An **Install** icon appears in the address bar.
- [ ] `F12` -> **Application** -> **Manifest** shows "ProcessGuard Andon" with no errors.
- [ ] `F12` -> **Application** -> **Service workers** shows `sw.js` as *activated and running*.
- [ ] Install it, then stop the app service (`Stop-Service ProcessGuardAndon`) and reopen the
      window: it should still open and show its offline state. Start the service again.

## 7. Install on devices

The new address starts with empty browser storage, so on first open **each person signs in again
and each Machine Station picks its machine again**. Plan this per area.

### Windows PCs, by hand

Open the address in Edge -> **Install** icon in the address bar (or `...` -> **Apps** ->
**Install this site as an app**). It appears in the Start menu with the ProcessGuard icon.

### Windows PCs, pushed by IT

Edge policy **WebAppInstallForceList** (Group Policy or Intune) installs it silently for every user:

```json
[
  {
    "url": "https://andon.fivestar.local/",
    "default_launch_container": "window",
    "create_desktop_shortcut": true
  }
]
```

### Machine Station and floor screens

Use an auto-sign-in Windows account and have the installed app start at sign-in: open `edge://apps`,
choose the app's `...` menu and turn on **Start app when you sign in**. Make it full screen with
`F11`.

Edge **kiosk mode** (Windows Assigned Access) also works, but it clears browsing data when its session
resets. That signs the station out and forgets its machine. Test it before relying on it.

### Android phones and tablets

Chrome -> open the address -> `...` -> **Install app**.

### iPhone and iPad

Safari -> open the address -> **Share** -> **Add to Home Screen**.

## 8. Retire the old address

When every device uses the HTTPS address:

1. Remove `http://192.168.26.2:5003` from `CORS_ORIGIN` and restart the service.
2. Narrow the 5003 firewall rule to pagers only (step 5).
3. Update bookmarks, shortcuts and any printed QR codes.

## 9. Call notifications on phones

Once the app is on HTTPS, responders can get a notification on their phone when a machine calls
their department, even with the app closed. They also get a quieter one when someone accepts the call
(so two people don't both go), and one for a message on a call they accepted or are helping on.

**Server, once:**

```powershell
cd C:\Apps\processguard-andon
npm run push:keys
```

Paste the three lines it prints into `.env` (put an IT mailbox in `VAPID_SUBJECT`), then restart:

```powershell
Restart-Service ProcessGuardAndon
```

Keep these keys. New keys switch notifications off on every phone until each person turns them on
again. Without keys, notifications stay off and the app doesn't offer them.

**Network:** the app server sends each notification to the phone maker's push service. Allow outbound
HTTPS (443) from the server to:

| Devices | Host |
|---|---|
| Android, Chrome, Edge on Windows | `fcm.googleapis.com`, `*.notify.windows.com` |
| iPhone, iPad, Safari on Mac | `*.push.apple.com` |
| Firefox | `updates.push.services.mozilla.com` |

If the server's outbound traffic goes through an inspecting proxy, use the same setup that already
lets the Power Automate notifications out (for example `NODE_EXTRA_CA_CERTS` for the proxy's
certificate).

**Each person:** open the app → **Response Queue** → **Turn on** in the card at the top (or the bell in
the header) → **Allow**.

- **Android:** works in Chrome, installed or not.
- **iPhone and iPad:** needs iOS 16.4 or later, and only works in the app added to the Home Screen
  (step 7), not in a Safari tab. The card explains this on an iPhone.
- **Shared phones:** a phone belongs to whoever last signed in on it. Signing out stops its
  notifications.
- **Silent mode:** a web app can't ring through silent or Do Not Disturb. People on call should
  leave notifications audible for the ProcessGuard app.

**Check it:** turn notifications on, close the app, then raise a test call for that department from
another device. The phone should show "Press 9 needs Maintenance" within a few seconds.

## Rolling back

Stop the proxy (`Stop-Service Caddy`, or stop the IIS site). The old `http://192.168.26.2:5003`
address keeps working throughout, as long as it is still listed in `CORS_ORIGIN`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| No **Install** icon | The certificate is not trusted on that device (check the padlock), or the page is still on `http://`. Check `F12` -> Application -> Manifest for errors. |
| Pages load but calls do not update live | WebSockets are not reaching the app. On IIS, install the **WebSocket Protocol** feature. |
| "CORS origin not allowed" or sign-in fails on the new address | The HTTPS address is missing from `CORS_ORIGIN`. Add it and restart. |
| Station signed out or forgot its machine | Expected once per device after moving to the new address. If it keeps happening, the browser is clearing its data (kiosk mode, private window, cleanup policy). |
| Still showing the previous version after a deploy | Close the app window and open it again. The new version loads on the next open. |
| Pagers stopped working | Port 5003 was closed or narrowed too far. See step 5. |
| No notifications bell or card on the Response Queue | The page isn't on `https://`, the keys aren't in `.env` (step 9), or this is an iPhone in a Safari tab (add it to the Home Screen first). |
| Bell is greyed out | Notifications are blocked for this site: the phone's Settings -> Notifications (iPhone: the ProcessGuard app; Android: Chrome -> the site). |
| Turned on but nothing arrives | Check the server log for "push to ... failed". Usually outbound 443 to the push service is blocked (step 9). |
