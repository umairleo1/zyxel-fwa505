# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue: use GitHub's **Report a vulnerability** button (Security → Advisories) on this repository, or contact the maintainer directly. Include steps to reproduce and the version or commit you tested. You can expect an acknowledgement within a week.

## Threat model

Zyxel Insight is a single-user tool for a home or small-office LAN.

- **Where it runs:** on a computer inside the same LAN as the router. It is not designed to be exposed to the internet; never port-forward it. By default the web UI binds to `127.0.0.1`. On a LAN address it refuses to start without `DASHBOARD_PASSWORD` (HTTP Basic auth). Basic auth over plain HTTP is only as private as the network it crosses; use a TLS reverse proxy if that matters.
- **What it can do to the router:** read, plus SMS and the band selection. The router client refuses every non-GET request except login, logout, SMS writes and band-selection writes, and only reads an explicit allowlist of endpoints. SMS writes (send, mark read, delete) can reach only `/cgi-bin/DAL?oid=cellwan_sms` with a fixed set of parameters, and only while `SMS_ENABLED` is on. Band-selection writes are a `PUT` to `/cgi-bin/DAL?oid=cellwan_band` with nothing else on the URL, only while `RADIO_CONTROL_ENABLED` is on. Both are on by default; set both to `false` for a fully read-only Insight. Insight cannot change any other setting, reboot the router or clear its log.
- **SMS and cost:** anyone who can open the dashboard can send texts from the router's SIM, at your plan's rates. Sends are limited to 5 a minute and 30 an hour and are logged (number partly masked, no text). If the dashboard is reachable by others on your LAN, set `DASHBOARD_PASSWORD` or turn SMS off.
- **Band selection and connectivity:** anyone who can open the dashboard can change which bands the modem uses, and a poor choice can slow or drop mobile data. Each change is a trial that Insight reverts after 5 minutes unless someone presses Keep (the pending revert survives a restart), changes are spaced at least 15 s apart, and each is logged. The router stays reachable on the LAN throughout, so a revert never depends on the mobile connection. If the dashboard is reachable by others on your LAN, set `DASHBOARD_PASSWORD` or turn radio control off.
- **Browser attacks it defends against:** DNS rebinding (Host allowlist), cross-site requests (custom header plus Origin check on every state-changing request, including SMS send and delete and band changes), clickjacking and script injection (CSP, `X-Frame-Options`), and spreadsheet formula injection in CSV exports.
- **Network inputs:** the syslog and SNMP trap listeners accept packets only from the router and loopback by default, and cap stored rows per minute. Anyone who can spoof the router's IP on your LAN can still inject log lines.
- **Out of scope:** an attacker who already has a shell on the machine running Insight, or the router's admin password.

## What is stored

- **`.env`:** the router admin password (and `DASHBOARD_PASSWORD`) in plain text. Keep the file readable only by the user running Insight.
- **SQLite database** (`server/data/insight.db` and periodic copies in `server/data/backups/`): router logs, signal and traffic history, connected devices (MAC addresses, host names, IPs) and reboot/outage history. SMS messages are **not** stored: they're read live from the SIM each time the Messages tab is open. What Insight does keep about SMS: the event log of each send and delete (number partly masked, no text), the time of each send keyed by a hash of the message (the router records none), and your own number if you type it in on the Messages page. Router credentials (Wi-Fi passphrase, SNMP communities, service passwords) are **not** stored, and are masked before any router data reaches the browser. Device identifiers such as IMEI, IMSI, ICCID and serial number are shown to logged-in users on purpose.

Nothing is sent anywhere except to the router.
