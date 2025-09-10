const Database = require("better-sqlite3")
const path = require("path")
const fs = require("fs")
const { app } = require("electron")

let db

function getProductionSafeDatabasePath() {
  const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev')
  
  if (isDev) {
    // Development: Use relative path from setup.js location
    return path.join(__dirname, "../../data/attendance.db")
  } else {
    // Production: Use app's user data directory (persistent across updates)
    const userDataPath = app.getPath('userData')
    return path.join(userDataPath, 'data', 'attendance.db')
  }
}

function setupDatabase() {
  try {
    console.log('Setting up database...')
    
    const dbPath = getProductionSafeDatabasePath()
    console.log('Database path:', dbPath)

    // Ensure data directory exists
    const dataDir = path.dirname(dbPath)
    console.log('Data directory:', dataDir)
    
    if (!fs.existsSync(dataDir)) {
      console.log('Creating data directory...')
      fs.mkdirSync(dataDir, { recursive: true })
    }

    // Check if we can write to the directory
    try {
      const testFile = path.join(dataDir, 'test-write.tmp')
      fs.writeFileSync(testFile, 'test')
      fs.unlinkSync(testFile)
      console.log('✓ Data directory is writable')
    } catch (writeError) {
      console.error('✗ Cannot write to data directory:', writeError.message)
      throw new Error(`Cannot write to data directory: ${dataDir}`)
    }

    // Initialize database
    console.log('Initializing SQLite database...')
    db = new Database(dbPath)
    console.log('✓ Database connection established')

    // Enable foreign keys
    db.pragma("foreign_keys = ON")
    console.log('✓ Foreign keys enabled')

    // Create tables
    console.log('Creating database tables...')
    createTables()
    console.log('✓ Tables created')

    // Create indexes for performance
    console.log('Creating database indexes...')
    createIndexes()
    console.log('✓ Indexes created')

    // Run database migrations for new features
    console.log('Running database migrations...')
    runMigrations()
    console.log('✓ Database migrations completed')

    // Test database connectivity
    const testQuery = db.prepare("SELECT COUNT(*) as count FROM employees")
    const result = testQuery.get()
    console.log('✓ Database test query successful, employees count:', result.count)

    console.log("✓ Database initialized successfully at:", dbPath)
    return db

  } catch (error) {
    console.error('✗ Database setup failed:', error)
    
    // Try fallback location if main location fails
    if (!error.message.includes('fallback')) {
      console.log('Trying fallback database location...')
      return setupFallbackDatabase()
    }
    
    throw error
  }
}

function setupFallbackDatabase() {
  try {
    // Fallback: Use temp directory
    const tempDir = require('os').tmpdir()
    const fallbackDbPath = path.join(tempDir, 'electron-attendance', 'attendance.db')
    
    console.log('Fallback database path:', fallbackDbPath)
    
    const fallbackDataDir = path.dirname(fallbackDbPath)
    if (!fs.existsSync(fallbackDataDir)) {
      fs.mkdirSync(fallbackDataDir, { recursive: true })
    }

    db = new Database(fallbackDbPath)
    db.pragma("foreign_keys = ON")
    
    createTables()
    createIndexes()
    runMigrations()
    
    console.log("✓ Fallback database initialized at:", fallbackDbPath)
    return db
    
  } catch (fallbackError) {
    console.error('✗ Fallback database setup also failed:', fallbackError)
    throw new Error(`Database setup failed: ${fallbackError.message} (fallback)`)
  }
}

