const Database = require("better-sqlite3")
const path = require("path")
const fs = require("fs")

let db

function setupDatabase() {
  const dbPath = path.join(__dirname, "../../data/attendance.db")

  // Ensure data directory exists
  const dataDir = path.dirname(dbPath)
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  db = new Database(dbPath)

  // Enable foreign keys
  db.pragma("foreign_keys = ON")

  // Create tables
  createTables()

  // Create indexes for performance
  createIndexes()

  console.log("Database initialized successfully")
  return db
}

function createTables() {
  // Employees table
  db.exec(`
    CREATE TABLE IF NOT EXISTS employees (
      uid INTEGER PRIMARY KEY,
      id_number TEXT UNIQUE,
      id_barcode TEXT UNIQUE,
      first_name TEXT NOT NULL,
      middle_name TEXT,
      last_name TEXT NOT NULL,
      email TEXT,
      department TEXT,
      status TEXT DEFAULT 'Active',
      profile_picture TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // Attendance table
  db.exec(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_uid INTEGER,
      id_number TEXT,
      clock_type TEXT CHECK(clock_type IN ('morning_in', 'morning_out', 'afternoon_in', 'afternoon_out')),
      clock_time DATETIME,
      regular_hours REAL DEFAULT 0,
      overtime_hours REAL DEFAULT 0,
      date TEXT,
      is_synced INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_uid) REFERENCES employees (uid)
    )
  `)

  try {
    db.exec(`ALTER TABLE attendance ADD COLUMN is_late INTEGER DEFAULT 0`)
  } catch (error) {
    // Column already exists, ignore error
  }

  // Settings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // Insert default settings
  const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
  insertSetting.run("server_url", "http://192.168.1.71:3001/api/tables/emp_list/data")
  insertSetting.run("sync_interval", "300000") // 5 minutes
  insertSetting.run("grace_period", "5") // 5 minutes
}

function createIndexes() {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_employees_id_number ON employees (id_number);
    CREATE INDEX IF NOT EXISTS idx_employees_id_barcode ON employees (id_barcode);
    CREATE INDEX IF NOT EXISTS idx_attendance_employee_uid ON attendance (employee_uid);
    CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance (date);
    CREATE INDEX IF NOT EXISTS idx_attendance_clock_time ON attendance (clock_time);
  `)
}

function getDatabase() {
  return db
}

module.exports = {
  setupDatabase,
  getDatabase,
}
