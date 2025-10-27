
const { app, BrowserWindow, ipcMain, Menu, dialog, systemPreferences } = require("electron")
const path = require("path")
const fs = require("fs")
const { autoUpdater } = require("electron-updater")
const LRU = require('lru-cache')
const { getDatabase  } = require("./database/setup");
const { startWebSocketServer } = require('./services/websocket');
const Employee = require('./database/models/employee');

// Configure auto-updater
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Determine if we're in development
const isDev = process.env.NODE_ENV === "development" || process.argv.includes("--dev")

console.log("Starting Electron app...")
console.log("Development mode:", isDev)
console.log("App path:", app.getAppPath())
console.log("Resources path:", process.resourcesPath)
console.log("__dirname:", __dirname)

// GPU fixes
app.commandLine.appendSwitch("--disable-gpu-sandbox")
app.commandLine.appendSwitch("--disable-software-rasterizer")
app.commandLine.appendSwitch("--disable-gpu")

let mainWindow
let settingsWindow
let webExportServer
let updateDownloadStarted = false

let profileCache;
let imageCache;
let rendererCache;
let dbInstance = null;
let employeeCacheLoaded = false;

function initializeCaches() {
  console.log("=== INITIALIZING PERFORMANCE CACHES ===");
  
  try {
    profileCache = new LRU({
      max: 500,
      maxSize: 5000000,
      sizeCalculation: (value, key) => {
        try {
          return JSON.stringify(value).length;
        } catch (error) {
          return 1000;
        }
      },
      ttl: 1000 * 60 * 30,
      allowStale: false,
      updateAgeOnGet: true,
      dispose: (value, key, reason) => {
        console.log(`Profile cache disposed: ${key} (${reason})`);
      }
    });
    
    imageCache = new LRU({
      max: 200,
      maxSize: 20000000,
      sizeCalculation: (value, key) => {
        try {
          if (typeof value === 'string') {
            return value.length;
          }
          if (Buffer.isBuffer(value)) {
            return value.length;
          }
          return 1000;
        } catch (error) {
          return 1000;
        }
      },
      ttl: 1000 * 60 * 60,
      allowStale: false,
      updateAgeOnGet: true,
      dispose: (value, key, reason) => {
        console.log(`Image cache disposed: ${key} (${reason})`);
      }
    });
    
    rendererCache = new Map();
    
    console.log("✓ CACHES INITIALIZED SUCCESSFULLY");
    console.log(`Profile cache config: max=${profileCache.max}, maxSize=${profileCache.maxSize}`);
    console.log(`Image cache config: max=${imageCache.max}, maxSize=${imageCache.maxSize}`);
    
    return true;
  } catch (error) {
    console.error("❌ Cache initialization failed:", error);
    profileCache = new Map();
    imageCache = new Map(); 
    rendererCache = new Map();
    console.log("Fallback to Map-based caches");
    return false;
  }
}

// NEW: Initialize employee cache
async function initializeEmployeeCache() {
  try {
    console.log("=== INITIALIZING EMPLOYEE CACHE ===");
    
    // Ensure Employee model is available
    if (!Employee) {
      console.error("Employee model not available");
      return false;
    }
    
    // Load employee data into cache
    await Employee.ensureCacheLoaded();
    
    const stats = Employee.getCacheStats();
    console.log(`✓ EMPLOYEE CACHE LOADED: ${stats.totalEmployees} employees`);
    console.log(`  Last updated: ${stats.lastUpdated}`);
    console.log(`  Cache age: ${stats.cacheAge}s`);
    
    employeeCacheLoaded = true;
    return true;
    
  } catch (error) {
    console.error("❌ Employee cache initialization failed:", error);
    employeeCacheLoaded = false;
    return false;
  }
}

// NEW: Get employee cache statistics
function getEmployeeCacheStats() {
  try {
    if (!Employee || !Employee.getCacheStats) {
      return {
        isLoaded: false,
        totalEmployees: 0,
        lastUpdated: null,
        cacheAge: null,
        error: "Employee model not available"
      };
    }
    
    const stats = Employee.getCacheStats();
    return {
      isLoaded: stats.isLoaded,
      totalEmployees: stats.totalEmployees,
      lastUpdated: stats.lastUpdated,
      cacheAge: stats.cacheAge
    };
  } catch (error) {
    console.error("Error getting employee cache stats:", error);
    return {
      isLoaded: false,
      totalEmployees: 0,
      lastUpdated: null,
      cacheAge: null,
      error: error.message
    };
  }
}

// Database optimization function
async function optimizeDatabase(db) {
  if (!db) return
  
  console.log("Applying database optimizations...")
  
  try {
    // SQLite performance pragmas
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('cache_size = 50000')
    db.pragma('temp_store = MEMORY')
    db.pragma('mmap_size = 67108864') // 64MB memory mapping
    
    // Create performance indexes
    const indexes = [
      "CREATE INDEX IF NOT EXISTS idx_barcode ON employees(uid)",
      "CREATE INDEX IF NOT EXISTS idx_attendance_barcode ON attendance(employee_uid)",
      "CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date)",
      "CREATE INDEX IF NOT EXISTS idx_attendance_timestamp ON attendance(timestamp)",
      "CREATE INDEX IF NOT EXISTS idx_attendance_sync ON attendance(synced)",
      "CREATE INDEX IF NOT EXISTS idx_barcode_active ON employees(uid, status) WHERE status = 1",
      "CREATE INDEX IF NOT EXISTS idx_attendance_today ON attendance(employee_uid, date) WHERE date = date('now')"
    ]
    
    for (const indexSQL of indexes) {
      try {
        db.exec(indexSQL)
      } catch (error) {
        console.warn("Index creation warning:", error.message)
      }
    }
    
    console.log("✓ Database optimizations applied")
  } catch (error) {
    console.error("Database optimization error:", error)
  }
}

async function loadProfileWithCache(barcode) {
  if (!barcode) {
    console.warn("loadProfileWithCache: No barcode provided");
    return null;
  }

  const cacheKey = `profile_${barcode}`;
  
  // Check cache first
  if (profileCache && profileCache.has && profileCache.has(cacheKey)) {
    console.log(`✓ Cache hit for profile: ${barcode}`);
    const cached = profileCache.get(cacheKey);
    
    // Validate cached data
    if (cached && typeof cached === 'object' && cached.uid) {
      return cached;
    } else {
      console.warn(`Invalid cached data for ${barcode}, removing from cache`);
      profileCache.delete(cacheKey);
    }
  }
  
  try {
    // Ensure database is available
    if (!dbInstance) {
      console.log("Database not available, attempting to initialize...");
      const modules = await loadModules();
      if (modules.setupDatabase) {
        dbInstance = await modules.setupDatabase();
      }
      
      if (!dbInstance) {
        dbInstance = getDatabase();
      }
      
      if (!dbInstance) {
        console.error("Failed to get database instance for profile loading");
        return null;
      }
    }
    
    // Load from database
    const profile = await getProfileFromDB(barcode);
    if (!profile || !profile.uid) {
      console.log(`No profile found for barcode: ${barcode}`);
      return null;
    }
    
    console.log(`Loading profile from DB: ${barcode}`);
    
    // Load image if exists
    let imageBase64 = null;
    const imageCacheKey = `image_${barcode}`;
    
    // Check image cache first
    if (imageCache && imageCache.has && imageCache.has(imageCacheKey)) {
      imageBase64 = imageCache.get(imageCacheKey);
      console.log(`Image cache hit for: ${barcode}`);
    } else if (profile.imagePath) {
      try {
        const imagePath = getResourcePath(path.join("profiles", profile.imagePath));
        console.log(`Loading image from: ${imagePath}`);
        
        if (fs.existsSync(imagePath)) {
          const stats = fs.statSync(imagePath);
          if (stats.size > 0) {
            const imageBuffer = fs.readFileSync(imagePath);
            imageBase64 = imageBuffer.toString('base64');
            
            // Cache the image
            if (imageCache && imageCache.set) {
              imageCache.set(imageCacheKey, imageBase64);
              console.log(`✓ Image cached for: ${barcode} (${stats.size} bytes)`);
            }
          } else {
            console.warn(`Image file is empty: ${imagePath}`);
          }
        } else {
          console.log(`Image file not found: ${imagePath}`);
        }
      } catch (error) {
        console.warn(`Image load error for ${barcode}:`, error.message);
      }
    }
    
    const result = {
      ...profile,
      image: imageBase64,
      cached_at: new Date().toISOString(),
      cache_source: 'database'
    };
    
    // Cache the complete profile
    if (profileCache && profileCache.set) {
      profileCache.set(cacheKey, result);
      console.log(`✓ Profile cached: ${barcode}`);
    }
    
    return result;
    
  } catch (error) {
    console.error(`Error loading profile ${barcode}:`, error);
    return null;
  }
}