function createTables() {
  try {
    // Employees table
    console.log('Creating employees table...')
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
    console.log('✓ Employees table created')

    // Attendance table with updated clock_type constraints
    console.log('Creating attendance table...')
    db.exec(`
      CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_uid INTEGER,
        id_number TEXT,
        clock_type TEXT CHECK(clock_type IN (
          'morning_in', 'morning_out', 
          'afternoon_in', 'afternoon_out',
          'evening_in', 'evening_out',
          'overtime_in', 'overtime_out'
        )),
        clock_time DATETIME,
        regular_hours REAL DEFAULT 0,
        overtime_hours REAL DEFAULT 0,
        date TEXT,
        is_late INTEGER DEFAULT 0,
        is_synced INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_uid) REFERENCES employees (uid)
      )
    `)
    console.log('✓ Attendance table created')

    // NEW: Attendance Statistics table for detailed calculations
    console.log('Creating attendance_statistics table...')
    db.exec(`
      CREATE TABLE IF NOT EXISTS attendance_statistics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_uid INTEGER,
        attendance_id INTEGER,
        clock_out_id INTEGER,
        session_type TEXT CHECK(session_type IN (
          'morning', 'afternoon', 'evening', 'overtime', 'continuous'
        )),
        clock_in_time DATETIME,
        clock_out_time DATETIME,
        total_minutes_worked INTEGER,
        regular_hours REAL DEFAULT 0,
        overtime_hours REAL DEFAULT 0,
        total_hours REAL DEFAULT 0,
        
        -- Calculation breakdown
        early_arrival_minutes INTEGER DEFAULT 0,
        early_arrival_overtime_hours REAL DEFAULT 0,
        morning_session_hours REAL DEFAULT 0,
        afternoon_session_hours REAL DEFAULT 0,
        evening_session_hours REAL DEFAULT 0,
        regular_overtime_hours REAL DEFAULT 0,
        night_shift_hours REAL DEFAULT 0,
        
        -- Special rules applied
        early_morning_rule_applied INTEGER DEFAULT 0,
        overnight_shift INTEGER DEFAULT 0,
        grace_period_applied INTEGER DEFAULT 0,
        lunch_break_excluded INTEGER DEFAULT 0,
        
        -- Time boundaries used in calculation
        session_start_minutes INTEGER,
        session_end_minutes INTEGER,
        effective_clock_in_minutes INTEGER,
        effective_clock_out_minutes INTEGER,
        
        -- Grace periods and adjustments
        lateness_minutes INTEGER DEFAULT 0,
        grace_period_minutes INTEGER DEFAULT 0,
        session_grace_period INTEGER DEFAULT 0,
        
        -- Calculation metadata
        calculation_method TEXT, -- 'continuous', 'session', 'evening', 'overtime'
        special_notes TEXT,
        date TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        
        FOREIGN KEY (employee_uid) REFERENCES employees (uid),
        FOREIGN KEY (attendance_id) REFERENCES attendance (id),
        FOREIGN KEY (clock_out_id) REFERENCES attendance (id)
      )
    `)
    console.log('✓ Attendance statistics table created')

    // Settings table
    console.log('Creating settings table...')
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    console.log('✓ Settings table created')

    // Insert default settings
    console.log('Inserting default settings...')
    const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
    
    const defaultSettings = [
      ["server_url", "http://192.168.1.71:3001/api/tables/emp_list/data"],
      ["sync_interval", "300000"], // 5 minutes
      ["grace_period", "5"], // 5 minutes
      ["overtime_start", "17:10"], // Overtime starts at 5:10 PM
      ["overtime_grace", "5"], // 5 minutes grace for overtime
      ["overtime_session_grace", "15"], // 15 minutes grace for overtime sessions
      ["regular_grace", "5"] // 5 minutes grace for regular hours
    ]

    defaultSettings.forEach(([key, value]) => {
      try {
        insertSetting.run(key, value)
        console.log(`✓ Default setting added: ${key}`)
      } catch (error) {
        console.log(`- Setting already exists: ${key}`)
      }
    })

    // Create database version tracking table
    console.log('Creating database version table...')
    db.exec(`
      CREATE TABLE IF NOT EXISTS database_version (
        version INTEGER PRIMARY KEY,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        description TEXT
      )
    `)
    console.log('✓ Database version table created')

  } catch (error) {
    console.error('Error creating tables:', error)
    throw error
  }
}

