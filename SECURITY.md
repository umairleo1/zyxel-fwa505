# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue: use GitHub's **Report a vulnerability** button (Security → Advisories) on this repository, or contact the maintainer directly. Include steps to reproduce and the version or commit you tested. You can expect an acknowledgement within a week.

## Threat model

Zyxel Insight is a single-user tool for a home or small-office LAN.

- **Where it runs:** on a computer inside the same LAN as the router. It is not designed to be exposed to the internet; never port-forward it. By default the web UI binds to `127.0.0.1`. On a LAN address it refuses to start without `DASHBOARD_PASSWORD` (HTTP Basic auth). Basic auth over plain HTTP is only as private as the network it crosses; use a TLS reverse proxy if that matters.
- **What it can do to the router:** read, plus dedicated SMS, band selection, restart and High control operations. Each control has a narrow transport allowlist and its own feature flag. High control adds firmware settings/check/installation, router configuration export/restore, ROM-D defaults, partial reset, diagnostics, WAN editing, account management and supported Z-console redirection. Role checks use the router's session information; browser-provided role values do not grant privileges. `SMS_ENABLED=false`, `RADIO_CONTROL_ENABLED=false`, `REBOOT_ENABLED=false` and `HIGH_CONTROL_ENABLED=false` make Insight read-only. Log deletion is never allowed.
- **Maintenance and credentials:** anyone with dashboard access can invoke enabled controls permitted by the configured router account. High control serializes operations and validates patches against fresh configuration on the server. Masked password placeholders are never written back. Disruptive operations require explicit confirmations, and ambiguous failures are not automatically replayed. Account changes that would invalidate Insight's configured login are rejected. WAN changes can remove management access; no guaranteed host-side rollback is claimed. Exported router backups may contain credentials and are downloaded without caching rather than stored in the database.
- **SMS and cost:** anyone who can open the dashboard can send texts from the router's SIM, at your plan's rates. Sends are limited to 5 a minute and 30 an hour and are logged (number partly masked, no text). If the dashboard is reachable by others on your LAN, set `DASHBOARD_PASSWORD` or turn SMS off.
- **Band selection and connectivity:** anyone who can open the dashboard can change which bands the modem uses, and a poor choice can slow or drop mobile data. Each change is a trial that Insight reverts after 5 minutes unless someone presses Keep (the pending revert survives a restart), changes are spaced at least 15 s apart, and each is logged. The router stays reachable on the LAN throughout, so a revert never depends on the mobile connection. If the dashboard is reachable by others on your LAN, set `DASHBOARD_PASSWORD` or turn radio control off.
- **Browser attacks it defends against:** DNS rebinding (Host allowlist), cross-site requests (custom header plus Origin check on every state-changing request, including SMS send and delete and band changes), clickjacking and script injection (CSP, `X-Frame-Options`), and spreadsheet formula injection in CSV exports.
- **Network inputs:** the syslog, SNMP and TCP Z-console listeners accept data only from the router and loopback by default, and cap stored rows per minute. Z-console limits connections and unfinished line sizes and never executes received text. Anyone who can spoof the router's IP on your LAN can still inject log lines.
- **Out of scope:** an attacker who already has a shell on the machine running Insight, or the router's admin password.

## What is stored

- **`.env`:** the router admin password (and `DASHBOARD_PASSWORD`) in plain text. Keep the file readable only by the user running Insight.
- **SQLite database** (`server/data/insight.db` and periodic copies in `server/data/backups/`): router logs, signal and traffic history, connected devices (MAC addresses, host names, IPs) and reboot/outage history. SMS messages are **not** stored: they're read live from the SIM each time the Messages tab is open. What Insight does keep about SMS: the event log of each send and delete (number partly masked, no text), the time of each send keyed by a hash of the message (the router records none), and your own number if you type it in on the Messages page. Router credentials (Wi-Fi passphrase, SNMP communities, service passwords) are **not** stored, and are masked before any router data reaches the browser. Device identifiers such as IMEI, IMSI, ICCID and serial number are shown to logged-in users on purpose.

Nothing is sent anywhere except to the router.