async function preloadFrequentProfiles(database = null) {
  const db = database || (dbInstance ? dbInstance : getDatabase());
  
  if (!db) {
    console.warn("No database instance available for preloading profiles");
    return;
  }
  
  console.log("Preloading frequent profiles...");
  
  try {
    // Check if tables exist
    const tables = db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name IN ('attendance', 'employees')
    `).all();
    
    const hasAttendance = tables.some(t => t.name === 'attendance')
    const hasEmployees = tables.some(t => t.name === 'employees')
    
    console.log(`Available tables: ${tables.map(t => t.name).join(', ')}`)
    
    if (!hasEmployees) {
      console.warn("Employees table not found, skipping profile preloading");
      return;
    }
    
    let frequentProfiles = [];
    
    if (hasAttendance) {
      // Try to get recent/frequent employees from attendance
      const attendanceColumns = db.prepare(`PRAGMA table_info(attendance)`).all();
      const attendanceColumnNames = attendanceColumns.map(col => col.name);
      console.log("Attendance columns:", attendanceColumnNames);
      
      // Build query based on available columns
      let attendanceQuery = null;
      
      if (attendanceColumnNames.includes('employee_uid') && attendanceColumnNames.includes('timestamp')) {
        attendanceQuery = `
          SELECT employee_uid, COUNT(*) as scan_count 
          FROM attendance 
          WHERE datetime(timestamp) >= datetime('now', '-7 days')
          GROUP BY employee_uid 
          ORDER BY scan_count DESC, MAX(timestamp) DESC
          LIMIT 50
        `;
      } else if (attendanceColumnNames.includes('employee_uid') && attendanceColumnNames.includes('date')) {
        attendanceQuery = `
          SELECT employee_uid, COUNT(*) as scan_count 
          FROM attendance 
          WHERE date >= date('now', '-7 days')
          GROUP BY employee_uid 
          ORDER BY scan_count DESC
          LIMIT 50
        `;
      } else if (attendanceColumnNames.includes('uid')) {
        attendanceQuery = `
          SELECT uid as employee_uid, COUNT(*) as scan_count 
          FROM attendance 
          WHERE datetime(timestamp) >= datetime('now', '-7 days')
          GROUP BY uid 
          ORDER BY scan_count DESC
          LIMIT 50
        `;
      }
      
      if (attendanceQuery) {
        try {
          frequentProfiles = db.prepare(attendanceQuery).all();
          console.log(`Found ${frequentProfiles.length} frequent profiles from attendance`)
        } catch (queryError) {
          console.warn("Attendance query failed:", queryError.message)
        }
      }
    }
    
    // Fallback: get active employees if no attendance data
    if (frequentProfiles.length === 0) {
      console.log("No frequent profiles from attendance, loading active employees...");
      
      const employeeColumns = db.prepare(`PRAGMA table_info(employees)`).all();
      const employeeColumnNames = employeeColumns.map(col => col.name);
      console.log("Employee columns:", employeeColumnNames);
      
      let employeeQuery = `SELECT uid as employee_uid FROM employees`;
      
      if (employeeColumnNames.includes('status')) {
        employeeQuery += ` WHERE status = 1`;
      }
      
      if (employeeColumnNames.includes('last_accessed')) {
        employeeQuery += ` ORDER BY last_accessed DESC`;
      } else if (employeeColumnNames.includes('created_at')) {
        employeeQuery += ` ORDER BY created_at DESC`;
      }
      
      employeeQuery += ` LIMIT 30`;
      
      try {
        frequentProfiles = db.prepare(employeeQuery).all().map(emp => ({
          employee_uid: emp.employee_uid,
          scan_count: 1
        }));
        console.log(`Found ${frequentProfiles.length} active employees for preloading`)
      } catch (queryError) {
        console.error("Employee query failed:", queryError.message)
        return;
      }
    }
    
    if (frequentProfiles.length === 0) {
      console.log("No profiles available for preloading");
      return;
    }
    
    console.log(`Starting preload of ${frequentProfiles.length} profiles`);
    
    // Preload in background with better error tracking
    setTimeout(async () => {
      let successCount = 0;
      let errorCount = 0;
      const errors = [];
      
      for (const { employee_uid } of frequentProfiles) {
        if (!employee_uid) {
          errorCount++;
          continue;
        }
        
        try {
          const profile = await loadProfileWithCache(employee_uid);
          if (profile) {
            successCount++;
          } else {
            errorCount++;
            errors.push(`No profile data for ${employee_uid}`);
          }
        } catch (error) {
          errorCount++;
          errors.push(`${employee_uid}: ${error.message}`);
        }
        
        // Small delay to prevent overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      console.log(`✓ Profile preloading complete - Success: ${successCount}, Errors: ${errorCount}`);
      
      if (errors.length > 0 && errors.length <= 10) {
        console.log("Preload errors:", errors);
      } else if (errors.length > 10) {
        console.log(`${errors.length} preload errors (showing first 5):`, errors.slice(0, 5));
      }
    }, 1000);
    
  } catch (error) {
    console.error("Profile preloading error:", error);
  }
}

// Updated database setup function to properly initialize dbInstance
async function initializeDatabaseAndCaches() {
  try {
    console.log("Initializing database and caches...");
    
    // Initialize caches first
    initializeCaches();
    
    // Load and setup database
    const modules = await loadModules();
    if (modules.setupDatabase) {
      dbInstance = await modules.setupDatabase();
      
      if (dbInstance) {
        console.log("Database instance created successfully");
        
        // Apply database optimizations
        await optimizeDatabase(dbInstance);
        
        // Start profile preloading after database is ready
        setTimeout(() => {
          preloadFrequentProfiles(dbInstance);
        }, 1000);
      } else {
        console.warn("Database setup did not return a database instance");
      }
    }
    
    return dbInstance;
  } catch (error) {
    console.error("Database and cache initialization failed:", error);
    return null;
  }
}

// Cache management functions
function clearExpiredCaches() {
  if (profileCache) {
    const beforeSize = profileCache.size
    profileCache.purgeStale()
    console.log(`Cleared ${beforeSize - profileCache.size} expired profile cache entries`)
  }
  
  if (imageCache) {
    const beforeSize = imageCache.size
    imageCache.purgeStale()
    console.log(`Cleared ${beforeSize - imageCache.size} expired image cache entries`)
  }
}

function getCacheStatistics() {
  try {
    const stats = {
      profileCache: {
        size: profileCache && profileCache.size ? profileCache.size : 0,
        max: profileCache && profileCache.max ? profileCache.max : 0,
        hits: profileCache && profileCache.calculatedSize ? profileCache.calculatedSize : 0
      },
      imageCache: {
        size: imageCache && imageCache.size ? imageCache.size : 0,
        max: imageCache && imageCache.max ? imageCache.max : 0,
        hits: imageCache && imageCache.calculatedSize ? imageCache.calculatedSize : 0
      },
      rendererCache: {
        size: rendererCache ? rendererCache.size : 0
      },
      employeeCache: getEmployeeCacheStats() // NEW: Add employee cache stats
    };
    
    console.log("Cache statistics:", stats);
    return stats;
  } catch (error) {
    console.error("Error getting cache statistics:", error);
    return {
      profileCache: { size: 0, max: 0, hits: 0 },
      imageCache: { size: 0, max: 0, hits: 0 },
      rendererCache: { size: 0 },
      employeeCache: { isLoaded: false, totalEmployees: 0, lastUpdated: null, cacheAge: null }
    };
  }
}

function registerCacheIpcHandlers() {
  console.log("Registering cache IPC handlers...")
  
  // Fast profile lookup with cache
  ipcMain.handle("get-profile-fast", async (event, barcode) => {
    try {
      const profile = await loadProfileWithCache(barcode)
      return {
        success: true,
        data: profile,
        cached: profileCache.has(`profile_${barcode}`)
      }
    } catch (error) {
      return {
        success: false,
        error: error.message
      }
    }
  })
  
  // Cache management
  ipcMain.handle("clear-profile-cache", async () => {
    try {
      profileCache.clear()
      imageCache.clear()
      rendererCache.clear()
      
      return {
        success: true,
        message: "All caches cleared"
      }
    } catch (error) {
      return {
        success: false,
        error: error.message
      }
    }
  })
  
  // Get cache statistics (now includes employee cache)
  ipcMain.handle("get-cache-stats", async () => {
    try {
      return {
        success: true,
        data: getCacheStatistics()
      }
    } catch (error) {
      return {
        success: false,
        error: error.message
      }
    }
  })
  
  // NEW: Refresh employee cache
  ipcMain.handle("refresh-employee-cache", async () => {
    try {
      console.log("Manually refreshing employee cache...");
      await Employee.refreshCache();
      const stats = Employee.getCacheStats();
      
      return {
        success: true,
        message: "Employee cache refreshed successfully",
        stats: stats
      };
    } catch (error) {
      console.error("Error refreshing employee cache:", error);
      return {
        success: false,
        error: error.message
      };
    }
  })
  
  // NEW: Get employee cache stats
  ipcMain.handle("get-employee-cache-stats", async () => {
    try {
      const stats = getEmployeeCacheStats();
      return {
        success: true,
        data: stats
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  })
  
  // NEW: Clear employee cache
  ipcMain.handle("clear-employee-cache", async () => {
    try {
      Employee.clearCache();
      employeeCacheLoaded = false;
      
      return {
        success: true,
        message: "Employee cache cleared"
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  })
  
  // NEW: Preload employee cache
  ipcMain.handle("preload-employee-cache", async () => {
    try {
      const success = await initializeEmployeeCache();
      
      if (success) {
        const stats = Employee.getCacheStats();
        return {
          success: true,
          message: "Employee cache preloaded",
          stats: stats
        };
      } else {
        return {
          success: false,
          error: "Failed to preload employee cache"
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  })
  
  console.log("✓ Cache IPC handlers registered")
}

// Auto-updater configuration and event handlers
function setupAutoUpdater() {
  console.log("Setting up auto-updater...")
  
  // Configure updater settings
  autoUpdater.logger = require("electron-log")
  autoUpdater.logger.transports.file.level = "info"
  
  // Set update check interval (check every 30 minutes)
  setInterval(() => {
    if (!isDev) {
      console.log("Performing scheduled update check...")
      autoUpdater.checkForUpdates()
    }
  }, 30 * 60 * 1000) // 30 minutes

  // Auto-updater event handlers
  autoUpdater.on('checking-for-update', () => {
    console.log('Checking for update...')
    if (mainWindow) {
      mainWindow.webContents.send('updater-status', {
        status: 'checking',
        message: 'Checking for updates...'
      })
    }
  })

  autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info)
    if (mainWindow) {
      mainWindow.webContents.send('updater-status', {
        status: 'available',
        message: 'Update available',
        version: info.version,
        releaseNotes: info.releaseNotes,
        releaseDate: info.releaseDate
      })
    }

    // Show dialog asking user if they want to download the update
    const dialogOpts = {
      type: 'info',
      buttons: ['Download Now', 'Later'],
      defaultId: 0,
      title: 'Application Update',
      message: `A new version (${info.version}) is available!`,
      detail: 'Would you like to download it now? The update will be installed when you restart the application.'
    }

    dialog.showMessageBox(mainWindow, dialogOpts).then((returnValue) => {
      if (returnValue.response === 0) {
        console.log('User chose to download update')
        autoUpdater.downloadUpdate()
        updateDownloadStarted = true
      } else {
        console.log('User chose to download later')
        if (mainWindow) {
          mainWindow.webContents.send('updater-status', {
            status: 'postponed',
            message: 'Update postponed'
          })
        }
      }
    }).catch(err => {
      console.error('Error showing update dialog:', err)
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    console.log('Update not available:', info)
    if (mainWindow) {
      mainWindow.webContents.send('updater-status', {
        status: 'not-available',
        message: 'You are using the latest version'
      })
    }
  })

  autoUpdater.on('error', (err) => {
    console.error('Error in auto-updater:', err)
    if (mainWindow) {
      mainWindow.webContents.send('updater-status', {
        status: 'error',
        message: 'Error checking for updates',
        error: err.message
      })
    }
  })

  autoUpdater.on('download-progress', (progressObj) => {
    let log_message = "Download speed: " + progressObj.bytesPerSecond
    log_message = log_message + ' - Downloaded ' + progressObj.percent + '%'
    log_message = log_message + ' (' + progressObj.transferred + "/" + progressObj.total + ')'
    
    console.log(log_message)
    
    if (mainWindow) {
      mainWindow.webContents.send('updater-progress', {
        percent: Math.round(progressObj.percent),
        bytesPerSecond: progressObj.bytesPerSecond,
        transferred: progressObj.transferred,
        total: progressObj.total
      })
      
      mainWindow.webContents.send('updater-status', {
        status: 'downloading',
        message: `Downloading update... ${Math.round(progressObj.percent)}%`,
        progress: progressObj
      })
    }
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info)
    updateDownloadStarted = false
    
    if (mainWindow) {
      mainWindow.webContents.send('updater-status', {
        status: 'downloaded',
        message: 'Update downloaded successfully',
        version: info.version
      })
    }

    // Show dialog asking user to restart
    const dialogOpts = {
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      title: 'Application Update Ready',
      message: 'Update has been downloaded successfully!',
      detail: 'The application will restart to apply the update. Would you like to restart now?'
    }

    dialog.showMessageBox(mainWindow, dialogOpts).then((returnValue) => {
      if (returnValue.response === 0) {
        console.log('User chose to restart now')
        autoUpdater.quitAndInstall(false, true)
      } else {
        console.log('User chose to restart later')
        if (mainWindow) {
          mainWindow.webContents.send('updater-status', {
            status: 'ready-to-install',
            message: 'Update ready - will install on next restart'
          })
        }
      }
    }).catch(err => {
      console.error('Error showing restart dialog:', err)
    })
  })
}

// Improved path resolution that works in both dev and production
function getResourcePath(relativePath) {
  const possiblePaths = []

  if (isDev) {
    // Development mode - try multiple possible locations
    possiblePaths.push(
      path.join(__dirname, relativePath),
      path.join(__dirname, "src", relativePath),
      path.join(process.cwd(), relativePath),
      path.join(process.cwd(), "src", relativePath),
      path.join(app.getAppPath(), relativePath),
      path.join(app.getAppPath(), "src", relativePath),
    )
  } else {
    // Production mode - try multiple fallback locations
    const resourcesPath = process.resourcesPath || path.dirname(process.execPath)
    possiblePaths.push(
      path.join(resourcesPath, "app", "src", relativePath),
      path.join(resourcesPath, "app", relativePath),
      path.join(app.getAppPath(), "src", relativePath),
      path.join(app.getAppPath(), relativePath),
      path.join(resourcesPath, relativePath),
      path.join(__dirname, "src", relativePath),
      path.join(__dirname, relativePath),
    )
  }

  // Try each path until we find one that exists
  for (const testPath of possiblePaths) {
    console.log(`[${isDev ? "DEV" : "PROD"}] Testing path for "${relativePath}": ${testPath}`)

    if (fs.existsSync(testPath)) {
      console.log(`[${isDev ? "DEV" : "PROD"}] ✓ Found file: ${testPath}`)
      return testPath
    }
  }

  // If nothing found, log debugging info and return first path as fallback
  console.log(`[${isDev ? "DEV" : "PROD"}] ⚠️ File not found for: ${relativePath}`)
  console.log("Searched paths:")
  possiblePaths.forEach((p, i) => console.log(`  ${i + 1}. ${p}`))

  return possiblePaths[0]
}

// Enhanced async module loading with better error handling
async function loadModules() {
  const modules = {}

  try {
    console.log("Loading database module...")
    const dbPath = getResourcePath("./database/setup")
    console.log("Database module path:", dbPath)
    const { setupDatabase } = require(dbPath)
    modules.setupDatabase = setupDatabase
    console.log("✓ Database module loaded")
  } catch (error) {
    console.error("✗ Failed to load database module:", error.message)
    modules.setupDatabase = () => Promise.resolve()
  }

  try {
    console.log("Loading WebSocket module...")
    const wsPath = getResourcePath("services/websocket")
    console.log("WebSocket module path:", wsPath)
    const { startWebSocketServer } = require(wsPath)
    modules.startWebSocketServer = startWebSocketServer
    console.log("✓ WebSocket module loaded")
  } catch (error) {
    console.error("✗ Failed to load WebSocket module:", error.message)
    modules.startWebSocketServer = () => {}
  }

  try {
    console.log("Loading WebExportServer module...")
    const webExportPath = getResourcePath("services/webExportServer")
    console.log("WebExportServer module path:", webExportPath)
    const { WebExportServer } = require(webExportPath)
    modules.WebExportServer = WebExportServer
    console.log("✓ WebExportServer module loaded")
  } catch (error) {
    console.error("✗ Failed to load WebExportServer module:", error.message)
    modules.WebExportServer = class {
      constructor() {}
      start() {
        return Promise.resolve()
      }
      stop() {}
    }
  }

  return modules
}

// Enhanced route loading with better error handling and path resolution
function loadRoutes() {
  const routes = {}

  const routeModules = ["employees", "attendance", "settings", "export", "attendance-sync", "getDailySummary", "attendancedb", "summary-sync", "validateTime"]

  routeModules.forEach((moduleName) => {
    try {
      console.log(`Loading ${moduleName} routes...`)
      const routePath = getResourcePath(`api/routes/${moduleName}`)
      console.log(`${moduleName} route path:`, routePath)

      // Check if file exists before requiring
      if (!fs.existsSync(routePath)) {
        // Try alternative paths
        const altPaths = [
          getResourcePath(`api/routes/${moduleName}.js`),
          getResourcePath(`routes/${moduleName}`),
          getResourcePath(`routes/${moduleName}.js`),
          getResourcePath(`src/api/routes/${moduleName}`),
          getResourcePath(`src/api/routes/${moduleName}.js`),
          getResourcePath(`src/database/models/${moduleName}.js`),
          getResourcePath(`src/services/${moduleName}.js`),
        ]

        let foundPath = null
        for (const altPath of altPaths) {
          if (fs.existsSync(altPath)) {
            foundPath = altPath
            console.log(`Found alternative path for ${moduleName}: ${altPath}`)
            break
          }
        }

        if (!foundPath) {
          throw new Error(`Module file not found at any location`)
        }

        const moduleRoutes = require(foundPath)
        routes[moduleName] = moduleRoutes
      } else {
        const moduleRoutes = require(routePath)
        routes[moduleName] = moduleRoutes
      }

      console.log(`✓ ${moduleName} routes loaded`)

      // Log available functions in the module for debugging
      if (isDev && routes[moduleName]) {
        console.log(`  Available functions in ${moduleName}:`, Object.keys(routes[moduleName]))
      }
    } catch (error) {
      console.error(`✗ Failed to load ${moduleName} routes:`, error.message)
      console.error("Error stack:", error.stack)
      routes[moduleName] = {}
    }
  })

  // Load profile services with improved path resolution
  try {
    console.log("Loading profile services...")
    const profilePath = getResourcePath("services/profileService")
    console.log("Profile service path:", profilePath)

    if (!fs.existsSync(profilePath)) {
      // Try alternative paths for profile service
      const altPaths = [
        getResourcePath("services/profileService.js"),
        getResourcePath("profileService"),
        getResourcePath("profileService.js"),
        getResourcePath("src/services/profileService"),
        getResourcePath("src/services/profileService.js"),
      ]

      let foundPath = null
      for (const altPath of altPaths) {
        if (fs.existsSync(altPath)) {
          foundPath = altPath
          console.log(`Found alternative path for profileService: ${altPath}`)
          break
        }
      }

      if (!foundPath) {
        throw new Error(`Profile service file not found at any location`)
      }

      routes.profileServices = require(foundPath)
    } else {
      routes.profileServices = require(profilePath)
    }

    console.log("✓ Profile services loaded")

    if (isDev && routes.profileServices) {
      console.log("  Available functions in profileServices:", Object.keys(routes.profileServices))
    }
  } catch (error) {
    console.error("✗ Failed to load profile services:", error.message)
    console.error("Error stack:", error.stack)
    routes.profileServices = {}
  }

  return routes
}

function createMainWindow() {
  console.log("Creating main window...")

  const iconPath = getResourcePath("assets/icon.png")
  const preloadPath = getResourcePath("preload.js")
  console.log("Icon path:", iconPath)
  console.log("Preload path:", preloadPath)

  // Check if preload script exists
  if (!fs.existsSync(preloadPath)) {
    console.warn("⚠️ Preload script not found, trying alternative paths...")
    const altPreloadPaths = [
      path.join(__dirname, "preload.js"),
      path.join(process.cwd(), "preload.js"),
      path.join(app.getAppPath(), "preload.js"),
    ]

    let foundPreload = null
    for (const altPath of altPreloadPaths) {
      if (fs.existsSync(altPath)) {
        foundPreload = altPath
        console.log(`Found preload script at: ${altPath}`)
        break
      }
    }

    if (!foundPreload) {
      console.error("❌ Preload script not found at any location!")
    }
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: fs.existsSync(preloadPath) ? preloadPath : undefined,
      webSecurity: true, // Keep security enabled
      allowRunningInsecureContent: false,
      experimentalFeatures: true,
    },
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    show: false,
  })

  const indexPath = getResourcePath("renderer/index.html")
  console.log("Loading index from:", indexPath)

  if (!fs.existsSync(indexPath)) {
    console.error("Index file not found, trying alternative paths...")
    const altIndexPaths = [
      getResourcePath("index.html"),
      getResourcePath("src/renderer/index.html"),
      path.join(__dirname, "index.html"),
      path.join(__dirname, "renderer", "index.html"),
      path.join(__dirname, "src", "renderer", "index.html"),
    ]

    let foundIndex = null
    for (const altPath of altIndexPaths) {
      if (fs.existsSync(altPath)) {
        foundIndex = altPath
        console.log(`Found index.html at: ${altPath}`)
        break
      }
    }

    if (foundIndex) {
      mainWindow.loadFile(foundIndex)
    } else {
      console.error("Index file not found, creating fallback")
      const fallbackHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Attendance System</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; text-align: center; }
            .error { color: red; margin: 20px 0; }
            .info { color: blue; margin: 10px 0; }
          </style>
        </head>
        <body>
          <h1>Employee Attendance System</h1>
          <div class="error">Application files not found at expected location</div>
          <div class="info">Path checked: ${indexPath}</div>
          <div class="info">Please ensure all files are properly bundled</div>
          <div class="info">Development mode: ${isDev}</div>
          <div class="info">__dirname: ${__dirname}</div>
          <div class="info">process.cwd(): ${process.cwd()}</div>
        </body>
        </html>
      `
      mainWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(fallbackHtml)}`)
    }
  } else {
    mainWindow.loadFile(indexPath)
  }

  mainWindow.once("ready-to-show", () => {
    console.log("Main window ready, showing...")
    mainWindow.show()
    if (!isDev) {
      mainWindow.maximize()
    }
    
    // Setup auto-updater after window is ready
    setupAutoUpdater()
    
    // Check for updates on app start (after a short delay)
    if (!isDev) {
      setTimeout(() => {
        console.log("Performing initial update check...")
        autoUpdater.checkForUpdates()
      }, 3000) // 3 second delay
    }
  })

  mainWindow.on("closed", () => {
    console.log("Main window closed")
    mainWindow = null
  })

  // Debug: Log load failures
  mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL) => {
    console.error("Page failed to load:", errorCode, errorDescription, validatedURL)
  })

  mainWindow.webContents.on("did-finish-load", () => {
    console.log("Page finished loading")
  })

  // Open dev tools in development mode
  if (isDev) {
    mainWindow.webContents.openDevTools()
  }
}

// Enhanced menu with update options
function createApplicationMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        {
          label: "Settings",
          click: () => createSettingsWindow(),
        },
        { type: "separator" },
        {
          label: "Export Data",
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send("show-export-dialog")
            }
          },
        },
        {
          label: "Sync Attendance to Server",
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send("sync-attendance-to-server")
            }
          },
        },
        {
          label: "Web Export URL",
          click: () => {
            const { shell } = require("electron")
            shell.openExternal("http://localhost:3001/api/docs")
          },
        },
        { type: "separator" },
        {
          label: "Exit",
          click: () => app.quit(),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Check for Updates",
          click: () => {
            if (!isDev) {
              console.log("Manual update check triggered")
              autoUpdater.checkForUpdates()
            } else {
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Development Mode',
                message: 'Updates are disabled in development mode.'
              })
            }
          }
        },
        {
          label: "About",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About',
              message: `Attendance System v${app.getVersion()}`,
              detail: 'Employee Attendance Management System'
            })
          }
        }
      ],
    }
  ]

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 600,
    height: 500,
    parent: mainWindow,
    modal: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: getResourcePath("preload.js")
    }
  })

  const settingsPath = getResourcePath("renderer/settings.html")
  if (fs.existsSync(settingsPath)) {
    settingsWindow.loadFile(settingsPath)
  } else {
    console.error("Settings file not found")
    settingsWindow.close()
    return
  }

  settingsWindow.on("closed", () => {
    settingsWindow = null
  })
}

// Face-Recognition IPC handlers

//face-recognition
ipcMain.handle('get-profiles-path', async () => {
  try {
    const profilesPath = path.join(app.getPath('userData'), 'profiles');
    return { success: true, path: profilesPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Handler to save face descriptor to disk
ipcMain.handle('save-face-descriptor', async (event, { path: filePath, descriptor }) => {
  try {
    // Ensure directory exists
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    
    // Save descriptor as JSON
    const data = JSON.stringify({
      descriptor: descriptor,
      version: '1.0',
      timestamp: new Date().toISOString()
    }, null, 2);
    
    await fs.writeFile(filePath, data, 'utf8');
    
    return {
      success: true,
      path: filePath
    };
  } catch (error) {
    console.error('Error saving face descriptor:', error);
    return {
      success: false,
      error: error.message
    };
  }
});

// Handler to read face descriptor from disk
ipcMain.handle('read-face-descriptor', async (event, filePath) => {
  try {
    // Check if file exists
    await fs.access(filePath);
    
    // Read and parse descriptor
    const data = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(data);
    
    return {
      success: true,
      data: parsed.descriptor,
      timestamp: parsed.timestamp
    };
  } catch (error) {
    // File doesn't exist or can't be read
    return {
      success: false,
      error: error.message
    };
  }
});

// Optional: Handler to delete descriptor cache (for cleanup or refresh)
ipcMain.handle('delete-face-descriptor', async (event, filePath) => {
  try {
    await fs.unlink(filePath);
    return {
      success: true,
      path: filePath
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
});

// Optional: Handler to clear all descriptor caches in profiles directory
ipcMain.handle('clear-all-face-descriptors', async (event, profilesPath) => {
  try {
    const files = await fs.readdir(profilesPath);
    const descriptorFiles = files.filter(file => file.endsWith('.descriptor.json'));
    
    let deletedCount = 0;
    for (const file of descriptorFiles) {
      try {
        await fs.unlink(path.join(profilesPath, file));
        deletedCount++;
      } catch (error) {
        console.warn(`Failed to delete ${file}:`, error);
      }
    }
    
    return {
      success: true,
      deletedCount: deletedCount,
      totalFound: descriptorFiles.length
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
});

ipcMain.handle('generate-face-descriptor-from-image', async (event, imagePath) => {
  try {
    // Check if image exists
    await fs.access(imagePath);
    
    // Generate descriptor path
    const descriptorPath = imagePath.replace(/\.(jpg|jpeg|png|gif|webp)$/i, '.descriptor.json');
    
    // Return paths so renderer can generate descriptor
    return {
      success: true,
      imagePath: imagePath,
      descriptorPath: descriptorPath
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
});

ipcMain.handle('generate-descriptor-for-employee', async (event, employeeUID) => {
  try {
    const { app } = require('electron');
    const profilesPath = path.join(app.getPath('userData'), 'profiles');
    
    // Find the image file for this employee
    const possibleExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    let imagePath = null;
    
    for (const ext of possibleExtensions) {
      const testPath = path.join(profilesPath, `${employeeUID}.${ext}`);
      try {
        await fs.access(testPath);
        imagePath = testPath;
        break;
      } catch (err) {
        // File doesn't exist, try next extension
      }
    }
    
    if (!imagePath) {
      return {
        success: false,
        error: 'Profile image not found'
      };
    }
    
    // Generate descriptor path
    const descriptorPath = imagePath.replace(/\.(jpg|jpeg|png|gif|webp)$/i, '.descriptor.json');
    
    return {
      success: true,
      imagePath: imagePath,
      descriptorPath: descriptorPath,
      employeeUID: employeeUID
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
});

// Server Edit Sync IPC handlers

// Initialize server edit sync service
ipcMain.handle("initialize-server-edit-sync", async () => {
  try {
    const serverEditSync = require("./services/serverEditSync");
    const result = await serverEditSync.initializeService();
    
    if (result.success) {
      // Start auto-sync after initialization
      serverEditSync.startAutoSync();
      console.log("✓ Server edit sync initialized and started");
    }
    
    return result;
  } catch (error) {
    console.error("Server edit sync initialization error:", error);
    return { success: false, error: error.message };
  }
});

// Check for server edits manually
ipcMain.handle("check-server-edits", async (event, silent = false) => {
  try {
    const serverEditSync = require("./services/serverEditSync");
    const result = await serverEditSync.checkServerEdits(silent);
    
    // Notify renderer about updates if any changes
    if (result.success && (result.applied > 0 || result.deleted > 0)) {
      if (mainWindow) {
        mainWindow.webContents.send("server-edits-applied", {
          applied: result.applied,
          deleted: result.deleted,
          validated: result.validated,
          corrected: result.corrected,
          summariesRegenerated: result.summariesRegenerated,
          summariesUploaded: result.summariesUploaded,
          message: `${result.applied} records updated, ${result.deleted} deleted`
        });
      }
    }
    
    return result;
  } catch (error) {
    console.error("Check server edits error:", error);
    return { 
      success: false, 
      error: error.message,
      applied: 0,
      deleted: 0
    };
  }
});

// Get sync history
ipcMain.handle("get-server-edit-sync-history", async (event, limit = 10) => {
  try {
    const serverEditSync = require("./services/serverEditSync");
    const history = serverEditSync.getSyncHistory(limit);
    return { success: true, data: history };
  } catch (error) {
    console.error("Get sync history error:", error);
    return { success: false, error: error.message, data: [] };
  }
});

// Get last sync info (FIXED)
ipcMain.handle("get-server-edit-last-sync", async () => {
  try {
    const serverEditSync = require("./services/serverEditSync");
    const info = serverEditSync.getLastSyncInfo();
    return info;
  } catch (error) {
    console.error("Get last sync info error:", error);
    return { 
      success: false, 
      error: error.message,
      lastSyncTimestamp: null,
      isInitialized: false,
      syncInterval: 0,
      autoSyncRunning: false,
      syncHistory: []
    };
  }
});

// Force sync now
ipcMain.handle("force-server-edit-sync", async () => {
  try {
    const serverEditSync = require("./services/serverEditSync");
    const result = await serverEditSync.forceSyncNow();
    return result;
  } catch (error) {
    console.error("Force sync error:", error);
    return { 
      success: false, 
      error: error.message,
      downloaded: 0,
      applied: 0,
      deleted: 0
    };
  }
});

// Start auto sync
ipcMain.handle("start-server-edit-auto-sync", async () => {
  try {
    const serverEditSync = require("./services/serverEditSync");
    serverEditSync.startAutoSync();
    return { success: true, message: "Auto-sync started" };
  } catch (error) {
    console.error("Start auto-sync error:", error);
    return { success: false, error: error.message };
  }
});

// Stop auto sync
ipcMain.handle("stop-server-edit-auto-sync", async () => {
  try {
    const serverEditSync = require("./services/serverEditSync");
    serverEditSync.stopAutoSync();
    return { success: true, message: "Auto-sync stopped" };
  } catch (error) {
    console.error("Stop auto-sync error:", error);
    return { success: false, error: error.message };
  }
});

// Compare server and local attendance records
ipcMain.handle("compare-server-and-local", async (event, startDate, endDate) => {
  try {
    console.log(`IPC: Comparing server and local records from ${startDate} to ${endDate}`);
    const serverEditSync = require("./services/serverEditSync");
    const result = await serverEditSync.compareServerAndLocal(startDate, endDate);
    return result;
  } catch (error) {
    console.error("IPC error comparing records:", error);
    return {
      success: false,
      error: error.message
    };
  }
});

// Apply selected comparison actions
ipcMain.handle("apply-comparison-actions", async (event, actions) => {
  try {
    console.log(`IPC: Applying ${actions.length} comparison actions`);
    const serverEditSync = require("./services/serverEditSync");
    const result = await serverEditSync.applyComparisonActions(actions);
    
    // Notify renderer about updates if successful
    if (result.success && mainWindow) {
      const { results } = result;
      mainWindow.webContents.send("comparison-actions-applied", {
        added: results.added,
        updated: results.updated,
        deleted: results.deleted,
        summariesRebuilt: results.summariesRebuilt || 0,
        summariesUploaded: results.summariesUploaded || 0,
        timestamp: new Date().toISOString(),
        message: `Applied ${actions.length} actions successfully`
      });
    }
    
    return result;
  } catch (error) {
    console.error("IPC error applying comparison actions:", error);
    return {
      success: false,
      error: error.message,
      results: {
        added: 0,
        updated: 0,
        deleted: 0,
        errors: [error.message]
      }
    };
  }
});

// Get cached comparison results
ipcMain.handle("get-cached-comparison", async () => {
  try {
    const serverEditSync = require("./services/serverEditSync");
    const cached = serverEditSync.getCachedComparison();
    return {
      success: true,
      data: cached
    };
  } catch (error) {
    console.error("IPC error getting cached comparison:", error);
    return {
      success: false,
      error: error.message,
      data: null
    };
  }
});

// Clear comparison cache
ipcMain.handle("clear-comparison-cache", async () => {
  try {
    const serverEditSync = require("./services/serverEditSync");
    serverEditSync.clearComparisonCache();
    return {
      success: true,
      message: "Comparison cache cleared"
    };
  } catch (error) {
    console.error("IPC error clearing comparison cache:", error);
    return {
      success: false,
      error: error.message
    };
  }
});

// Enhanced IPC handlers for updater
function registerUpdaterIpcHandlers() {
  console.log("Registering updater IPC handlers...")
  // Manual update check
  ipcMain.handle("check-for-updates", async () => {
    if (!isDev) {
      try {
        console.log("Manual update check requested from renderer")
        const result = await autoUpdater.checkForUpdates()
        return {
          success: true,
          updateCheckResult: result
        }
      } catch (error) {
        console.error("Error checking for updates:", error)
        return {
          success: false,
          error: error.message
        }
      }
    } else {
      return {
        success: false,
        error: "Updates disabled in development mode"
      }
    }
  })

  // Download update
  ipcMain.handle("download-update", async () => {
    if (!isDev && !updateDownloadStarted) {
      try {
        console.log("Update download requested from renderer")
        await autoUpdater.downloadUpdate()
        updateDownloadStarted = true
        return {
          success: true,
          message: "Update download started"
        }
      } catch (error) {
        console.error("Error downloading update:", error)
        return {
          success: false,
          error: error.message
        }
      }
    } else if (updateDownloadStarted) {
      return {
        success: false,
        error: "Update download already in progress"
      }
    } else {
      return {
        success: false,
        error: "Updates disabled in development mode"
      }
    }
  })

  // Quit and install
  ipcMain.handle("quit-and-install", async () => {
    if (!isDev) {
      try {
        console.log("Quit and install requested from renderer")
        autoUpdater.quitAndInstall(false, true)
        return {
          success: true
        }
      } catch (error) {
        console.error("Error during quit and install:", error)
        return {
          success: false,
          error: error.message
        }
      }
    } else {
      return {
        success: false,
        error: "Updates disabled in development mode"
      }
    }
  })

  // Get app version
  ipcMain.handle("get-app-version", () => {
    return {
      version: app.getVersion(),
      isDev: isDev
    }
  })
}

app.whenReady().then(async () => {
  startWebSocketServer();

  try {
    console.log("App ready event fired, initializing...");

    // === STEP 1: Initialize Database ===
    console.log("=== INITIALIZING DATABASE ===");
    try {
      const modules = await loadModules();
      
      if (modules.setupDatabase) {
        console.log("Calling setupDatabase...");
        dbInstance = await modules.setupDatabase();
        
        if (!dbInstance) {
          console.log("Direct database initialization fallback...");
          const { getDatabase, setupDatabase: directSetup } = require(getResourcePath("./database/setup"));
          
          try {
            if (directSetup) {
              dbInstance = await directSetup();
            } else {
              dbInstance = getDatabase();
            }
          } catch (directError) {
            console.error("Direct database setup failed:", directError);
          }
        }
        
        if (dbInstance) {
          console.log("✓ DATABASE INITIALIZED SUCCESSFULLY");
          await optimizeDatabase(dbInstance);
          
          // Verify database has data
          try {
            const employeeCount = dbInstance.prepare("SELECT COUNT(*) as count FROM employees").get();
            console.log(`Database contains ${employeeCount.count} employees`);
          } catch (countError) {
            console.error("Error checking employee count:", countError);
          }
        } else {
          console.error("❌ CRITICAL: ALL DATABASE INITIALIZATION METHODS FAILED");
        }
      }
    } catch (dbError) {
      console.error("❌ Database initialization error:", dbError);
    }

    // === STEP 2: Initialize Caches ===
    console.log("=== INITIALIZING CACHES ===");
    const cacheInitSuccess = initializeCaches();
    
    if (cacheInitSuccess) {
      console.log("✓ CACHES INITIALIZED");
      
      // Verify cache instances
      console.log(`Profile cache available: ${!!profileCache} (${profileCache ? profileCache.size || 0 : 0} items)`);
      console.log(`Image cache available: ${!!imageCache} (${imageCache ? imageCache.size || 0 : 0} items)`);
    } else {
      console.error("❌ Cache initialization failed");
    }

    // === STEP 2.5: Initialize Employee Cache (NEW) ===
    console.log("=== INITIALIZING EMPLOYEE CACHE ===");
    try {
      const employeeCacheSuccess = await initializeEmployeeCache();
      if (employeeCacheSuccess) {
        console.log("✓ EMPLOYEE CACHE INITIALIZED");
      } else {
        console.warn("⚠️ Employee cache initialization had issues");
      }
    } catch (empError) {
      console.error("❌ Employee cache initialization error:", empError);
    }

    // === STEP 3: Start Services ===
    try {
      const modules = await loadModules();
      modules.startWebSocketServer();
      console.log("✓ WebSocket server started");

      webExportServer = new modules.WebExportServer(3001);
      await webExportServer.start();
      console.log("✓ Web Export Server started");
    } catch (error) {
      console.error("Service startup failed:", error.message);
    }

    // === STEP 4: Register ALL IPC Handlers ===
    console.log("=== REGISTERING ALL IPC HANDLERS ===");
    const routes = loadRoutes();
    registerIpcHandlers(routes);
    registerUpdaterIpcHandlers();
    registerCacheIpcHandlers(); // Now includes employee cache handlers
    
    // Initialize server edit sync service
    try {
      const serverEditSync = require(getResourcePath("/services/serverEditSync"));
      await serverEditSync.initializeService();
      serverEditSync.startAutoSync();
      console.log("✓ Server edit sync service initialized");
    } catch (error) {
      console.error("Failed to initialize server edit sync:", error);
    }

    console.log("✓ ALL IPC HANDLERS REGISTERED");

    // === STEP 5: Create Main Window ===
    createMainWindow();
    createApplicationMenu();

    // === STEP 6: Preload Profile Data ===
    if (dbInstance && profileCache && imageCache) {
      console.log("=== STARTING PROFILE PRELOAD ===");
      setTimeout(async () => {
        try {
          await preloadFrequentProfiles(dbInstance);
          console.log("✓ Profile preloading completed");
          
          console.log("Cache status after preloading:");
          console.log(`  Profile cache: ${profileCache.size || 0} items`);
          console.log(`  Image cache: ${imageCache.size || 0} items`);
          console.log(`  Employee cache: ${employeeCacheLoaded ? 'Loaded' : 'Not loaded'}`);
          
          const empStats = getEmployeeCacheStats();
          console.log(`  Employee cache stats:`, empStats);
          
        } catch (preloadError) {
          console.error("Profile preloading error:", preloadError);
        }
      }, 2000);
    }

    // === STEP 7: Setup Auto-Refresh for Employee Cache (NEW) ===
    // Refresh employee cache every hour
    setInterval(async () => {
      try {
        console.log("Auto-refreshing employee cache...");
        await Employee.refreshCache();
        const stats = Employee.getCacheStats();
        console.log(`Employee cache auto-refreshed: ${stats.totalEmployees} employees`);
      } catch (error) {
        console.error("Failed to auto-refresh employee cache:", error);
      }
    }, 60 * 60 * 1000); // 1 hour

    console.log("✓ App initialization sequence completed");
    
  } catch (error) {
    console.error("❌ Critical error during app initialization:", error);
    createMainWindow();
  }
});

async function getProfileFromDB(barcode) {
  // Ensure database exists
  if (!dbInstance) {
    console.log("Initializing database for profile lookup...");
    try {
      const modules = await loadModules();
      if (modules.setupDatabase) {
        dbInstance = await modules.setupDatabase();
      } else {
        dbInstance = getDatabase();
      }
    } catch (error) {
      console.error("Database initialization failed:", error);
      return null;
    }
  }

  if (!dbInstance) {
    console.error("No database available for profile lookup");
    return null;
  }

  try {
    const stmt = dbInstance.prepare(`
      SELECT * FROM employees 
      WHERE uid = ? AND (status = 1 OR status IS NULL)
      LIMIT 1
    `);
    const profile = stmt.get(barcode);
    
    if (profile) {
      console.log(`Profile found: ${barcode} -> ${profile.first_name} ${profile.last_name}`);
    } else {
      console.log(`No profile found for barcode: ${barcode}`);
    }
    
    return profile;
  } catch (error) {
    console.error("Profile lookup error:", error);
    return null;
  }
}

// Cache cleanup interval (run every 30 minutes)
setInterval(() => {
  clearExpiredCaches();
}, 30 * 60 * 1000);

console.log("✓ Enhanced preloading system initialized");

// Your existing app event handlers with update cleanup
app.on("window-all-closed", () => {
  console.log("All windows closed")

  // Stop web server when app is closing
  if (webExportServer) {
    try {
      webExportServer.stop()
      console.log("✓ Web export server stopped")
    } catch (error) {
      console.error("✗ Error stopping web export server:", error)
    }
  }

  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow()
  }
})

// Enhanced clean shutdown
app.on("before-quit", (event) => {
  console.log("App before quit")
  
  // If update download is in progress, ask user
  if (updateDownloadStarted) {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Wait for Download', 'Quit Anyway'],
      defaultId: 0,
      title: 'Update Download in Progress',
      message: 'An update is currently downloading. Would you like to wait for it to complete?'
    })
    
    if (choice === 0) {
      event.preventDefault()
      return
    }
  }
  
  if (webExportServer) {
    try {
      webExportServer.stop()
    } catch (error) {
      console.error("Error during cleanup:", error)
    }
  }
})

// Your existing error handlers
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error)
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason)
})

// Helper function to safely register IPC handlers
function safelyRegisterHandler(channel, handler, moduleName, handlerName) {
  console.log(`Attempting to register handler: ${channel}`)
  console.log(`Handler type:`, typeof handler)

  if (typeof handler === "function") {
    ipcMain.handle(channel, handler)
    console.log(`✓ Registered IPC handler: ${channel}`)
  } else {
    console.error(`✗ Handler ${handlerName} in ${moduleName} is undefined or not a function`)
    console.error(`  Handler type: ${typeof handler}`)
    console.error(`  Available methods in module:`, Object.keys(moduleName || {}))

    // Register a fallback handler that returns an error
    ipcMain.handle(channel, async () => {
      throw new Error(`Handler ${handlerName} is not implemented`)
    })
  }
}

// Register all IPC handlers
function registerIpcHandlers(routes) {
  console.log("Registering IPC handlers...")
  console.log("Available route modules:", Object.keys(routes))

   // Preload profiles for scanning session
ipcMain.handle("preload-scanning-session", async (event, barcodes = []) => {
  try {
    console.log(`Preloading ${barcodes.length} profiles for scanning session`)
    
    const results = await Promise.allSettled(
      barcodes.map(barcode => loadProfileWithCache(barcode))
    )
    
    const successful = results.filter(r => r.status === 'fulfilled').length
    
    return {
      success: true,
      preloaded: successful,
      total: barcodes.length,
      message: `Preloaded ${successful}/${barcodes.length} profiles`
    }
  } catch (error) {
    return {
      success: false,
      error: error.message
    }
  }
})

  // Basic handlers
  ipcMain.handle("get-asset-path", (event, filename) => {
    return getResourcePath(path.join("assets", filename))
  })

  ipcMain.handle('read-file-as-base64', async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      const buffer = fs.readFileSync(filePath);
      const base64 = buffer.toString('base64');
      return { success: true, data: base64 };
    }
    return { success: false, error: 'File not found' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

  ipcMain.handle("get-profile-path", (event, filename) => {
    return getResourcePath(path.join("profiles", filename))
  })

  // Additional utility handlers for preload script
  ipcMain.handle("file-exists", (event, filePath) => {
    try {
      return fs.existsSync(filePath)
    } catch (error) {
      console.error("Error checking file existence:", error)
      return false
    }
  })

  ipcMain.handle("read-text-file", async (event, filePath) => {
    try {
      return fs.readFileSync(filePath, "utf8")
    } catch (error) {
      console.error("Error reading file:", error)
      throw error
    }
  })

  ipcMain.handle("write-text-file", async (event, filePath, content) => {
    try {
      fs.writeFileSync(filePath, content, "utf8")
      return true
    } catch (error) {
      console.error("Error writing file:", error)
      throw error
    }
  })

  ipcMain.handle("get-cache-stats", async () => {
  try {
    return {
      success: true,
      data: getCacheStatistics()
    }
  } catch (error) {
    return {
      success: false,
      error: error.message
    }
  }
})

ipcMain.handle("get-app-version", () => {
  return {
    success: true,
    version: app.getVersion(),
    isDev: isDev
  }
})

ipcMain.handle("get-profile-fast", async (event, barcode) => {
  try {
    const profile = await loadProfileWithCache(barcode)
    return {
      success: true,
      data: profile,
      cached: profileCache && profileCache.has ? profileCache.has(`profile_${barcode}`) : false
    }
  } catch (error) {
    return {
      success: false,
      error: error.message
    }
  }
})

  // Employee route handlers
  const employeeRoutes = routes.employees || {}
  console.log("Employee routes available:", Object.keys(employeeRoutes))
  
  // Override get-employees to ensure cache is loaded first
  ipcMain.handle("get-employees", async () => {
    try {
      console.log("IPC: get-employees called (using cache)");
      
      // Ensure employee cache is loaded
      await Employee.ensureCacheLoaded();
      
      // Get employees from cache
      const employees = Employee.getAll();
      
      return {
        success: true,
        data: employees,
        cached: true,
        count: employees.length
      };
    } catch (error) {
      console.error("Error in get-employees:", error);
      return {
        success: false,
        error: error.message
      };
    }
  });
  
  // Override sync-employees to refresh cache after sync
  ipcMain.handle("sync-employees", async () => {
    try {
      console.log("IPC: sync-employees called");
      
      // Call original sync function
      const result = await employeeRoutes.syncEmployees();
      
      // Refresh employee cache after successful sync
      if (result.success) {
        console.log("Refreshing employee cache after sync...");
        await Employee.refreshCache();
        const stats = Employee.getCacheStats();
        console.log(`Employee cache refreshed: ${stats.totalEmployees} employees`);
      }
      
      return result;
    } catch (error) {
      console.error("Error in sync-employees:", error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  // Attendance route handlers
  const attendanceRoutes = routes.attendance || {}
  console.log("Attendance routes available:", Object.keys(attendanceRoutes))
  safelyRegisterHandler("clock-attendance", attendanceRoutes.clockAttendance, attendanceRoutes, "clockAttendance")
  safelyRegisterHandler("get-today-attendance",attendanceRoutes.getTodayAttendance,attendanceRoutes,"getTodayAttendance")
  safelyRegisterHandler("get-employee-attendance",attendanceRoutes.getEmployeeAttendance,attendanceRoutes,"getEmployeeAttendance")
  safelyRegisterHandler("get-today-statistics",attendanceRoutes.getTodayStatistics,attendanceRoutes,"getTodayStatistics")

  // Daily summary handlers (from attendancedb module)
  const dailysummary = routes.attendancedb || {}
  console.log("Daily summary routes available:", Object.keys(dailysummary))
  safelyRegisterHandler("get-daily-summary", dailysummary.getDailySummary, dailysummary, "getDailySummary")

  // Summary sync handlers
  const summarySync = routes["summary-sync"] || {}
  console.log("Summary sync routes available:", Object.keys(summarySync))
  safelyRegisterHandler("get-All-daily-summary-for-sync", summarySync.getAllDailySummaryForSync, summarySync, "getAllDailySummaryForSync")
  safelyRegisterHandler("sync-daily-summary-to-server", summarySync.syncDailySummaryToServer, summarySync, "syncDailySummaryToServer")
  safelyRegisterHandler("get-unsynced-daily-summary-count", summarySync.getUnsyncedDailySummaryCount, summarySync, "getUnsyncedDailySummaryCount")
  safelyRegisterHandler("force-sync-all-daily-summary", summarySync.forceSyncAllDailySummary, summarySync, "forceSyncAllDailySummary")
  safelyRegisterHandler("get-daily-summary-last-sync-time", summarySync.getDailySummaryLastSyncTime, summarySync, "getDailySummaryLastSyncTime")
  safelyRegisterHandler("mark-summary-data-changed", summarySync.markSummaryDataChanged, summarySync, "markSummaryDataChanged")
  safelyRegisterHandler("get-summary-data-change-status", summarySync.getSummaryDataChangeStatus, summarySync, "getSummaryDataChangeStatus")
  safelyRegisterHandler("reset-summary-data-change-status", summarySync.resetSummaryDataChangeStatus, summarySync, "resetSummaryDataChangeStatus")

  // Settings route handlers
  const settingsRoutes = routes.settings || {}
  console.log("Settings routes available:", Object.keys(settingsRoutes))
  safelyRegisterHandler("get-settings", settingsRoutes.getSettings, settingsRoutes, "getSettings")
  safelyRegisterHandler("update-settings", settingsRoutes.updateSettings, settingsRoutes, "updateSettings")

  // Export route handlers
  const exportRoutes = routes.export || {}
  console.log("Export routes available:", Object.keys(exportRoutes))
  safelyRegisterHandler(
    "export-attendance-data",
    exportRoutes.exportAttendanceData,
    exportRoutes,
    "exportAttendanceData",
  )
  safelyRegisterHandler("get-export-formats", exportRoutes.getExportFormats, exportRoutes, "getExportFormats")
  safelyRegisterHandler("get-export-statistics", exportRoutes.getExportStatistics, exportRoutes, "getExportStatistics")

  // Attendance sync route handlers
  const attendanceSyncRoutes = routes["attendance-sync"] || {}
  console.log("Attendance sync routes available:", Object.keys(attendanceSyncRoutes))
  safelyRegisterHandler(
    "sync-attendance-to-server",
    attendanceSyncRoutes.syncAttendanceToServer,
    attendanceSyncRoutes,
    "syncAttendanceToServer",
  )
  safelyRegisterHandler(
    "get-unsynced-attendance-count",
    attendanceSyncRoutes.getUnsyncedAttendanceCount,
    attendanceSyncRoutes,
    "getUnsyncedAttendanceCount",
  )
  safelyRegisterHandler(
    "get-all-attendance-for-sync",
    attendanceSyncRoutes.getAllAttendanceForSync,
    attendanceSyncRoutes,
    "getAllAttendanceForSync",
  )
  safelyRegisterHandler(
    "mark-attendance-as-synced",
    attendanceSyncRoutes.markAttendanceAsSynced,
    attendanceSyncRoutes,
    "markAttendanceAsSynced",
  )

  // Validate time route handlers
  const validateTimeRoutes = routes.validateTime || {}
  console.log("Validate time routes available:", Object.keys(validateTimeRoutes))
  safelyRegisterHandler("validate-attendance-data", async (event, options = {}) => {
  const validateTimeRoutes = routes.validateTime || {};
  
  if (!validateTimeRoutes.validateAttendanceData || typeof validateTimeRoutes.validateAttendanceData !== 'function') {
    throw new Error('validateAttendanceData function is not available');
  }
  
  try {
    // Extract parameters from options object
    const {
      startDate = null,
      endDate = null,
      employeeUid = null,
      autoCorrect = true,
      updateSyncStatus = true,
      validateStatistics = true,
      rebuildSummary = true,
      apply8HourRule = true
    } = options;
    
    console.log('IPC Handler - validateAttendanceData called with:', {
      startDate, endDate, employeeUid, autoCorrect, updateSyncStatus, validateStatistics, rebuildSummary
    });
    
    // Call the validation function with proper parameters
    const result = await validateTimeRoutes.validateAttendanceData(
      startDate,
      endDate, 
      employeeUid,
      {
        autoCorrect,
        updateSyncStatus,
        validateStatistics,
        rebuildSummary,
        apply8HourRule
      }
    );
    
    return {
      success: true,
      data: result
    };
    
  } catch (error) {
    console.error('Error in validateAttendanceData IPC handler:', error);
    return {
      success: false,
      error: error.message
    };
  }
}, validateTimeRoutes, "validateAttendanceData");
  safelyRegisterHandler("validate-today-attendance", validateTimeRoutes.validateTodayAttendance, validateTimeRoutes, "validateTodayAttendance")
  safelyRegisterHandler("validate-employee-today-attendance", validateTimeRoutes.validateEmployeeTodayAttendance, validateTimeRoutes, "validateEmployeeTodayAttendance")
  safelyRegisterHandler("validate-and-correct-unsynced-records", validateTimeRoutes.validateAndCorrectUnsyncedRecords, validateTimeRoutes, "validateAndCorrectUnsyncedRecords")
  safelyRegisterHandler("validate-single-record", validateTimeRoutes.validateSingleRecord, validateTimeRoutes, "validateSingleRecord")
  
// Profile service handlers
const profileServices = routes.profileServices || {}
console.log("Profile services available:", Object.keys(profileServices))

// Profile images check handler
ipcMain.handle("check-profile-images", async (event, employeeUids) => {
  try {
    console.log("IPC Handler - check-profile-images called with:", typeof employeeUids, employeeUids)
    
    // Don't pass the event object - call the service function directly
    if (profileServices.checkProfileImages && typeof profileServices.checkProfileImages === 'function') {
      // If employeeUids is provided, pass it; otherwise call without parameters
      const result = employeeUids ? 
        await profileServices.checkProfileImages(employeeUids) : 
        await profileServices.checkProfileImages()
      
      return result
    } else {
      console.error("checkProfileImages function not available in profileServices")
      return {
        success: false,
        error: "Profile service not available",
        downloaded: 0,
        total: 0,
        percentage: 0,
        downloadedUids: [],
        missingUids: [],
        profilesDir: "Not available"
      }
    }
  } catch (error) {
    console.error("IPC Handler Error - check-profile-images:", error)
    return {
      success: false,
      error: error.message,
      downloaded: 0,
      total: 0,
      percentage: 0,
      downloadedUids: [],
      missingUids: [],
      profilesDir: "Error occurred"
    }
  }
})

// NEW: Handler for bulk profile downloads
ipcMain.handle("bulk-download-profiles", async (event, serverUrl, options = {}) => {
  try {
    console.log("IPC Handler - bulk-download-profiles called")
    console.log("Server URL:", serverUrl)
    console.log("Options:", options)
    
    if (profileServices.bulkDownloadProfiles && typeof profileServices.bulkDownloadProfiles === 'function') {
      const result = await profileServices.bulkDownloadProfiles(serverUrl, options)
      return result
    } else {
      console.error("bulkDownloadProfiles function not available in profileServices")
      return {
        success: false,
        error: "Bulk download service not available"
      }
    }
  } catch (error) {
    console.error("IPC Handler Error - bulk-download-profiles:", error)
    return {
      success: false,
      error: error.message
    }
  }
})

// NEW: Handler for bulk download by department
ipcMain.handle("bulk-download-by-department", async (event, serverUrl, department, onProgress) => {
  try {
    console.log("IPC Handler - bulk-download-by-department called")
    console.log("Server URL:", serverUrl)
    console.log("Department:", department)
    
    if (profileServices.bulkDownloadByDepartment && typeof profileServices.bulkDownloadByDepartment === 'function') {
      const result = await profileServices.bulkDownloadByDepartment(serverUrl, department, onProgress)
      return result
    } else {
      console.error("bulkDownloadByDepartment function not available in profileServices")
      return {
        success: false,
        error: "Bulk download by department service not available"
      }
    }
  } catch (error) {
    console.error("IPC Handler Error - bulk-download-by-department:", error)
    return {
      success: false,
      error: error.message
    }
  }
})

// NEW: Handler for bulk download by search
ipcMain.handle("bulk-download-by-search", async (event, serverUrl, searchQuery, onProgress) => {
  try {
    console.log("IPC Handler - bulk-download-by-search called")
    console.log("Server URL:", serverUrl)
    console.log("Search Query:", searchQuery)
    
    if (profileServices.bulkDownloadBySearch && typeof profileServices.bulkDownloadBySearch === 'function') {
      const result = await profileServices.bulkDownloadBySearch(serverUrl, searchQuery, onProgress)
      return result
    } else {
      console.error("bulkDownloadBySearch function not available in profileServices")
      return {
        success: false,
        error: "Bulk download by search service not available"
      }
    }
  } catch (error) {
    console.error("IPC Handler Error - bulk-download-by-search:", error)
    return {
      success: false,
      error: error.message
    }
  }
})

// NEW: Handler for bulk download specific employees
ipcMain.handle("bulk-download-specific-employees", async (event, serverUrl, employeeUids, onProgress) => {
  try {
    console.log("IPC Handler - bulk-download-specific-employees called")
    console.log("Server URL:", serverUrl)
    console.log("Employee UIDs:", employeeUids)
    
    if (profileServices.bulkDownloadSpecificEmployees && typeof profileServices.bulkDownloadSpecificEmployees === 'function') {
      const result = await profileServices.bulkDownloadSpecificEmployees(serverUrl, employeeUids, onProgress)
      return result
    } else {
      console.error("bulkDownloadSpecificEmployees function not available in profileServices")
      return {
        success: false,
        error: "Bulk download specific employees service not available"
      }
    }
  } catch (error) {
    console.error("IPC Handler Error - bulk-download-specific-employees:", error)
    return {
      success: false,
      error: error.message
    }
  }
})

// NEW: Handler to check all profile images
ipcMain.handle("check-all-profile-images", async (event) => {
  try {
    console.log("IPC Handler - check-all-profile-images called")
    
    if (profileServices.checkAllProfileImages && typeof profileServices.checkAllProfileImages === 'function') {
      const result = await profileServices.checkAllProfileImages()
      return result
    } else {
      console.error("checkAllProfileImages function not available in profileServices")
      return {
        success: false,
        error: "Check all profiles service not available",
        downloaded: 0,
        profiles: [],
        profilesDir: "Not available"
      }
    }
  } catch (error) {
    console.error("IPC Handler Error - check-all-profile-images:", error)
    return {
      success: false,
      error: error.message,
      downloaded: 0,
      profiles: [],
      profilesDir: "Error occurred"
    }
  }
})

// NEW: Handler for profile cleanup
ipcMain.handle("cleanup-profiles", async (event) => {
  try {
    console.log("IPC Handler - cleanup-profiles called")
    
    if (profileServices.cleanupProfiles && typeof profileServices.cleanupProfiles === 'function') {
      const result = await profileServices.cleanupProfiles()
      return result
    } else {
      console.error("cleanupProfiles function not available in profileServices")
      return {
        success: false,
        error: "Profile cleanup service not available",
        cleaned: 0,
        errors: []
      }
    }
  } catch (error) {
    console.error("IPC Handler Error - cleanup-profiles:", error)
    return {
      success: false,
      error: error.message,
      cleaned: 0,
      errors: []
    }
  }
})

// NEW: Handler to get profiles directory info
ipcMain.handle("get-profiles-directory-info", async (event) => {
  try {
    console.log("IPC Handler - get-profiles-directory-info called")
    
    if (profileServices.getProfilesDirectoryInfo && typeof profileServices.getProfilesDirectoryInfo === 'function') {
      const result = profileServices.getProfilesDirectoryInfo()
      console.log("Profiles directory info:", result)
      return result
    } else {
      console.error("getProfilesDirectoryInfo function not available in profileServices")
      return {
        path: "Service not available",
        isDev: false,
        exists: false,
        error: "Service not available"
      }
    }
  } catch (error) {
    console.error("IPC Handler Error - get-profiles-directory-info:", error)
    return {
      path: "Error occurred",
      isDev: false,
      exists: false,
      error: error.message
    }
  }
})

// NEW: Handler to get local profile path
ipcMain.handle("get-local-profile-path", async (event, uid) => {
  try {
    console.log("IPC Handler - get-local-profile-path called with UID:", uid)
    
    if (profileServices.getLocalProfilePath && typeof profileServices.getLocalProfilePath === 'function') {
      const result = profileServices.getLocalProfilePath(uid)
      console.log("Local profile path for UID", uid, ":", result)
      return {
        success: true,
        path: result,
        uid: uid
      }
    } else {
      console.error("getLocalProfilePath function not available in profileServices")
      return {
        success: false,
        error: "Get local profile path service not available",
        path: null,
        uid: uid
      }
    }
  } catch (error) {
    console.error("IPC Handler Error - get-local-profile-path:", error)
    return {
      success: false,
      error: error.message,
      path: null,
      uid: uid
    }
  }
})

// NEW: Handler to check if a specific profile exists
ipcMain.handle("profile-exists", async (event, uid) => {
  try {
    console.log("IPC Handler - profile-exists called with UID:", uid)
    
    if (profileServices.profileExists && typeof profileServices.profileExists === 'function') {
      const result = await profileServices.profileExists(uid)
      console.log("Profile exists for UID", uid, ":", result)
      return {
        success: true,
        exists: result,
        uid: uid
      }
    } else {
      console.error("profileExists function not available in profileServices")
      return {
        success: false,
        error: "Profile exists check service not available",
        exists: false,
        uid: uid
      }
    }
  } catch (error) {
    console.error("IPC Handler Error - profile-exists:", error)
    return {
      success: false,
      error: error.message,
      exists: false,
      uid: uid
    }
  }
})

// Legacy handler for individual profile downloads (kept for backward compatibility)
ipcMain.handle("download-and-store-profile", async (event, uid, serverUrl) => {
  try {
    console.log("IPC Handler - download-and-store-profile called")
    console.log("UID:", uid, "Server URL:", serverUrl)
    
    if (profileServices.downloadAndStoreProfile && typeof profileServices.downloadAndStoreProfile === 'function') {
      const result = await profileServices.downloadAndStoreProfile(uid, serverUrl)
      return {
        success: result !== null,
        path: result,
        uid: uid
      }
    } else {
      console.error("downloadAndStoreProfile function not available in profileServices")
      return {
        success: false,
        error: "Individual profile download service not available",
        path: null,
        uid: uid
      }
    }
  } catch (error) {
    console.error("IPC Handler Error - download-and-store-profile:", error)
    return {
      success: false,
      error: error.message,
      path: null,
      uid: uid
    }
  }
})

console.log("✓ Profile service IPC handlers registration complete")


  console.log("✓ IPC handlers registration complete")
}