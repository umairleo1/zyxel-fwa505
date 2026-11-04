# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue: use GitHub's **Report a vulnerability** button (Security → Advisories) on this repository, or contact the maintainer directly. Include steps to reproduce and the version or commit you tested. You can expect an acknowledgement within a week.

## Threat model

Zyxel Insight is a single-user tool for a home or small-office LAN.

- **Where it runs:** on a computer inside the same LAN as the router. It is not designed to be exposed to the internet; never port-forward it. By default the web UI binds to `127.0.0.1`. On a LAN address it refuses to start without `DASHBOARD_PASSWORD` (HTTP Basic auth). Basic auth over plain HTTP is only as private as the network it crosses; use a TLS reverse proxy if that matters.
- **What it can do to the router:** read only. The router client refuses every non-GET request except login and logout, and only reads an explicit allowlist of endpoints. Insight cannot change settings, reboot the router or clear its log.
- **Browser attacks it defends against:** DNS rebinding (Host allowlist), cross-site requests (custom header plus Origin check on state-changing requests), clickjacking and script injection (CSP, `X-Frame-Options`), and spreadsheet formula injection in CSV exports.
- **Network inputs:** the syslog and SNMP trap listeners accept packets only from the router and loopback by default, and cap stored rows per minute. Anyone who can spoof the router's IP on your LAN can still inject log lines.
- **Out of scope:** an attacker who already has a shell on the machine running Insight, or the router's admin password.

## What is stored

- **`.env`:** the router admin password (and `DASHBOARD_PASSWORD`) in plain text. Keep the file readable only by the user running Insight.
- **SQLite database** (`server/data/insight.db` and periodic copies in `server/data/backups/`): router logs, signal and traffic history, connected devices (MAC addresses, host names, IPs) and reboot/outage history. Router credentials (Wi-Fi passphrase, SNMP communities, service passwords) are **not** stored, and are masked before any router data reaches the browser. Device identifiers such as IMEI, IMSI, ICCID and serial number are shown to logged-in users on purpose.

Nothing is sent anywhere except to the router.