function createIndexes() {
  try {
    const indexes = [
      "CREATE INDEX IF NOT EXISTS idx_employees_id_number ON employees (id_number)",
      "CREATE INDEX IF NOT EXISTS idx_employees_id_barcode ON employees (id_barcode)", 
      "CREATE INDEX IF NOT EXISTS idx_attendance_employee_uid ON attendance (employee_uid)",
      "CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance (date)",
      "CREATE INDEX IF NOT EXISTS idx_attendance_clock_time ON attendance (clock_time)",
      "CREATE INDEX IF NOT EXISTS idx_attendance_clock_type ON attendance (clock_type)",
      "CREATE INDEX IF NOT EXISTS idx_attendance_employee_date ON attendance (employee_uid, date)",
      "CREATE INDEX IF NOT EXISTS idx_attendance_overtime ON attendance (clock_type) WHERE clock_type LIKE '%overtime%' OR clock_type LIKE '%evening%'",
      
      // NEW: Indexes for statistics table
      "CREATE INDEX IF NOT EXISTS idx_stats_employee_uid ON attendance_statistics (employee_uid)",
      "CREATE INDEX IF NOT EXISTS idx_stats_date ON attendance_statistics (date)",
      "CREATE INDEX IF NOT EXISTS idx_stats_attendance_id ON attendance_statistics (attendance_id)",
      "CREATE INDEX IF NOT EXISTS idx_stats_clock_out_id ON attendance_statistics (clock_out_id)",
      "CREATE INDEX IF NOT EXISTS idx_stats_employee_date ON attendance_statistics (employee_uid, date)",
      "CREATE INDEX IF NOT EXISTS idx_stats_session_type ON attendance_statistics (session_type)",
      "CREATE INDEX IF NOT EXISTS idx_stats_special_rules ON attendance_statistics (early_morning_rule_applied, overnight_shift)",
      "CREATE INDEX IF NOT EXISTS idx_stats_calculation_method ON attendance_statistics (calculation_method)"
    ]

    indexes.forEach((indexQuery, i) => {
      try {
        db.exec(indexQuery)
        console.log(`✓ Index ${i + 1}/${indexes.length} created`)
      } catch (error) {
        console.log(`- Index ${i + 1}/${indexes.length} already exists`)
      }
    })

  } catch (error) {
    console.error('Error creating indexes:', error)
    throw error
  }
}

