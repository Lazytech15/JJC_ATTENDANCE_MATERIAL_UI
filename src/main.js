const { app, BrowserWindow, ipcMain, Menu } = require("electron")
const path = require("path")
const { setupDatabase } = require("./database/setup")
const { startWebSocketServer } = require("./services/websocket")
const { WebExportServer } = require("./services/webExportServer")
const employeeRoutes = require("./api/routes/employees")
const attendanceRoutes = require("./api/routes/attendance")
const settingsRoutes = require("./api/routes/settings")
const exportRoutes = require("./api/routes/export")



// In your main.js or main process file
app.commandLine.appendSwitch('--disable-gpu-sandbox');
app.commandLine.appendSwitch('--disable-software-rasterizer');
// Or completely disable GPU acceleration if needed
app.commandLine.appendSwitch('--disable-gpu');

let mainWindow
let settingsWindow
let webExportServer 

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
    },
    icon: path.join(__dirname, "../assets/icon.png"),
    show: false,
  })

  mainWindow.loadFile(path.join(__dirname, "renderer/index.html"))

  mainWindow.once("ready-to-show", () => {
    mainWindow.show()
    mainWindow.maximize()
  })

  mainWindow.on("closed", () => {
    mainWindow = null
  })
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
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    show: false,
  })

  settingsWindow.loadFile(path.join(__dirname, "renderer/settings.html"))

  settingsWindow.once("ready-to-show", () => {
    settingsWindow.show()
  })

  settingsWindow.on("closed", () => {
    settingsWindow = null
  })
}

app.whenReady().then(async () => {
  try {
    // Initialize database
    await setupDatabase()

    // Start WebSocket server
    startWebSocketServer()

    // Start Web Export Server
    webExportServer = new WebExportServer(3001) // You can change the port here
    await webExportServer.start()

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
              mainWindow.webContents.send('show-export-dialog')
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

  } catch (error) {
    console.error('Error during app initialization:', error)
  }
})

app.on("window-all-closed", () => {
  // Stop web server when app is closing
  if (webExportServer) {
    webExportServer.stop()
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
  if (webExportServer) {
    webExportServer.stop()
  }
})

// Expose to renderer
ipcMain.handle('get-asset-path', (event, filename) => {
  return path.join(app.getAppPath(), 'assets', filename)
})

ipcMain.handle('get-profile-path', (event, filename) => {
  return path.join(app.getAppPath(), 'profiles', filename)
})

// Helper function to safely register IPC handlers
function safelyRegisterHandler(channel, handler, moduleName, handlerName) {
  if (typeof handler === 'function') {
    ipcMain.handle(channel, handler)
    console.log(`✓ Registered handler: ${channel}`)
  } else {
    console.error(`✗ Handler ${handlerName} in ${moduleName} is undefined or not a function`)
    // Register a fallback handler that returns an error
    ipcMain.handle(channel, async () => {
      throw new Error(`Handler ${handlerName} is not implemented`)
    })
  }
}


// Debug: Log what's available in each module
console.log('Employee routes available:', Object.keys(employeeRoutes || {}))
console.log('Attendance routes available:', Object.keys(attendanceRoutes || {}))
console.log('Settings routes available:', Object.keys(settingsRoutes || {}))
console.log('Export routes available:', Object.keys(exportRoutes || {}))

// IPC handlers with error checking
safelyRegisterHandler("get-employees", employeeRoutes?.getEmployees, "employeeRoutes", "getEmployees")
safelyRegisterHandler("clock-attendance", attendanceRoutes?.clockAttendance, "attendanceRoutes", "clockAttendance")
safelyRegisterHandler("get-today-attendance", attendanceRoutes?.getTodayAttendance, "attendanceRoutes", "getTodayAttendance")
safelyRegisterHandler("get-employee-attendance", attendanceRoutes?.getEmployeeAttendance, "attendanceRoutes", "getEmployeeAttendance")
safelyRegisterHandler("sync-employees", employeeRoutes?.syncEmployees, "employeeRoutes", "syncEmployees")
safelyRegisterHandler("get-settings", settingsRoutes?.getSettings, "settingsRoutes", "getSettings")
safelyRegisterHandler("update-settings", settingsRoutes?.updateSettings, "settingsRoutes", "updateSettings")
safelyRegisterHandler("check-profile-images", employeeRoutes?.checkProfileImages, "employeeRoutes", "checkProfileImages")
safelyRegisterHandler("get-today-statistics", attendanceRoutes?.getTodayStatistics, "attendanceRoutes", "getTodayStatistics")

// Export route handlers
safelyRegisterHandler("export-attendance-data", exportRoutes?.exportAttendanceData, "exportRoutes", "exportAttendanceData")
safelyRegisterHandler("get-export-formats", exportRoutes?.getExportFormats, "exportRoutes", "getExportFormats")
safelyRegisterHandler("get-export-statistics", exportRoutes?.getExportStatistics, "exportRoutes", "getExportStatistics")

// This one is defined locally, so it should work fine
ipcMain.handle("open-settings", () => createSettingsWindow())