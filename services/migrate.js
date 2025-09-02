const fs = require('fs');
const path = require('path');

async function runMigrations(sequelize) {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  if (!fs.existsSync(migrationsDir)) return;
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const full = path.join(migrationsDir, f);
    const sql = fs.readFileSync(full, 'utf-8');
    console.log('[migrate] applying', f);
    await sequelize.query(sql);
  }
  console.log('[migrate] done');
}
module.exports = { runMigrations };