const { ipcRenderer } = require("electron")

class AttendanceApp {
  constructor() {
    this.ws = null
    this.employeeDisplayTimeout = null
    this.imageLoadAttempts = new Map() // Track image load attempts
    this.imageCounter = 0 // Counter for unique IDs
    this.init()
  }

  async init() {
    this.setupEventListeners()
    this.startClock()
    this.connectWebSocket()
    await this.loadInitialData()
    this.focusInput()
  }

  setupEventListeners() {
    // Barcode input
    const barcodeInput = document.getElementById("barcodeInput")
    const manualSubmit = document.getElementById("manualSubmit")
    const settingsBtn = document.getElementById("settingsBtn")

    barcodeInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        this.handleScan()
      }
    })

    barcodeInput.addEventListener("input", (e) => {
      // Auto-submit for barcode scanner (typically ends with Enter)
      const inputType = document.querySelector('input[name="inputType"]:checked').value
      if (inputType === "barcode" && e.target.value.length >= 8) {
        // Small delay to ensure complete barcode is captured
        setTimeout(() => {
          if (e.target.value === barcodeInput.value) {
            this.handleScan()
          }
        }, 100)
      }
    })

    manualSubmit.addEventListener("click", () => {
      this.handleScan()
    })

    settingsBtn.addEventListener("click", () => {
      ipcRenderer.invoke("open-settings")
    })

    // Keep input focused
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".employee-display")) {
        this.focusInput()
      }
    })
  }

  focusInput() {
    const barcodeInput = document.getElementById("barcodeInput")
    setTimeout(() => barcodeInput.focus(), 100)
  }

  // Generate unique ID for images
  generateUniqueId(prefix) {
    return `${prefix}-${++this.imageCounter}-${Date.now()}`
  }

  startClock() {
    const updateClock = () => {
      const now = new Date()
      const options = {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }
      document.getElementById("datetime").textContent = now.toLocaleDateString("en-US", options)
    }

    updateClock()
    setInterval(updateClock, 1000)
  }

  connectWebSocket() {
    try {
      this.ws = new WebSocket("ws://localhost:8080")

      this.ws.onopen = () => {
        console.log("WebSocket connected")
        this.updateConnectionStatus(true)
      }

      this.ws.onmessage = (event) => {
        const message = JSON.parse(event.data)
        this.handleWebSocketMessage(message)
      }

      this.ws.onclose = () => {
        console.log("WebSocket disconnected")
        this.updateConnectionStatus(false)
        // Reconnect after 5 seconds
        setTimeout(() => this.connectWebSocket(), 5000)
      }

      this.ws.onerror = (error) => {
        console.error("WebSocket error:", error)
        this.updateConnectionStatus(false)
      }
    } catch (error) {
      console.error("Failed to connect WebSocket:", error)
      this.updateConnectionStatus(false)
    }
  }

  updateConnectionStatus(isOnline) {
    const statusElement = document.getElementById("connectionStatus")
    const dot = statusElement.querySelector(".status-dot")
    const text = statusElement.querySelector("span:last-child")

    if (isOnline) {
      dot.classList.add("online")
      text.textContent = "Online"
    } else {
      dot.classList.remove("online")
      text.textContent = "Offline"
    }
  }

  handleWebSocketMessage(message) {
    switch (message.type) {
      case "attendance_update":
        this.loadTodayAttendance()
        break
      default:
        console.log("Unknown WebSocket message:", message)
    }
  }

  async handleScan() {
    const input = document.getElementById("barcodeInput").value.trim()
    const inputType = document.querySelector('input[name="inputType"]:checked').value

    if (!input) {
      this.showStatus("Please enter a barcode or ID number", "error")
      return
    }

    try {
      const result = await ipcRenderer.invoke("clock-attendance", {
        input: input,
        inputType: inputType,
      })

      if (result.success) {
        this.showEmployeeDisplay(result.data)
        this.clearInput()
        await this.loadTodayAttendance()
      } else {
        this.showStatus(result.error || "Employee not found", "error")
      }
    } catch (error) {
      console.error("Clock error:", error)
      this.showStatus("System error occurred", "error")
    }
  }

  // Improved image loading with proper fallback handling and cleanup
  setupImageWithFallback(imgElement, employee_uid, altText) {
    if (!imgElement || !employee_uid) return

    // Clear any existing error handlers
    imgElement.onerror = null
    imgElement.onload = null

    const attemptKey = `${employee_uid}_${imgElement.id}`
    
    // Clean up previous attempts for this element
    this.imageLoadAttempts.delete(attemptKey)
    this.imageLoadAttempts.set(attemptKey, 0)

    const fallbackChain = [
      `profiles/${employee_uid}.jpg`,
      `profiles/${employee_uid}.png`,
      'assets/profile.png',
      this.getDefaultImageDataURL() // Base64 fallback
    ]

    const tryNextImage = () => {
      const attempts = this.imageLoadAttempts.get(attemptKey) || 0
      
      if (attempts >= fallbackChain.length) {
        // All fallbacks failed, use default
        imgElement.src = this.getDefaultImageDataURL()
        imgElement.onerror = null
        imgElement.onload = null
        this.imageLoadAttempts.delete(attemptKey)
        return
      }

      // Set up error handler for this attempt
      imgElement.onerror = () => {
        this.imageLoadAttempts.set(attemptKey, attempts + 1)
        tryNextImage()
      }

      // Set up success handler to clean up
      imgElement.onload = () => {
        this.imageLoadAttempts.delete(attemptKey)
        imgElement.onerror = null
        imgElement.onload = null
      }

      // Set the image source
      imgElement.src = fallbackChain[attempts]
    }

    imgElement.alt = altText || 'Profile Image'
    tryNextImage()
  }

  // Generate a simple default profile image as data URL
  getDefaultImageDataURL() {
    return 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgZmlsbD0iI2Y0ZjRmNCIgcng9IjUwIi8+PGNpcmNsZSBjeD0iNTAiIGN5PSIzNSIgcj0iMTUiIGZpbGw9IiNjY2MiLz48cGF0aCBkPSJNMjAgNzVhMzAgMzAgMCAwIDEgNjAgMCIgZmlsbD0iI2NjYyIvPjwvc3ZnPg=='
  }

  showEmployeeDisplay(data) {
    const display = document.getElementById("employeeDisplay")
    const { employee, clockType, clockTime, regularHours, overtimeHours } = data

    // Update employee info
    document.getElementById("employeeName").textContent =
      `${employee.first_name} ${employee.middle_name || ""} ${employee.last_name}`.trim()
    document.getElementById("employeeDepartment").textContent = employee.department || "No Department"
    document.getElementById("employeeId").textContent = `ID: ${employee.id_number}`

    const photo = document.getElementById("employeePhoto")
    photo.style.display = "block"
    
    // Use the improved image loading method
    this.setupImageWithFallback(photo, employee.uid, `${employee.first_name} ${employee.last_name}`)

    // Update clock info
    const clockTypeElement = document.getElementById("clockType")
    clockTypeElement.textContent = this.formatClockType(clockType)
    clockTypeElement.className = `clock-type ${clockType.replace("_", "-")}`

    document.getElementById("clockTime").textContent = new Date(clockTime).toLocaleTimeString()

    document.getElementById("hoursInfo").textContent = `Regular: ${regularHours}h | Overtime: ${overtimeHours}h`

    // Show display
    display.style.display = "block"

    // Auto-hide after 15 seconds
    if (this.employeeDisplayTimeout) {
      clearTimeout(this.employeeDisplayTimeout)
    }

    this.employeeDisplayTimeout = setTimeout(() => {
      display.style.display = "none"
      this.focusInput()
    }, 15000)
  }

  formatClockType(clockType) {
    const types = {
      morning_in: "🟢 Morning In",
      morning_out: "🔴 Morning Out",
      afternoon_in: "🟢 Afternoon In",
      afternoon_out: "🔴 Afternoon Out",
    }
    return types[clockType] || clockType
  }

  clearInput() {
    document.getElementById("barcodeInput").value = ""
    this.focusInput()
  }

  async loadInitialData() {
    await Promise.all([this.loadTodayAttendance(), this.syncEmployees()])
  }

  async loadTodayAttendance() {
    try {
      const result = await ipcRenderer.invoke("get-today-attendance")

      if (result.success) {
        this.updateCurrentlyClocked(result.data.currentlyClocked)
        this.updateTodayActivity(result.data.attendance)
        this.updateStatistics(result.data.statistics)
      }
    } catch (error) {
      console.error("Error loading attendance:", error)
    }
  }

  updateStatistics(stats) {
    if (!stats) return

    document.getElementById("totalRegularHours").textContent = stats.totalRegularHours || 0
    document.getElementById("totalOvertimeHours").textContent = stats.totalOvertimeHours || 0
    document.getElementById("presentCount").textContent = stats.presentCount || 0
    document.getElementById("lateCount").textContent = stats.lateCount || 0
    document.getElementById("absentCount").textContent = stats.absentCount || 0
  }

  updateCurrentlyClocked(employees) {
    const container = document.getElementById("currentlyClocked")

    if (!employees || employees.length === 0) {
      container.innerHTML = '<div class="loading">No employees currently clocked in</div>'
      return
    }

    const imageIds = []

    container.innerHTML = employees
      .map((emp) => {
        const empId = this.generateUniqueId(`clocked-${emp.employee_uid}`)
        imageIds.push({ id: empId, uid: emp.employee_uid, name: `${emp.first_name} ${emp.last_name}` })
        
        return `
            <div class="employee-item">
                <img class="employee-avatar" 
                     id="${empId}"
                     alt="${emp.first_name} ${emp.last_name}">
                <div class="employee-details">
                    <div class="employee-name">${emp.first_name} ${emp.last_name}</div>
                    <div class="employee-dept">${emp.department || "No Department"}</div>
                </div>
                <div class="clock-badge in">Clocked In</div>
            </div>
        `
      })
      .join("")

    // Setup images after HTML is inserted with a small delay to ensure DOM is ready
    setTimeout(() => {
      imageIds.forEach(({ id, uid, name }) => {
        const imgElement = document.getElementById(id)
        if (imgElement) {
          this.setupImageWithFallback(imgElement, uid, name)
        }
      })
    }, 10)
  }

  updateTodayActivity(attendance) {
    const container = document.getElementById("todayActivity")

    if (!attendance || attendance.length === 0) {
      container.innerHTML = '<div class="loading">No activity today</div>'
      return
    }

    const attendanceSlice = attendance.slice(0, 10)
    const imageIds = []
    
    container.innerHTML = attendanceSlice
      .map((record, index) => {
        const recordId = this.generateUniqueId(`activity-${record.employee_uid}-${index}`)
        imageIds.push({ 
          id: recordId, 
          uid: record.employee_uid, 
          name: `${record.first_name} ${record.last_name}` 
        })
        
        return `
            <div class="attendance-item">
                <img class="attendance-avatar" 
                     id="${recordId}"
                     alt="${record.first_name} ${record.last_name}">
                <div class="attendance-details">
                    <div class="attendance-name">${record.first_name} ${record.last_name}</div>
                    <div class="attendance-time">${new Date(record.clock_time).toLocaleTimeString()}</div>
                </div>
                <div class="clock-badge ${record.clock_type.includes("in") ? "in" : "out"}">
                    ${this.formatClockType(record.clock_type)}
                </div>
            </div>
        `
      })
      .join("")

    // Setup images after HTML is inserted with a small delay to ensure DOM is ready
    setTimeout(() => {
      imageIds.forEach(({ id, uid, name }) => {
        const imgElement = document.getElementById(id)
        if (imgElement) {
          this.setupImageWithFallback(imgElement, uid, name)
        }
      })
    }, 10)
  }

  async syncEmployees() {
    try {
      const result = await ipcRenderer.invoke("sync-employees")

      if (result.success) {
        this.showStatus(result.message, "success")
      } else {
        console.warn("Sync warning:", result.error)
      }
    } catch (error) {
      console.error("Sync error:", error)
    }
  }

  showStatus(message, type = "info") {
    const statusElement = document.getElementById("statusMessage")
    statusElement.textContent = message
    statusElement.className = `status-message ${type} show`

    setTimeout(() => {
      statusElement.classList.remove("show")
    }, 4000)
  }
}

// Initialize app when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  new AttendanceApp()
})