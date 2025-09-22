const { app, BrowserWindow, ipcMain, Menu, dialog } = require("electron")
const path = require("path")
const fs = require("fs")
const { autoUpdater } = require("electron-updater")

// Configure auto-updater
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true

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
        // User clicked "Download Now"
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
        // User clicked "Restart Now"
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
      path.join(__dirname, relativePath), // Direct from main directory
      path.join(__dirname, "src", relativePath), // From src/ subdirectory
      path.join(process.cwd(), relativePath), // From current working directory
      path.join(process.cwd(), "src", relativePath), // From src/ in working directory
      path.join(app.getAppPath(), relativePath), // From app path
      path.join(app.getAppPath(), "src", relativePath), // From src/ in app path
    )
  } else {
    // Production mode - try multiple fallback locations
    const resourcesPath = process.resourcesPath || path.dirname(process.execPath)
    possiblePaths.push(
      path.join(resourcesPath, "app", "src", relativePath), // Standard ASAR structure
      path.join(resourcesPath, "app", relativePath), // Alternative ASAR structure
      path.join(app.getAppPath(), "src", relativePath), // Unpacked app structure
      path.join(app.getAppPath(), relativePath), // Direct app structure
      path.join(resourcesPath, relativePath), // Direct resources structure
      path.join(__dirname, "src", relativePath), // Fallback to dirname
      path.join(__dirname, relativePath), // Last resort
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

  // Debug: Show what's actually in some key directories
  const debugDirs = [
    __dirname,
    path.join(__dirname, "src"),
    process.cwd(),
    path.join(process.cwd(), "src"),
    app.getAppPath(),
  ]

  debugDirs.forEach((dir) => {
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
    console.log("Loading database module...")
    const dbPath = getResourcePath("database/setup")
    console.log("Database module path:", dbPath)
    const { setupDatabase } = require(dbPath)
    modules.setupDatabase = setupDatabase
    console.log("✓ Database module loaded")
  } catch (error) {
    console.error("✗ Failed to load database module:", error.message)
    console.error("Error stack:", error.stack)
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
    console.error("Error stack:", error.stack)
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
    console.error("Error stack:", error.stack)
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

  const routeModules = ["employees", "attendance", "settings", "export", "attendance-sync", "getDailySummary", "attendancedb", "summary-sync"]

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

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

// Enhanced IPC handlers for updater
function registerUpdaterIpcHandlers() {
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

// Your existing app.whenReady() with enhancements
app.whenReady().then(async () => {
  try {
    console.log("App ready event fired, initializing...")

    // Load modules dynamically
    console.log("Loading modules...")
    const modules = await loadModules()

    // Load routes
    console.log("Loading routes...")
    const routes = loadRoutes()

    // Initialize database
    console.log("Setting up database...")
    try {
      await modules.setupDatabase()
      console.log("✓ Database setup complete")
    } catch (error) {
      console.error("✗ Database setup failed:", error.message)
    }

    // Start WebSocket server
    console.log("Starting WebSocket server...")
    try {
      modules.startWebSocketServer()
      console.log("✓ WebSocket server started")
    } catch (error) {
      console.error("✗ WebSocket server failed:", error.message)
    }

    // Start Web Export Server
    console.log("Starting Web Export Server...")
    try {
      webExportServer = new modules.WebExportServer(3001)
      await webExportServer.start()
      console.log("✓ Web Export Server started on port 3001")
    } catch (error) {
      console.error("✗ Web Export Server failed:", error.message)
    }

    // Create main window
    createMainWindow()

    // Set up enhanced menu
    createApplicationMenu()

    // Register IPC handlers (your existing ones)
    registerIpcHandlers(routes)
    
    // Register updater IPC handlers
    registerUpdaterIpcHandlers()

    console.log("✓ App initialization complete")
  } catch (error) {
    console.error("✗ Error during app initialization:", error)

    // Still create window even if other parts fail
    console.log("Creating window despite initialization errors...")
    createMainWindow()
  }
})

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

  // Basic handlers
  ipcMain.handle("get-asset-path", (event, filename) => {
    return getResourcePath(path.join("assets", filename))
  })

  ipcMain.handle("get-profile-path", (event, filename) => {
    return getResourcePath(path.join("profiles", filename))
  })

  ipcMain.handle("open-settings", () => createSettingsWindow())

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

  // Employee route handlers
  const employeeRoutes = routes.employees || {}
  console.log("Employee routes available:", Object.keys(employeeRoutes))
  safelyRegisterHandler("get-employees", employeeRoutes.getEmployees, employeeRoutes, "getEmployees")
  safelyRegisterHandler("sync-employees", employeeRoutes.syncEmployees, employeeRoutes, "syncEmployees")

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

  // Summary sync handlers (FIXED: using bracket notation for hyphenated property)
  const summarySync = routes["summary-sync"] || {}
  console.log("Summary sync routes available:", Object.keys(summarySync))
  safelyRegisterHandler("get-All-daily-summary-for-sync", summarySync.getAllDailySummaryForSync, summarySync, "getAllDailySummaryForSync")
  safelyRegisterHandler("sync-daily-summary-to-server", summarySync.syncDailySummaryToServer, summarySync, "syncDailySummaryToServer")
  safelyRegisterHandler("get-unsynced-daily-summary-count", summarySync.getUnsyncedDailySummaryCount, summarySync, "getUnsyncedDailySummaryCount")
  safelyRegisterHandler("force-sync-all-daily-summary", summarySync.forceSyncAllDailySummary, summarySync, "forceSyncAllDailySummary")
  safelyRegisterHandler("get-daily-summary-last-sync-time", summarySync.getDailySummaryLastSyncTime, summarySync, "getDailySummaryLastSyncTime")

  // NEW: Additional summary sync handlers for enhanced functionality
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

// Replace your existing profile services handler registration section with this COMPLETE version:

// Profile service handlers
const profileServices = routes.profileServices || {}
console.log("Profile services available:", Object.keys(profileServices))

// FIXED: Properly wrap the checkProfileImages handler to avoid passing event object
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