function runMigrations() {
  try {
    console.log('Checking database version...')
    
    // Check current version
    let currentVersion = 0
    try {
      const versionQuery = db.prepare("SELECT MAX(version) as version FROM database_version")
      const result = versionQuery.get()
      currentVersion = result.version || 0
    } catch (error) {
      console.log('No version history found, starting from version 0')
    }

    console.log(`Current database version: ${currentVersion}`)

    // Migration 1: Add is_late column (if not exists)
    if (currentVersion < 1) {
      console.log('Running migration 1: Adding is_late column...')
      try {
        db.exec(`ALTER TABLE attendance ADD COLUMN is_late INTEGER DEFAULT 0`)
        console.log('✓ Migration 1: is_late column added')
      } catch (error) {
        console.log('- Migration 1: is_late column already exists')
      }
      
      const insertVersion = db.prepare("INSERT INTO database_version (version, description) VALUES (?, ?)")
      insertVersion.run(1, "Added is_late column to attendance table")
    }

    // Migration 2: Update clock_type constraints for new types
    if (currentVersion < 2) {
      console.log('Running migration 2: Updating clock_type constraints...')
      
      // Check if we need to recreate the table with new constraints
      const tableInfo = db.prepare("PRAGMA table_info(attendance)").all()
      const clockTypeColumn = tableInfo.find(col => col.name === 'clock_type')
      
      // Since SQLite doesn't allow modifying CHECK constraints directly,
      // we'll create a new table and migrate data if needed
      try {
        // Create temporary table with new constraints
        db.exec(`
          CREATE TABLE IF NOT EXISTS attendance_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_uid INTEGER,
            id_number TEXT,
            clock_type TEXT CHECK(clock_type IN (
              'morning_in', 'morning_out', 
              'afternoon_in', 'afternoon_out',
              'evening_in', 'evening_out',
              'overtime_in', 'overtime_out'
            )),
            clock_time DATETIME,
            regular_hours REAL DEFAULT 0,
            overtime_hours REAL DEFAULT 0,
            date TEXT,
            is_late INTEGER DEFAULT 0,
            is_synced INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (employee_uid) REFERENCES employees (uid)
          )
        `)

        // Check if we have any data that would conflict with new constraints
        const conflictingData = db.prepare(`
          SELECT COUNT(*) as count FROM attendance 
          WHERE clock_type NOT IN (
            'morning_in', 'morning_out', 
            'afternoon_in', 'afternoon_out',
            'evening_in', 'evening_out',
            'overtime_in', 'overtime_out'
          )
        `).get()

        if (conflictingData.count === 0) {
          console.log('✓ No conflicting data found, constraints are compatible')
        } else {
          console.log(`⚠ Found ${conflictingData.count} records with old clock types, keeping them for compatibility`)
        }

        // Drop the temporary table since main table already exists
        db.exec('DROP TABLE IF EXISTS attendance_new')
        
        console.log('✓ Migration 2: Clock type constraints updated')
      } catch (error) {
        console.log('- Migration 2: Clock type constraints already compatible')
      }

      const insertVersion = db.prepare("INSERT OR IGNORE INTO database_version (version, description) VALUES (?, ?)")
      insertVersion.run(2, "Updated clock_type constraints for evening and overtime sessions")
    }

    // Migration 3: Add new settings for overtime configuration
    if (currentVersion < 3) {
      console.log('Running migration 3: Adding overtime settings...')
      
      const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
      
      const newSettings = [
        ["overtime_start", "17:10"],
        ["overtime_grace", "5"],
        ["overtime_session_grace", "15"],
        ["regular_grace", "5"]
      ]

      newSettings.forEach(([key, value]) => {
        try {
          insertSetting.run(key, value)
          console.log(`✓ Added setting: ${key}`)
        } catch (error) {
          console.log(`- Setting already exists: ${key}`)
        }
      })

      const insertVersion = db.prepare("INSERT OR IGNORE INTO database_version (version, description) VALUES (?, ?)")
      insertVersion.run(3, "Added overtime configuration settings")
      
      console.log('✓ Migration 3: Overtime settings added')
    }

    // Migration 4: Create attendance_statistics table
    if (currentVersion < 4) {
      console.log('Running migration 4: Creating attendance_statistics table...')
      
      // The table creation is handled in createTables(), but we need to ensure indexes
      try {
        // Add new indexes for statistics table
        const statsIndexes = [
          "CREATE INDEX IF NOT EXISTS idx_stats_employee_uid ON attendance_statistics (employee_uid)",
          "CREATE INDEX IF NOT EXISTS idx_stats_date ON attendance_statistics (date)",
          "CREATE INDEX IF NOT EXISTS idx_stats_attendance_id ON attendance_statistics (attendance_id)",
          "CREATE INDEX IF NOT EXISTS idx_stats_clock_out_id ON attendance_statistics (clock_out_id)",
          "CREATE INDEX IF NOT EXISTS idx_stats_employee_date ON attendance_statistics (employee_uid, date)",
          "CREATE INDEX IF NOT EXISTS idx_stats_session_type ON attendance_statistics (session_type)",
          "CREATE INDEX IF NOT EXISTS idx_stats_special_rules ON attendance_statistics (early_morning_rule_applied, overnight_shift)",
          "CREATE INDEX IF NOT EXISTS idx_stats_calculation_method ON attendance_statistics (calculation_method)"
        ]

        statsIndexes.forEach(indexQuery => {
          try {
            db.exec(indexQuery)
          } catch (error) {
            console.log(`- Index already exists: ${indexQuery.split(' ')[5]}`)
          }
        })

        console.log('✓ Migration 4: Attendance statistics table and indexes created')
      } catch (error) {
        console.log('- Migration 4: Statistics table already exists')
      }

      const insertVersion = db.prepare("INSERT OR IGNORE INTO database_version (version, description) VALUES (?, ?)")
      insertVersion.run(4, "Added attendance_statistics table for detailed calculation tracking")
    }

    console.log('✓ All migrations completed successfully')

  } catch (error) {
    console.error('Error running migrations:', error)
    throw error
  }
}

function getDatabase() {
  if (!db) {
    console.warn('Database not initialized, attempting to initialize...')
    setupDatabase()
  }
  return db
}

// Graceful database closure
function closeDatabase() {
  if (db) {
    try {
      db.close()
      console.log('✓ Database connection closed')
    } catch (error) {
      console.error('Error closing database:', error)
    }
    db = null
  }
}

// Handle app shutdown
if (app) {
  app.on('before-quit', () => {
    closeDatabase()
  })

  app.on('window-all-closed', () => {
    closeDatabase()
  })
}

// Handle process termination
process.on('SIGINT', () => {
  closeDatabase()
  process.exit(0)
})

process.on('SIGTERM', () => {
  closeDatabase()
  process.exit(0)
})

module.exports = {
  setupDatabase,
  getDatabase,
  closeDatabase,
}