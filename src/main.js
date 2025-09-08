const { app, BrowserWindow, ipcMain, Menu } = require("electron")
const path = require("path")
const fs = require("fs")

// Determine if we're in development
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev')

console.log('Starting Electron app...')
console.log('Development mode:', isDev)
console.log('App path:', app.getAppPath())
console.log('Resources path:', process.resourcesPath)
console.log('__dirname:', __dirname)

// GPU fixes
app.commandLine.appendSwitch('--disable-gpu-sandbox')
app.commandLine.appendSwitch('--disable-software-rasterizer')
app.commandLine.appendSwitch('--disable-gpu')

let mainWindow
let settingsWindow
let webExportServer

// Improved path resolution that works in both dev and production
function getResourcePath(relativePath) {
  const possiblePaths = []
  
  if (isDev) {
    // Development mode - try multiple possible locations
    possiblePaths.push(
      path.join(__dirname, relativePath),                    // Direct from main directory
      path.join(__dirname, 'src', relativePath),             // From src/ subdirectory
      path.join(process.cwd(), relativePath),                // From current working directory
      path.join(process.cwd(), 'src', relativePath),         // From src/ in working directory
      path.join(app.getAppPath(), relativePath),             // From app path
      path.join(app.getAppPath(), 'src', relativePath)       // From src/ in app path
    )
  } else {
    // Production mode - try multiple fallback locations
    const resourcesPath = process.resourcesPath || path.dirname(process.execPath)
    possiblePaths.push(
      path.join(resourcesPath, 'app', 'src', relativePath),  // Standard ASAR structure
      path.join(resourcesPath, 'app', relativePath),         // Alternative ASAR structure
      path.join(app.getAppPath(), 'src', relativePath),      // Unpacked app structure
      path.join(app.getAppPath(), relativePath),             // Direct app structure
      path.join(resourcesPath, relativePath),                // Direct resources structure
      path.join(__dirname, 'src', relativePath),             // Fallback to dirname
      path.join(__dirname, relativePath)                     // Last resort
    )
  }

  // Try each path until we find one that exists
  for (const testPath of possiblePaths) {
    console.log(`[${isDev ? 'DEV' : 'PROD'}] Testing path for "${relativePath}": ${testPath}`)
    
    if (fs.existsSync(testPath)) {
      console.log(`[${isDev ? 'DEV' : 'PROD'}] ✓ Found file: ${testPath}`)
      return testPath
    }
  }

  // If nothing found, log debugging info and return first path as fallback
  console.log(`[${isDev ? 'DEV' : 'PROD'}] ⚠️ File not found for: ${relativePath}`)
  console.log('Searched paths:')
  possiblePaths.forEach((p, i) => console.log(`  ${i + 1}. ${p}`))
  
  // Debug: Show what's actually in some key directories
  const debugDirs = [
    __dirname,
    path.join(__dirname, 'src'),
    process.cwd(),
    path.join(process.cwd(), 'src'),
    app.getAppPath()
  ]
  
  debugDirs.forEach(dir => {
    if (fs.existsSync(dir)) {
      try {
        const contents = fs.readdirSync(dir)
        console.log(`Contents of ${dir}:`, contents)
      } catch (error) {
        console.log(`Cannot read ${dir}: ${error.message}`)
      }
    } else {
      console.log(`Directory doesn't exist: ${dir}`)
    }
  })
  
  return possiblePaths[0] // Return first path as fallback
}

// Enhanced async module loading with better error handling
async function loadModules() {
  const modules = {}
  
  try {
    console.log('Loading database module...')
    const dbPath = getResourcePath("database/setup")
    console.log('Database module path:', dbPath)
    const { setupDatabase } = require(dbPath)
    modules.setupDatabase = setupDatabase
    console.log('✓ Database module loaded')
  } catch (error) {
    console.error('✗ Failed to load database module:', error.message)
    console.error('Error stack:', error.stack)
    modules.setupDatabase = () => Promise.resolve()
  }

  try {
    console.log('Loading WebSocket module...')
    const wsPath = getResourcePath("services/websocket")
    console.log('WebSocket module path:', wsPath)
    const { startWebSocketServer } = require(wsPath)
    modules.startWebSocketServer = startWebSocketServer
    console.log('✓ WebSocket module loaded')
  } catch (error) {
    console.error('✗ Failed to load WebSocket module:', error.message)
    console.error('Error stack:', error.stack)
    modules.startWebSocketServer = () => {}
  }

  try {
    console.log('Loading WebExportServer module...')
    const webExportPath = getResourcePath("services/webExportServer")
    console.log('WebExportServer module path:', webExportPath)
    const { WebExportServer } = require(webExportPath)
    modules.WebExportServer = WebExportServer
    console.log('✓ WebExportServer module loaded')
  } catch (error) {
    console.error('✗ Failed to load WebExportServer module:', error.message)
    console.error('Error stack:', error.stack)
    modules.WebExportServer = class { 
      constructor() {}
      start() { return Promise.resolve() }
      stop() {}
    }
  }

  return modules
}

