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

const depth = new WeakMap(); // db -> open transaction nesting

/**
 * Run fn inside a transaction; rolls back and rethrows on error. Nested calls
 * join the outer transaction, so repositories can batch writes freely.
 */
export function transaction(db, fn) {
  const d = depth.get(db) ?? 0;
  if (d > 0) {
    depth.set(db, d + 1);
    try {
      return fn();
    } finally {
      depth.set(db, d);
    }
  }
  db.exec('BEGIN');
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth.set(db, 0);
  }
}

/** SQL expression that floors `ts` to a bucket boundary (integer division). */
export const bucketExpr = '(ts / CAST(? AS INTEGER)) * CAST(? AS INTEGER)';
