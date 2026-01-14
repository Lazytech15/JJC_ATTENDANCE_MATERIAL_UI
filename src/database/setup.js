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
        face_descriptor TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    console.log('✓ Employees table created')

    // Attendance table with updated clock_type constraints and id_barcode field
    console.log('Creating attendance table...')
    db.exec(`
      CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_uid INTEGER,
        id_number TEXT,
        scanned_barcode TEXT,
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

    // Attendance Statistics table for detailed calculations
    console.log('Creating attendance_statistics table...')
    db.exec(`
      CREATE TABLE IF NOT EXISTS attendance_statistics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_uid INTEGER,
        attendance_id INTEGER,
        clock_out_id INTEGER,
        id_number TEXT,
        scanned_barcode TEXT,
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

    // NEW: Daily Attendance Summary table for readable attendance data
    console.log('Creating daily_attendance_summary table...')
    db.exec(`
      CREATE TABLE IF NOT EXISTS daily_attendance_summary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_uid INTEGER,
        id_number TEXT,
        id_barcode TEXT,
        employee_name TEXT NOT NULL,
        first_name TEXT,
        last_name TEXT,
        department TEXT,
        
        -- Time tracking
        date TEXT NOT NULL,
        first_clock_in DATETIME,
        last_clock_out DATETIME,
        
        -- Session details
        morning_in DATETIME,
        morning_out DATETIME,
        afternoon_in DATETIME,
        afternoon_out DATETIME,
        evening_in DATETIME,
        evening_out DATETIME,
        overtime_in DATETIME,
        overtime_out DATETIME,
        
        -- Hours calculation
        regular_hours REAL DEFAULT 0,
        overtime_hours REAL DEFAULT 0,
        total_hours REAL DEFAULT 0,
        
        -- Session hours breakdown
        morning_hours REAL DEFAULT 0,
        afternoon_hours REAL DEFAULT 0,
        evening_hours REAL DEFAULT 0,
        overtime_session_hours REAL DEFAULT 0,
        
        -- Status flags
        is_incomplete INTEGER DEFAULT 0, -- Has pending clock-out
        has_late_entry INTEGER DEFAULT 0,
        has_overtime INTEGER DEFAULT 0,
        has_evening_session INTEGER DEFAULT 0,
        
        -- Metadata
        total_sessions INTEGER DEFAULT 0,
        completed_sessions INTEGER DEFAULT 0,
        pending_sessions INTEGER DEFAULT 0,
        
        -- Time calculations
        total_minutes_worked INTEGER DEFAULT 0,
        break_time_minutes INTEGER DEFAULT 0, -- Future: track lunch breaks
        
        -- Sync and audit
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        
        -- Constraints
        FOREIGN KEY (employee_uid) REFERENCES employees (uid),
        UNIQUE(employee_uid, date)
      )
    `)
    console.log('✓ Daily attendance summary table created')

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
      ["regular_grace", "5"], // 5 minutes grace for regular hours
      ["face_detection_enabled", "true"]
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
      // REMOVED: Problematic partial index with LIKE
      // "CREATE INDEX IF NOT EXISTS idx_attendance_overtime ON attendance (clock_type) WHERE clock_type LIKE '%overtime%' OR clock_type LIKE '%evening%'",
      "CREATE INDEX IF NOT EXISTS idx_attendance_id_barcode ON attendance (scanned_barcode)",
      "CREATE INDEX IF NOT EXISTS idx_attendance_id_number ON attendance (id_number)",

      // Indexes for statistics table
      "CREATE INDEX IF NOT EXISTS idx_stats_employee_uid ON attendance_statistics (employee_uid)",
      "CREATE INDEX IF NOT EXISTS idx_stats_date ON attendance_statistics (date)",
      "CREATE INDEX IF NOT EXISTS idx_stats_attendance_id ON attendance_statistics (attendance_id)",
      "CREATE INDEX IF NOT EXISTS idx_stats_clock_out_id ON attendance_statistics (clock_out_id)",
      "CREATE INDEX IF NOT EXISTS idx_stats_employee_date ON attendance_statistics (employee_uid, date)",
      "CREATE INDEX IF NOT EXISTS idx_stats_session_type ON attendance_statistics (session_type)",
      // REMOVED: Problematic partial index
      // "CREATE INDEX IF NOT EXISTS idx_stats_special_rules ON attendance_statistics (early_morning_rule_applied, overnight_shift)",
      "CREATE INDEX IF NOT EXISTS idx_stats_calculation_method ON attendance_statistics (calculation_method)",

      // NEW: Indexes for daily attendance summary table
      "CREATE INDEX IF NOT EXISTS idx_daily_summary_employee_uid ON daily_attendance_summary (employee_uid)",
      "CREATE INDEX IF NOT EXISTS idx_daily_summary_date ON daily_attendance_summary (date)",
      "CREATE INDEX IF NOT EXISTS idx_daily_summary_employee_date ON daily_attendance_summary (employee_uid, date)",
      "CREATE INDEX IF NOT EXISTS idx_daily_summary_id_number ON daily_attendance_summary (id_number)",
      "CREATE INDEX IF NOT EXISTS idx_daily_summary_id_barcode ON daily_attendance_summary (id_barcode)",
      "CREATE INDEX IF NOT EXISTS idx_daily_summary_department ON daily_attendance_summary (department)",
      // CHANGED: Simple index without WHERE clause
      "CREATE INDEX IF NOT EXISTS idx_daily_summary_overtime ON daily_attendance_summary (has_overtime)",
      "CREATE INDEX IF NOT EXISTS idx_daily_summary_incomplete ON daily_attendance_summary (is_incomplete)",
      "CREATE INDEX IF NOT EXISTS idx_daily_summary_total_hours ON daily_attendance_summary (total_hours)",
      "CREATE INDEX IF NOT EXISTS idx_daily_summary_name ON daily_attendance_summary (employee_name)",
      "CREATE INDEX IF NOT EXISTS idx_daily_summary_last_updated ON daily_attendance_summary (last_updated)"
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

      try {
        // Check current table structure
        const currentTableCheck = db.prepare(`
          SELECT sql FROM sqlite_master 
          WHERE type='table' AND name='attendance'
        `).get()

        // Only migrate if the old constraint is still in place
        if (currentTableCheck && !currentTableCheck.sql.includes('evening_in')) {
          console.log('Old attendance table detected, recreating with new constraints...')

          // Disable foreign key constraints temporarily
          db.exec('PRAGMA foreign_keys=OFF')

          // Create new table with updated constraints
          db.exec(`
            CREATE TABLE attendance_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              employee_uid INTEGER,
              id_number TEXT,
              scanned_barcode TEXT,
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

          // Copy all data from old table to new table
          db.exec(`
            INSERT INTO attendance_new 
            SELECT id, employee_uid, id_number, scanned_barcode, clock_type, clock_time, 
                   regular_hours, overtime_hours, date, is_late, is_synced, created_at 
            FROM attendance
          `)

          // Drop old table and rename new one
          db.exec('DROP TABLE attendance')
          db.exec('ALTER TABLE attendance_new RENAME TO attendance')

          // Re-enable foreign key constraints
          db.exec('PRAGMA foreign_keys=ON')

          console.log('✓ Migration 2: Attendance table successfully updated with new clock_type constraints')
        } else {
          console.log('✓ Migration 2: Attendance table already has new constraints')
        }

      } catch (error) {
        console.log('⚠ Migration 2 error:', error.message)
        db.exec('PRAGMA foreign_keys=ON') // Ensure foreign keys are re-enabled
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

    // Migration 5: Add id_barcode column to attendance table
    if (currentVersion < 5) {
      console.log('Running migration 5: Adding id_barcode column to attendance table...')
      try {
        // Check if column already exists
        const tableInfo = db.prepare("PRAGMA table_info(attendance)").all()
        const barcodeColumn = tableInfo.find(col => col.name === 'id_barcode')

        if (!barcodeColumn) {
          db.exec(`ALTER TABLE attendance ADD COLUMN id_barcode TEXT`)
          console.log('✓ Migration 5: id_barcode column added to attendance table')

          // Add index for the new column
          db.exec("CREATE INDEX IF NOT EXISTS idx_attendance_id_barcode ON attendance (id_barcode)")
          console.log('✓ Migration 5: Index created for id_barcode column')
        } else {
          console.log('- Migration 5: id_barcode column already exists')
        }
      } catch (error) {
        console.error('Error in migration 5:', error)
        console.log('- Migration 5: Failed to add id_barcode column')
      }

      const insertVersion = db.prepare("INSERT OR IGNORE INTO database_version (version, description) VALUES (?, ?)")
      insertVersion.run(5, "Added id_barcode column to attendance table for storing scanned barcode data")

      console.log('✓ Migration 5: id_barcode column migration completed')
    }

    // Migration 6: Add id_barcode column to attendance_statistics table
    if (currentVersion < 6) {
      console.log('Running migration 6: Adding id_barcode column to attendance_statistics table...')
      try {
        // Check if column already exists
        const tableInfo = db.prepare("PRAGMA table_info(attendance_statistics)").all()
        const barcodeColumn = tableInfo.find(col => col.name === 'id_barcode')

        if (!barcodeColumn) {
          db.exec(`ALTER TABLE attendance_statistics ADD COLUMN id_barcode TEXT`)
          console.log('✓ Migration 6: id_barcode column added to attendance_statistics table')

          // Add index for the new column
          db.exec("CREATE INDEX IF NOT EXISTS idx_stats_id_barcode ON attendance_statistics (id_barcode)")
          console.log('✓ Migration 6: Index created for id_barcode column in statistics table')
        } else {
          console.log('- Migration 6: id_barcode column already exists in attendance_statistics')
        }
      } catch (error) {
        console.error('Error in migration 6:', error)
        console.log('- Migration 6: Failed to add id_barcode column to attendance_statistics')
      }

      const insertVersion = db.prepare("INSERT OR IGNORE INTO database_version (version, description) VALUES (?, ?)")
      insertVersion.run(6, "Added id_barcode column to attendance_statistics table for tracking barcode data in statistics")

      console.log('✓ Migration 6: id_barcode column migration for statistics completed')
    }

    // NEW: Migration 7: Create daily_attendance_summary table
    if (currentVersion < 7) {
      console.log('Running migration 7: Creating daily_attendance_summary table...')

      try {
        // The table creation is handled in createTables(), but we need to ensure indexes
        const summaryIndexes = [
          "CREATE INDEX IF NOT EXISTS idx_daily_summary_employee_uid ON daily_attendance_summary (employee_uid)",
          "CREATE INDEX IF NOT EXISTS idx_daily_summary_date ON daily_attendance_summary (date)",
          "CREATE INDEX IF NOT EXISTS idx_daily_summary_employee_date ON daily_attendance_summary (employee_uid, date)",
          "CREATE INDEX IF NOT EXISTS idx_daily_summary_id_number ON daily_attendance_summary (id_number)",
          "CREATE INDEX IF NOT EXISTS idx_daily_summary_id_barcode ON daily_attendance_summary (id_barcode)",
          "CREATE INDEX IF NOT EXISTS idx_daily_summary_department ON daily_attendance_summary (department)",
          "CREATE INDEX IF NOT EXISTS idx_daily_summary_overtime ON daily_attendance_summary (has_overtime) WHERE has_overtime = 1",
          "CREATE INDEX IF NOT EXISTS idx_daily_summary_incomplete ON daily_attendance_summary (is_incomplete) WHERE is_incomplete = 1",
          "CREATE INDEX IF NOT EXISTS idx_daily_summary_total_hours ON daily_attendance_summary (total_hours)",
          "CREATE INDEX IF NOT EXISTS idx_daily_summary_name ON daily_attendance_summary (employee_name)",
          "CREATE INDEX IF NOT EXISTS idx_daily_summary_last_updated ON daily_attendance_summary (last_updated)"
        ]

        summaryIndexes.forEach(indexQuery => {
          try {
            db.exec(indexQuery)
          } catch (error) {
            console.log(`- Index already exists: ${indexQuery.split(' ')[5]}`)
          }
        })

        console.log('✓ Migration 7: Daily attendance summary table and indexes created')
      } catch (error) {
        console.log('- Migration 7: Daily attendance summary table already exists')
      }

      const insertVersion = db.prepare("INSERT OR IGNORE INTO database_version (version, description) VALUES (?, ?)")
      insertVersion.run(7, "Added daily_attendance_summary table for readable attendance data")

      console.log('✓ Migration 7: Daily attendance summary table migration completed')
    }

    // Migration 8: Add is_synced column to daily_attendance_summary
    if (currentVersion < 8) {
      console.log('Running migration 8: Adding is_synced column to daily_attendance_summary...')
      try {
        const tableInfo = db.prepare("PRAGMA table_info(daily_attendance_summary)").all()
        const isSyncedColumn = tableInfo.find(col => col.name === 'is_synced')

        if (!isSyncedColumn) {
          db.exec(`ALTER TABLE daily_attendance_summary ADD COLUMN is_synced INTEGER DEFAULT 0`)
          console.log('✓ Migration 8: is_synced column added to daily_attendance_summary')

          // Add index for the new column
          db.exec("CREATE INDEX IF NOT EXISTS idx_daily_summary_sync_status ON daily_attendance_summary (is_synced)")
          console.log('✓ Migration 8: Index created for is_synced column')
        } else {
          console.log('- Migration 8: is_synced column already exists')
        }
      } catch (error) {
        console.error('Error in migration 8:', error)
        console.log('- Migration 8: Failed to add is_synced column')
      }

      const insertVersion = db.prepare("INSERT OR IGNORE INTO database_version (version, description) VALUES (?, ?)")
      insertVersion.run(8, "Added is_synced column to daily_attendance_summary for tracking sync status")

      console.log('✓ Migration 8: is_synced column migration completed')
    }

    // Migration 9: Update foreign key to use CASCADE DELETE
if (currentVersion < 9) {
  console.log('Running migration 9: Updating foreign key constraints...')
  
  try {
    // Disable foreign keys
    db.exec('PRAGMA foreign_keys=OFF');
    
    // Create new summary table with CASCADE
    db.exec(`
      CREATE TABLE daily_attendance_summary_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_uid INTEGER,
        id_number TEXT,
        id_barcode TEXT,
        employee_name TEXT NOT NULL,
        first_name TEXT,
        last_name TEXT,
        department TEXT,
        date TEXT NOT NULL,
        first_clock_in DATETIME,
        last_clock_out DATETIME,
        morning_in DATETIME,
        morning_out DATETIME,
        afternoon_in DATETIME,
        afternoon_out DATETIME,
        evening_in DATETIME,
        evening_out DATETIME,
        overtime_in DATETIME,
        overtime_out DATETIME,
        regular_hours REAL DEFAULT 0,
        overtime_hours REAL DEFAULT 0,
        total_hours REAL DEFAULT 0,
        morning_hours REAL DEFAULT 0,
        afternoon_hours REAL DEFAULT 0,
        evening_hours REAL DEFAULT 0,
        overtime_session_hours REAL DEFAULT 0,
        is_incomplete INTEGER DEFAULT 0,
        has_late_entry INTEGER DEFAULT 0,
        has_overtime INTEGER DEFAULT 0,
        has_evening_session INTEGER DEFAULT 0,
        total_sessions INTEGER DEFAULT 0,
        completed_sessions INTEGER DEFAULT 0,
        pending_sessions INTEGER DEFAULT 0,
        total_minutes_worked INTEGER DEFAULT 0,
        break_time_minutes INTEGER DEFAULT 0,
        is_synced INTEGER DEFAULT 0,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_uid) REFERENCES employees (uid) ON DELETE CASCADE,
        UNIQUE(employee_uid, date)
      )
    `);
    
    // Copy data
    db.exec(`
      INSERT INTO daily_attendance_summary_new 
      SELECT * FROM daily_attendance_summary
    `);
    
    // Drop old and rename
    db.exec('DROP TABLE daily_attendance_summary');
    db.exec('ALTER TABLE daily_attendance_summary_new RENAME TO daily_attendance_summary');
    
    // Recreate indexes
    const summaryIndexes = [
      "CREATE INDEX IF NOT EXISTS idx_daily_summary_employee_uid ON daily_attendance_summary (employee_uid)",
      "CREATE INDEX IF NOT EXISTS idx_daily_summary_date ON daily_attendance_summary (date)",
      "CREATE INDEX IF NOT EXISTS idx_daily_summary_employee_date ON daily_attendance_summary (employee_uid, date)"
    ];
    
    summaryIndexes.forEach(idx => db.exec(idx));
    
    // Re-enable foreign keys
    db.exec('PRAGMA foreign_keys=ON');
    
    console.log('✓ Migration 9: Foreign key constraints updated with CASCADE');
  } catch (error) {
    console.error('Migration 9 error:', error);
    db.exec('PRAGMA foreign_keys=ON');
  }
  
  const insertVersion = db.prepare("INSERT OR IGNORE INTO database_version (version, description) VALUES (?, ?)")
  insertVersion.run(9, "Updated foreign key constraints to use CASCADE DELETE")
}

    console.log('✓ All migrations completed successfully')

  } catch (error) {
    console.error('Error running migrations:', error)
    throw error
  }
}

// FIXED: Function to update daily attendance summary
function updateDailyAttendanceSummary(employeeUid, date, db = null) {
  if (!db) {
    db = getDatabase()
  }

  try {
    console.log(`Updating daily attendance summary for employee ${employeeUid} on ${date}`)

    // Get employee information
    const employee = db.prepare(`
      SELECT uid, id_number, id_barcode, first_name, last_name, department
      FROM employees 
      WHERE uid = ?
    `).get(employeeUid)

    if (!employee) {
      console.log(`Employee ${employeeUid} not found`)
      return false
    }

    // Get all attendance records for this employee and date
    const attendanceRecords = db.prepare(`
      SELECT * FROM attendance 
      WHERE employee_uid = ? AND date = ?
      ORDER BY clock_time ASC
    `).all(employeeUid, date)

    // If no attendance records, DELETE the summary instead of keeping old data
    if (attendanceRecords.length === 0) {
      console.log(`No attendance records found for employee ${employeeUid} on ${date}, deleting summary`)
      db.prepare(`
        DELETE FROM daily_attendance_summary 
        WHERE employee_uid = ? AND date = ?
      `).run(employeeUid, date)
      return true
    }

    // Process attendance records to extract session times and calculate totals
    const sessionTimes = {
      morning_in: null, morning_out: null,
      afternoon_in: null, afternoon_out: null,
      evening_in: null, evening_out: null,
      overtime_in: null, overtime_out: null
    }

    // ✅ FIX: Only count hours from clock-OUT records
    let totalRegularHours = 0
    let totalOvertimeHours = 0
    let totalSessions = 0
    let completedSessions = 0
    let pendingSessions = 0
    let hasLateEntry = false
    let hasOvertime = false
    let hasEveningSession = false

    // Process each attendance record
    attendanceRecords.forEach(record => {
      const clockType = record.clock_type

      // Store session times
      if (sessionTimes.hasOwnProperty(clockType)) {
        sessionTimes[clockType] = record.clock_time
      }

      // ✅ FIX: Only accumulate hours from clock-OUT records
      if (clockType.endsWith('_out')) {
        totalRegularHours += record.regular_hours || 0
        totalOvertimeHours += record.overtime_hours || 0
        console.log(`  ${clockType}: Regular=${record.regular_hours || 0}h, OT=${record.overtime_hours || 0}h`)
      }

      // Track session counts and flags
      if (clockType.endsWith('_in')) {
        totalSessions++
        // Check if there's a corresponding _out
        const outType = clockType.replace('_in', '_out')
        const hasOut = attendanceRecords.some(r => r.clock_type === outType && r.clock_time > record.clock_time)
        if (hasOut) {
          completedSessions++
        } else {
          pendingSessions++
        }
      }

      // Set flags
      if (record.is_late) hasLateEntry = true
      if (clockType.startsWith('overtime') || clockType.startsWith('evening')) {
        hasOvertime = true
        if (clockType.startsWith('evening')) hasEveningSession = true
      }
    })

    console.log(`  Total from clock-outs: Regular=${totalRegularHours}h, OT=${totalOvertimeHours}h`)

    // ✅ FIX: Calculate session-specific hours ONLY from clock-out records
    const sessionHours = {
      morning_hours: 0,
      afternoon_hours: 0,
      evening_hours: 0,
      overtime_session_hours: 0
    }

    // ✅ CORRECTED: Get regular hours only for morning/afternoon, overtime for evening/OT sessions
    const morningOutRecord = attendanceRecords.find(r => r.clock_type === 'morning_out')
    const afternoonOutRecord = attendanceRecords.find(r => r.clock_type === 'afternoon_out')
    const eveningOutRecord = attendanceRecords.find(r => r.clock_type === 'evening_out')
    const overtimeOutRecord = attendanceRecords.find(r => r.clock_type === 'overtime_out')

    // Morning hours = regular_hours from morning_out only
    if (morningOutRecord) {
      sessionHours.morning_hours = morningOutRecord.regular_hours || 0
    }

    // Afternoon hours = regular_hours from afternoon_out only
    if (afternoonOutRecord) {
      sessionHours.afternoon_hours = afternoonOutRecord.regular_hours || 0
    }

    // Evening hours = overtime_hours from evening_out (evening is always OT)
    if (eveningOutRecord) {
      sessionHours.evening_hours = eveningOutRecord.overtime_hours || 0
    }

    // Overtime session hours = overtime_hours from overtime_out
    if (overtimeOutRecord) {
      sessionHours.overtime_session_hours = overtimeOutRecord.overtime_hours || 0
    }

    console.log(`  Session breakdown: Morning=${sessionHours.morning_hours}h, Afternoon=${sessionHours.afternoon_hours}h, Evening=${sessionHours.evening_hours}h, OT=${sessionHours.overtime_session_hours}h`)

    // Get first and last times
    const firstClockIn = attendanceRecords.find(r => r.clock_type.endsWith('_in'))?.clock_time
    const lastClockOut = [...attendanceRecords].reverse().find(r => r.clock_type.endsWith('_out'))?.clock_time

    // Calculate total minutes worked
    let totalMinutesWorked = 0
    if (firstClockIn && lastClockOut) {
      const firstTime = new Date(firstClockIn)
      const lastTime = new Date(lastClockOut)
      totalMinutesWorked = Math.round((lastTime - firstTime) / 60000)

      // Subtract lunch break if both morning and afternoon sessions exist
      const morningSession = sessionTimes.morning_in && sessionTimes.morning_out
      const afternoonSession = sessionTimes.afternoon_in && sessionTimes.afternoon_out
      if (morningSession && afternoonSession) {
        totalMinutesWorked = Math.max(0, totalMinutesWorked - 60)
      }
    }

    // Prepare data for insert/update
    const summaryData = {
      employee_uid: employee.uid,
      id_number: employee.id_number,
      id_barcode: employee.id_barcode,
      employee_name: `${employee.first_name} ${employee.last_name}`,
      first_name: employee.first_name,
      last_name: employee.last_name,
      department: employee.department,
      date: date,
      first_clock_in: firstClockIn,
      last_clock_out: lastClockOut,
      ...sessionTimes,
      regular_hours: totalRegularHours,
      overtime_hours: totalOvertimeHours,
      total_hours: totalRegularHours + totalOvertimeHours,
      ...sessionHours,
      is_incomplete: pendingSessions > 0 ? 1 : 0,
      has_late_entry: hasLateEntry ? 1 : 0,
      has_overtime: hasOvertime ? 1 : 0,
      has_evening_session: hasEveningSession ? 1 : 0,
      total_sessions: totalSessions,
      completed_sessions: completedSessions,
      pending_sessions: pendingSessions,
      total_minutes_worked: totalMinutesWorked,
      break_time_minutes: (sessionTimes.morning_in && sessionTimes.morning_out &&
        sessionTimes.afternoon_in && sessionTimes.afternoon_out) ? 60 : 0,
      last_updated: new Date().toISOString()
    }

    // Insert or update the summary record
    const upsertQuery = db.prepare(`
      INSERT INTO daily_attendance_summary (
        employee_uid, id_number, id_barcode, employee_name, first_name, last_name, department,
        date, first_clock_in, last_clock_out,
        morning_in, morning_out, afternoon_in, afternoon_out,
        evening_in, evening_out, overtime_in, overtime_out,
        regular_hours, overtime_hours, total_hours,
        morning_hours, afternoon_hours, evening_hours, overtime_session_hours,
        is_incomplete, has_late_entry, has_overtime, has_evening_session,
        total_sessions, completed_sessions, pending_sessions,
        total_minutes_worked, break_time_minutes, last_updated
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?
      )
      ON CONFLICT (employee_uid, date) DO UPDATE SET
        id_number = excluded.id_number,
        id_barcode = excluded.id_barcode,
        employee_name = excluded.employee_name,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        department = excluded.department,
        first_clock_in = excluded.first_clock_in,
        last_clock_out = excluded.last_clock_out,
        morning_in = excluded.morning_in,
        morning_out = excluded.morning_out,
        afternoon_in = excluded.afternoon_in,
        afternoon_out = excluded.afternoon_out,
        evening_in = excluded.evening_in,
        evening_out = excluded.evening_out,
        overtime_in = excluded.overtime_in,
        overtime_out = excluded.overtime_out,
        regular_hours = excluded.regular_hours,
        overtime_hours = excluded.overtime_hours,
        total_hours = excluded.total_hours,
        morning_hours = excluded.morning_hours,
        afternoon_hours = excluded.afternoon_hours,
        evening_hours = excluded.evening_hours,
        overtime_session_hours = excluded.overtime_session_hours,
        is_incomplete = excluded.is_incomplete,
        has_late_entry = excluded.has_late_entry,
        has_overtime = excluded.has_overtime,
        has_evening_session = excluded.has_evening_session,
        total_sessions = excluded.total_sessions,
        completed_sessions = excluded.completed_sessions,
        pending_sessions = excluded.pending_sessions,
        total_minutes_worked = excluded.total_minutes_worked,
        break_time_minutes = excluded.break_time_minutes,
        last_updated = excluded.last_updated
    `)

    upsertQuery.run(
      summaryData.employee_uid, summaryData.id_number, summaryData.id_barcode,
      summaryData.employee_name, summaryData.first_name, summaryData.last_name, summaryData.department,
      summaryData.date, summaryData.first_clock_in, summaryData.last_clock_out,
      summaryData.morning_in, summaryData.morning_out, summaryData.afternoon_in, summaryData.afternoon_out,
      summaryData.evening_in, summaryData.evening_out, summaryData.overtime_in, summaryData.overtime_out,
      summaryData.regular_hours, summaryData.overtime_hours, summaryData.total_hours,
      summaryData.morning_hours, summaryData.afternoon_hours, summaryData.evening_hours, summaryData.overtime_session_hours,
      summaryData.is_incomplete, summaryData.has_late_entry, summaryData.has_overtime, summaryData.has_evening_session,
      summaryData.total_sessions, summaryData.completed_sessions, summaryData.pending_sessions,
      summaryData.total_minutes_worked, summaryData.break_time_minutes, summaryData.last_updated
    )

    console.log(`✓ Daily attendance summary updated for employee ${employeeUid} on ${date}`)
    console.log(`  Final totals: Regular=${totalRegularHours}h, OT=${totalOvertimeHours}h, Total=${totalRegularHours + totalOvertimeHours}h`)
    
    return true

  } catch (error) {
    console.error(`Error updating daily attendance summary for employee ${employeeUid} on ${date}:`, error)
    return false
  }
}

// NEW: Function to get daily attendance summary data
function getDailyAttendanceSummary(startDate = null, endDate = null, employeeUid = null, db = null) {
  if (!db) {
    db = getDatabase()
  }

  try {
    let query = 'SELECT * FROM daily_attendance_summary WHERE 1=1'
    const params = []

    if (startDate) {
      query += ' AND date >= ?'
      params.push(startDate)
    }

    if (endDate) {
      query += ' AND date <= ?'
      params.push(endDate)
    }

    if (employeeUid) {
      query += ' AND employee_uid = ?'
      params.push(employeeUid)
    }

    query += ' ORDER BY date DESC, employee_name ASC'

    const summaryData = db.prepare(query).all(...params)

    return summaryData

  } catch (error) {
    console.error('Error getting daily attendance summary:', error)
    return []
  }
}

// NEW: Function to rebuild daily attendance summary for a date range
function rebuildDailyAttendanceSummary(startDate, endDate, db = null) {
  if (!db) {
    db = getDatabase()
  }

  try {
    console.log(`Rebuilding daily attendance summary from ${startDate} to ${endDate}`)

    // Get all unique employee-date combinations in the range
    const employeeDateQuery = db.prepare(`
      SELECT DISTINCT employee_uid, date
      FROM attendance 
      WHERE date BETWEEN ? AND ?
      ORDER BY employee_uid, date
    `)

    const employeeDateCombinations = employeeDateQuery.all(startDate, endDate)

    let successCount = 0
    let failCount = 0

    employeeDateCombinations.forEach(({ employee_uid, date }) => {
      const success = updateDailyAttendanceSummary(employee_uid, date, db)
      if (success) {
        successCount++
      } else {
        failCount++
      }
    })

    console.log(`✓ Daily attendance summary rebuild completed: ${successCount} successful, ${failCount} failed`)

    return { successCount, failCount, totalProcessed: employeeDateCombinations.length }

  } catch (error) {
    console.error('Error rebuilding daily attendance summary:', error)
    return { successCount: 0, failCount: 0, totalProcessed: 0 }
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
  // NEW: Export the daily summary functions
  updateDailyAttendanceSummary,
  getDailyAttendanceSummary,
  rebuildDailyAttendanceSummary,
}