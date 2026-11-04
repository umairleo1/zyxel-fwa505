/**
 * One CSV cell. Text starting with = + - @ tab or CR is prefixed with an
 * apostrophe so a spreadsheet shows it instead of evaluating it as a formula:
 * log lines come from the network and can be written by anyone who can send syslog.
 */
export function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (cells) => `${cells.map(csvCell).join(',')}\n`;

// Plain listeners rather than events.once: a losing once() promise would later
// reject on 'error' and surface as an unhandled rejection.
const drainOrClose = (res) =>
  new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });

/**
 * Write chunks to `res`, waiting for 'drain' whenever its buffer is full, so a
 * long export streams instead of piling up in memory. Stops early (returns false)
 * once the client has gone away.
 */
export async function writeAll(res, chunks) {
  let closed = res.destroyed || res.writableEnded;
  const onClose = () => (closed = true);
  res.on('close', onClose);
  try {
    for await (const chunk of chunks) {
      if (closed) return false;
      if (!res.write(chunk)) {
        await drainOrClose(res);
      }
    }
    return !closed;
  } finally {
    res.off('close', onClose);
  }
}