// Enhanced route loading with better error handling and path resolution
function loadRoutes() {
  const routes = {}
  
  const routeModules = [
    'employees', 'attendance', 'settings', 'export', 'attendance-sync'
  ]

  routeModules.forEach(moduleName => {
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
          getResourcePath(`src/api/routes/${moduleName}.js`)
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
      console.error('Error stack:', error.stack)
      routes[moduleName] = {}
    }
  })

  // Load profile services with improved path resolution
  try {
    console.log('Loading profile services...')
    const profilePath = getResourcePath("services/profileService")
    console.log('Profile service path:', profilePath)
    
    if (!fs.existsSync(profilePath)) {
      // Try alternative paths for profile service
      const altPaths = [
        getResourcePath("services/profileService.js"),
        getResourcePath("profileService"),
        getResourcePath("profileService.js"),
        getResourcePath("src/services/profileService"),
        getResourcePath("src/services/profileService.js")
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
    
    console.log('✓ Profile services loaded')
    
    if (isDev && routes.profileServices) {
      console.log('  Available functions in profileServices:', Object.keys(routes.profileServices))
    }
  } catch (error) {
    console.error('✗ Failed to load profile services:', error.message)
    console.error('Error stack:', error.stack)
    routes.profileServices = {}
  }

  return routes
}

function createMainWindow() {
  console.log('Creating main window...')
  
  const iconPath = getResourcePath("assets/icon.png")
  const preloadPath = getResourcePath("preload.js")
  console.log('Icon path:', iconPath)
  console.log('Preload path:', preloadPath)
  
  // Check if preload script exists
  if (!fs.existsSync(preloadPath)) {
    console.warn('⚠️ Preload script not found, trying alternative paths...')
    const altPreloadPaths = [
      path.join(__dirname, 'preload.js'),
      path.join(process.cwd(), 'preload.js'),
      path.join(app.getAppPath(), 'preload.js')
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
      console.error('❌ Preload script not found at any location!')
    }
  }
  
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,           // ✅ Secure
      contextIsolation: true,           // ✅ Secure  
      enableRemoteModule: false,        // ✅ Secure
      preload: fs.existsSync(preloadPath) ? preloadPath : undefined  // Only load if exists
    },
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    show: false,
  })

  const indexPath = getResourcePath("renderer/index.html")
  console.log('Loading index from:', indexPath)
  
  if (!fs.existsSync(indexPath)) {
    console.error('Index file not found, trying alternative paths...')
    const altIndexPaths = [
      getResourcePath("index.html"),
      getResourcePath("src/renderer/index.html"),
      path.join(__dirname, 'index.html'),
      path.join(__dirname, 'renderer', 'index.html'),
      path.join(__dirname, 'src', 'renderer', 'index.html')
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
      console.error('Index file not found, creating fallback')
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
    console.log('Main window ready, showing...')
    mainWindow.show()
    if (!isDev) {
      mainWindow.maximize()
    }
  })

  mainWindow.on("closed", () => {
    console.log('Main window closed')
    mainWindow = null
  })

  // Debug: Log load failures
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('Page failed to load:', errorCode, errorDescription, validatedURL)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Page finished loading')
  })

  // Open dev tools in development mode
  if (isDev) {
    mainWindow.webContents.openDevTools()
  }
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus()
    return
  }

  console.log('Creating settings window...')

  settingsWindow = new BrowserWindow({
    width: 600,
    height: 500,
    parent: mainWindow,
    modal: true,
    webPreferences: {
      nodeIntegration: false,          // ✅ Also make settings window secure
      contextIsolation: true,          // ✅ Secure
      preload: path.join(__dirname, 'preload.js')  // Use same preload script
    },
    show: false,
  })

  // Based on your structure: src/renderer/settings.html
  const settingsPath = getResourcePath("renderer/settings.html")
  console.log('Loading settings from:', settingsPath)
  
  if (!fs.existsSync(settingsPath)) {
    console.error('Settings file not found, trying alternative paths...')
    const altSettingsPaths = [
      path.join(__dirname, 'src', 'renderer', 'settings.html'), // Your actual structure
      path.join(__dirname, 'settings.html'),
      path.join(__dirname, 'renderer', 'settings.html')
    ]
    
    let foundSettings = null
    for (const altPath of altSettingsPaths) {
      console.log('Trying settings path:', altPath)
      if (fs.existsSync(altPath)) {
        foundSettings = altPath
        console.log(`Found settings.html at: ${altPath}`)
        break
      }
    }
    
    if (foundSettings) {
      settingsWindow.loadFile(foundSettings)
    } else {
      console.error('Settings file not found, creating fallback')
      const fallbackHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Settings</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            .error { color: red; margin: 20px 0; }
          </style>
        </head>
        <body>
          <h1>Settings</h1>
          <div class="error">Settings file not found at: ${settingsPath}</div>
          <button onclick="window.close()">Close</button>
        </body>
        </html>
      `
      settingsWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(fallbackHtml)}`)
    }
  } else {
    settingsWindow.loadFile(settingsPath)
  }

  settingsWindow.once("ready-to-show", () => {
    console.log('Settings window ready, showing...')
    settingsWindow.show()
  })

  settingsWindow.on("closed", () => {
    console.log('Settings window closed')
    settingsWindow = null
  })
}

