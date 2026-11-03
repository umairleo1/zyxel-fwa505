/** Prepared-statement cache: each distinct SQL string is compiled once. */
export function statementCache(db) {
  const cache = new Map();
  return (sql) => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      cache.set(sql, stmt);
    }
    return stmt;
  };
}

/** Run fn inside a transaction; rolls back and rethrows on error. */
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** SQL expression that floors `ts` to a bucket boundary (integer division). */
export const bucketExpr = '(ts / CAST(? AS INTEGER)) * CAST(? AS INTEGER)';
