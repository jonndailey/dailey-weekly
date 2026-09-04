// Auto-migration runner — runs on startup before the app starts
// Reads SQL files from ./migrations/ in order and tracks what's been applied

const mysql = require('mysql2/promise');

async function migrate() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log('[migrate] No DATABASE_URL set, skipping migrations');
    return;
  }

  console.log('[migrate] Connecting to database...');
  // multipleStatements lets the SERVER parse each migration file, replacing
  // the old client-side split(';') that broke on semicolons inside string
  // literals. Scoped to this dedicated, short-lived migration connection.
  // Retry with exponential backoff: on cold start the DB may be a moment behind
  // the app, so a transient connect failure retries rather than crash-looping
  // the pod. 5 attempts over ~1+2+4+8s before giving up.
  let connection;
  for (let attempt = 1; ; attempt += 1) {
    try {
      connection = await mysql.createConnection({ uri: dbUrl, multipleStatements: true });
      break;
    } catch (err) {
      if (attempt >= 5) {
        console.error(`[migrate] Could not connect after ${attempt} attempts:`, err.message);
        throw err;
      }
      const delayMs = 1000 * Math.pow(2, attempt - 1);
      console.warn(`[migrate] Connect attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const [applied] = await connection.execute('SELECT name FROM _migrations ORDER BY id');
  const appliedSet = new Set(applied.map(r => r.name));

  const fs = require('fs');
  const path = require('path');
  const migrationsDir = path.join(__dirname, 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    console.log('[migrate] No migrations directory found');
    await connection.end();
    return;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (appliedSet.has(file)) continue;

    console.log(`[migrate] Running: ${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    // query(), not execute(): prepared statements can't run multi-statement
    // batches. The server's real SQL parser handles quoted semicolons.
    if (sql.trim().length > 0) {
      await connection.query(sql);
    }

    await connection.execute('INSERT INTO _migrations (name) VALUES (?)', [file]);
    ran++;
  }

  console.log(`[migrate] Done. ${ran} migration(s) applied, ${files.length} total.`);
  await connection.end();
}

module.exports = { migrate };
if (require.main === module) migrate().catch(e => { console.error(e); process.exit(1); });