app.whenReady().then(async () => {
  try {
    console.log('App ready event fired, initializing...')

    // Load modules dynamically
    console.log('Loading modules...')
    const modules = await loadModules()
    
    // Load routes
    console.log('Loading routes...')
    const routes = loadRoutes()

    // Initialize database
    console.log('Setting up database...')
    try {
      await modules.setupDatabase()
      console.log('✓ Database setup complete')
    } catch (error) {
      console.error('✗ Database setup failed:', error.message)
    }

    // Start WebSocket server
    console.log('Starting WebSocket server...')
    try {
      modules.startWebSocketServer()
      console.log('✓ WebSocket server started')
    } catch (error) {
      console.error('✗ WebSocket server failed:', error.message)
    }

    // Start Web Export Server
    console.log('Starting Web Export Server...')
    try {
      webExportServer = new modules.WebExportServer(3001)
      await webExportServer.start()
      console.log('✓ Web Export Server started on port 3001')
    } catch (error) {
      console.error('✗ Web Export Server failed:', error.message)
    }

    // Create main window
    createMainWindow()

    // Set up menu
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
                mainWindow.webContents.send('show-export-dialog')
              }
            },
          },
          {
            label: "Sync Attendance to Server",
            click: () => {
              if (mainWindow) {
                mainWindow.webContents.send('sync-attendance-to-server')
              }
            },
          },
          {
            label: "Web Export URL",
            click: () => {
              const { shell } = require('electron')
              shell.openExternal('http://localhost:3001/api/docs')
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
    ]

    const menu = Menu.buildFromTemplate(template)
    Menu.setApplicationMenu(menu)

    // Register IPC handlers
    registerIpcHandlers(routes)

    console.log('✓ App initialization complete')

  } catch (error) {
    console.error('✗ Error during app initialization:', error)
    
    // Still create window even if other parts fail
    console.log('Creating window despite initialization errors...')
    createMainWindow()
  }
})

app.on("window-all-closed", () => {
  console.log('All windows closed')
  
  // Stop web server when app is closing
  if (webExportServer) {
    try {
      webExportServer.stop()
      console.log('✓ Web export server stopped')
    } catch (error) {
      console.error('✗ Error stopping web export server:', error)
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

// Clean shutdown
app.on('before-quit', () => {
  console.log('App before quit')
  if (webExportServer) {
    try {
      webExportServer.stop()
    } catch (error) {
      console.error('Error during cleanup:', error)
    }
  }
})

// Error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})

// Helper function to safely register IPC handlers
function safelyRegisterHandler(channel, handler, moduleName, handlerName) {
  console.log(`Attempting to register handler: ${channel}`)
  console.log(`Handler type:`, typeof handler)
  
  if (typeof handler === 'function') {
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
  console.log('Registering IPC handlers...')
  console.log('Available route modules:', Object.keys(routes))

  // Basic handlers
  ipcMain.handle('get-asset-path', (event, filename) => {
    return getResourcePath(path.join('assets', filename))
  })

  ipcMain.handle('get-profile-path', (event, filename) => {
    return getResourcePath(path.join('profiles', filename))
  })

  ipcMain.handle("open-settings", () => createSettingsWindow())

  // Additional utility handlers for preload script
  ipcMain.handle('file-exists', (event, filePath) => {
    try {
      return fs.existsSync(filePath)
    } catch (error) {
      console.error('Error checking file existence:', error)
      return false
    }
  })

  ipcMain.handle('read-text-file', async (event, filePath) => {
    try {
      return fs.readFileSync(filePath, 'utf8')
    } catch (error) {
      console.error('Error reading file:', error)
      throw error
    }
  })

  ipcMain.handle('write-text-file', async (event, filePath, content) => {
    try {
      fs.writeFileSync(filePath, content, 'utf8')
      return true
    } catch (error) {
      console.error('Error writing file:', error)
      throw error
    }
  })

  // Employee route handlers
  const employeeRoutes = routes.employees || {}
  console.log('Employee routes available:', Object.keys(employeeRoutes))
  safelyRegisterHandler("get-employees", employeeRoutes.getEmployees, employeeRoutes, "getEmployees")
  safelyRegisterHandler("sync-employees", employeeRoutes.syncEmployees, employeeRoutes, "syncEmployees")

  // Attendance route handlers
  const attendanceRoutes = routes.attendance || {}
  console.log('Attendance routes available:', Object.keys(attendanceRoutes))
  safelyRegisterHandler("clock-attendance", attendanceRoutes.clockAttendance, attendanceRoutes, "clockAttendance")
  safelyRegisterHandler("get-today-attendance", attendanceRoutes.getTodayAttendance, attendanceRoutes, "getTodayAttendance")
  safelyRegisterHandler("get-employee-attendance", attendanceRoutes.getEmployeeAttendance, attendanceRoutes, "getEmployeeAttendance")
  safelyRegisterHandler("get-today-statistics", attendanceRoutes.getTodayStatistics, attendanceRoutes, "getTodayStatistics")

  // Settings route handlers
  const settingsRoutes = routes.settings || {}
  console.log('Settings routes available:', Object.keys(settingsRoutes))
  safelyRegisterHandler("get-settings", settingsRoutes.getSettings, settingsRoutes, "getSettings")
  safelyRegisterHandler("update-settings", settingsRoutes.updateSettings, settingsRoutes, "updateSettings")

  // Export route handlers
  const exportRoutes = routes.export || {}
  console.log('Export routes available:', Object.keys(exportRoutes))
  safelyRegisterHandler("export-attendance-data", exportRoutes.exportAttendanceData, exportRoutes, "exportAttendanceData")
  safelyRegisterHandler("get-export-formats", exportRoutes.getExportFormats, exportRoutes, "getExportFormats")
  safelyRegisterHandler("get-export-statistics", exportRoutes.getExportStatistics, exportRoutes, "getExportStatistics")

  // Attendance sync route handlers
  const attendanceSyncRoutes = routes['attendance-sync'] || {}
  console.log('Attendance sync routes available:', Object.keys(attendanceSyncRoutes))
  safelyRegisterHandler("sync-attendance-to-server", attendanceSyncRoutes.syncAttendanceToServer, attendanceSyncRoutes, "syncAttendanceToServer")
  safelyRegisterHandler("get-unsynced-attendance-count", attendanceSyncRoutes.getUnsyncedAttendanceCount, attendanceSyncRoutes, "getUnsyncedAttendanceCount")
  safelyRegisterHandler("get-all-attendance-for-sync", attendanceSyncRoutes.getAllAttendanceForSync, attendanceSyncRoutes, "getAllAttendanceForSync")
  safelyRegisterHandler("mark-attendance-as-synced", attendanceSyncRoutes.markAttendanceAsSynced, attendanceSyncRoutes, "markAttendanceAsSynced")

  // Profile service handlers
  const profileServices = routes.profileServices || {}
  console.log('Profile services available:', Object.keys(profileServices))
  safelyRegisterHandler("check-profile-images", profileServices.checkProfileImages, profileServices, "checkProfileImages")

  console.log('✓ IPC handlers registration complete')
}