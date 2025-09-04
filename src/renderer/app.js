const { ipcRenderer } = require("electron")

class AttendanceApp {
  constructor() {
    this.ws = null
    this.employeeDisplayTimeout = null
    this.imageLoadAttempts = new Map() // Track image load attempts
    this.imageCounter = 0 // Counter for unique IDs
    this.barcodeTimeout = null // Add timeout for barcode handling
    this.autoSyncInterval = null // Auto-sync interval
    this.syncSettings = {
      enabled: true,
      interval: 5 * 60 * 1000, // Default 5 minutes
      retryAttempts: 3,
      retryDelay: 30000 // 30 seconds
    }
    this.init()
  }

  async init() {
    this.setupEventListeners()
    this.startClock()
    this.connectWebSocket()
    await this.loadInitialData()
    await this.loadSyncSettings() // Load sync settings from database
    this.startAutoSync() // Start automatic sync
    this.focusInput()
  }

  // Load sync settings from the database
  async loadSyncSettings() {
    if (!ipcRenderer) return

    try {
      const result = await ipcRenderer.invoke('get-settings')
      if (result.success && result.data) {
        // Update sync interval from settings
        const syncInterval = parseInt(result.data.sync_interval) || (5 * 60 * 1000)
        this.syncSettings.interval = syncInterval
        console.log('Loaded sync settings - interval:', syncInterval, 'ms')
      }
    } catch (error) {
      console.error('Error loading sync settings:', error)
    }
  }

  // Start automatic attendance sync
  startAutoSync() {
    if (this.autoSyncInterval) {
      clearInterval(this.autoSyncInterval)
    }

    if (!this.syncSettings.enabled) return

    console.log('Starting auto-sync with interval:', this.syncSettings.interval, 'ms')
    
    this.autoSyncInterval = setInterval(() => {
      this.performAttendanceSync(true) // Silent sync
    }, this.syncSettings.interval)

    // Also perform an initial sync after 10 seconds
    setTimeout(() => {
      this.performAttendanceSync(true)
    }, 10000)
  }

  // Stop automatic sync
  stopAutoSync() {
    if (this.autoSyncInterval) {
      clearInterval(this.autoSyncInterval)
      this.autoSyncInterval = null
      console.log('Auto-sync stopped')
    }
  }

  // Perform attendance sync with retry logic
  async performAttendanceSync(silent = false, retryCount = 0) {
    if (!ipcRenderer) {
      if (!silent) {
        this.showStatus('Demo mode: Sync simulated successfully!', 'success')
      }
      return { success: true, message: 'Demo sync' }
    }

    try {
      // First check if there are records to sync
      const countResult = await ipcRenderer.invoke('get-unsynced-attendance-count')
      
      if (!countResult.success || countResult.count === 0) {
        if (!silent) {
          this.showStatus('No attendance records to sync', 'info')
        }
        return { success: true, message: 'No records to sync' }
      }

      if (!silent) {
        this.showStatus(`Syncing ${countResult.count} attendance records...`, 'info')
      }

      // Perform the sync
      const syncResult = await ipcRenderer.invoke('sync-attendance-to-server')
      
      if (syncResult.success) {
        if (!silent) {
          this.showStatus(syncResult.message, 'success')
        }
        console.log('Attendance sync successful:', syncResult.message)
        
        // Update sync info display if settings modal is open
        if (document.getElementById('settingsModal').classList.contains('show')) {
          await this.loadSyncInfo()
        }
        
        return syncResult
      } else {
        throw new Error(syncResult.message)
      }
      
    } catch (error) {
      console.error('Attendance sync error:', error)
      
      // Retry logic
      if (retryCount < this.syncSettings.retryAttempts) {
        console.log(`Retrying sync in ${this.syncSettings.retryDelay / 1000} seconds... (attempt ${retryCount + 1}/${this.syncSettings.retryAttempts})`)
        
        setTimeout(() => {
          this.performAttendanceSync(silent, retryCount + 1)
        }, this.syncSettings.retryDelay)
        
        if (!silent) {
          this.showStatus(`Sync failed, retrying... (${retryCount + 1}/${this.syncSettings.retryAttempts})`, 'warning')
        }
      } else {
        if (!silent) {
          this.showStatus(`Sync failed after ${this.syncSettings.retryAttempts} attempts: ${error.message}`, 'error')
        }
        return { success: false, message: error.message }
      }
    }
  }

  // Enhanced save and sync functionality
  async saveAndSync() {
    const syncNowBtn = document.getElementById('syncNowBtn')
    const originalText = syncNowBtn.textContent
    
    // Show loading state
    syncNowBtn.textContent = '💾 Saving & Syncing...'
    syncNowBtn.disabled = true
    
    if (!ipcRenderer) {
      this.showSettingsStatus('Demo mode: Settings saved and sync completed successfully!', 'success')
      await this.loadSyncInfo()
      syncNowBtn.textContent = originalText
      syncNowBtn.disabled = false
      return
    }

    try {
      // First, save the settings
      const settingsForm = document.getElementById('settingsForm')
      if (!settingsForm) {
        throw new Error('Settings form not found')
      }

      const formData = new FormData(settingsForm)
      
      // Get server URL with proper null checking
      const serverUrlInput = formData.get('serverUrl') || document.getElementById('serverUrl')?.value
      if (!serverUrlInput) {
        this.showSettingsStatus('Server URL is required', 'error')
        return
      }

      // Clean the base URL and ensure it doesn't already have the API endpoint
      let baseUrl = serverUrlInput.toString().trim().replace(/\/$/, '') // Remove trailing slash
      if (baseUrl.endsWith('/api/tables/emp_list/data')) {
        baseUrl = baseUrl.replace('/api/tables/emp_list/data', '')
      }
      
      const fullServerUrl = `${baseUrl}/api/tables/emp_list/data`
      
      // Get other form values with fallbacks
      const syncIntervalInput = formData.get('syncInterval') || document.getElementById('syncInterval')?.value || '5'
      const gracePeriodInput = formData.get('gracePeriod') || document.getElementById('gracePeriod')?.value || '5'
      
      const settings = {
        server_url: fullServerUrl,
        sync_interval: (parseInt(syncIntervalInput) * 60000).toString(),
        grace_period: gracePeriodInput
      }

      console.log('Saving settings:', settings) // Debug log

      const saveResult = await ipcRenderer.invoke('update-settings', settings)
      
      if (!saveResult.success) {
        this.showSettingsStatus(saveResult.error || 'Error saving settings', 'error')
        return
      }

      // Update local sync settings
      this.syncSettings.interval = parseInt(settings.sync_interval)
      
      // Restart auto-sync with new interval
      this.startAutoSync()

      // Update button text to show employee sync phase
      syncNowBtn.textContent = '🔄 Syncing Employees...'

      // Then sync the employees
      const employeeSyncResult = await ipcRenderer.invoke('sync-employees')
      
      if (!employeeSyncResult.success) {
        this.showSettingsStatus(`Settings saved, but employee sync failed: ${employeeSyncResult.error}`, 'warning')
        return
      }

      // Update button text to show attendance sync phase
      syncNowBtn.textContent = '📊 Syncing Attendance...'

      // Finally sync attendance
      const attendanceSyncResult = await this.performAttendanceSync(false)
      
      if (attendanceSyncResult && attendanceSyncResult.success) {
        this.showSettingsStatus('Settings saved and all data synced successfully!', 'success')
        await this.loadSyncInfo()
        // Also refresh the main attendance data
        await this.loadTodayAttendance()
      } else {
        this.showSettingsStatus('Settings saved, employees synced, but attendance sync had issues', 'warning')
      }
      
    } catch (error) {
      console.error('Save and sync error:', error)
      this.showSettingsStatus(`Error occurred during save and sync: ${error.message}`, 'error')
    } finally {
      syncNowBtn.textContent = originalText
      syncNowBtn.disabled = false
    }
  }

  setupEventListeners() {
    // Barcode input
    const barcodeInput = document.getElementById("barcodeInput")
    const manualSubmit = document.getElementById("manualSubmit")
    const settingsBtn = document.getElementById("settingsBtn")
    const closeSettings = document.getElementById("closeSettings")
    const cancelSettings = document.getElementById("cancelSettings")
    const settingsModal = document.getElementById("settingsModal")
    const settingsForm = document.getElementById("settingsForm")
    const syncNowBtn = document.getElementById("syncNowBtn")

    barcodeInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        e.preventDefault() // Prevent form submission
        this.handleScan()
      }
    })

    barcodeInput.addEventListener("input", (e) => {
      const inputType = document.querySelector('input[name="inputType"]:checked').value
      
      // Clear any existing timeout
      if (this.barcodeTimeout) {
        clearTimeout(this.barcodeTimeout)
      }

      if (inputType === "barcode") {
        // For barcode scanners, wait for a brief pause after input stops
        // This ensures the complete barcode is captured before auto-submitting
        this.barcodeTimeout = setTimeout(() => {
          const currentValue = e.target.value.trim()
          if (currentValue.length >= 8) { // Minimum barcode length
            this.handleScan()
          }
        }, 150) // Wait 150ms after last input
      }
    })

    // Handle paste events (some barcode scanners simulate paste)
    barcodeInput.addEventListener("paste", (e) => {
      const inputType = document.querySelector('input[name="inputType"]:checked').value
      
      if (inputType === "barcode") {
        setTimeout(() => {
          const pastedValue = e.target.value.trim()
          if (pastedValue.length >= 8) {
            this.handleScan()
          }
        }, 50)
      }
    })

    manualSubmit.addEventListener("click", () => {
      this.handleScan()
    })

    // Settings event listeners
    settingsBtn.addEventListener("click", () => {
      this.openSettings()
    })

    closeSettings.addEventListener("click", () => {
      this.closeSettings()
    })

    cancelSettings.addEventListener("click", () => {
      this.closeSettings()
    })

    settingsModal.addEventListener("click", (e) => {
      if (e.target === settingsModal) {
        this.closeSettings()
      }
    })

    // Settings form submission - now calls saveAndSync
    settingsForm.addEventListener("submit", (e) => {
      e.preventDefault()
      this.saveAndSync()
    })

    // Sync now button - now calls saveAndSync
    syncNowBtn.addEventListener("click", () => {
      this.saveAndSync()
    })

    // Add manual attendance sync button functionality
    const syncAttendanceBtn = document.getElementById('syncAttendanceBtn')
    if (syncAttendanceBtn) {
      syncAttendanceBtn.addEventListener("click", () => {
        this.performAttendanceSync(false) // Not silent
      })
    }

    // Keep input focused but allow interaction with employee display
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".employee-display") && !e.target.closest("button") && !e.target.closest("input")) {
        this.focusInput()
      }
    })

    // Handle input type changes
    const inputTypeRadios = document.querySelectorAll('input[name="inputType"]')
    inputTypeRadios.forEach(radio => {
      radio.addEventListener("change", () => {
        this.focusInput()
        // Clear any pending timeouts when switching input types
        if (this.barcodeTimeout) {
          clearTimeout(this.barcodeTimeout)
        }
      })
    })

    // Listen for IPC events from main process
    if (ipcRenderer) {
      ipcRenderer.on('sync-attendance-to-server', () => {
        this.performAttendanceSync(false)
      })
    }
  }

  // Settings functionality
  openSettings() {
    const modal = document.getElementById("settingsModal")
    modal.classList.add("show")
    this.loadSettings()
    this.loadSyncInfo()
    this.loadAttendanceSyncInfo() // Load attendance sync info
  }

  closeSettings() {
    const modal = document.getElementById("settingsModal")
    modal.classList.remove("show")
    // Clear any status messages
    const statusElement = document.getElementById('settingsStatusMessage')
    statusElement.style.display = 'none'
  }

  async loadSettings() {
    if (!ipcRenderer) {
      // Demo values
      document.getElementById('serverUrl').value = 'URL'
      document.getElementById('syncInterval').value = '5'
      document.getElementById('gracePeriod').value = '5'
      return
    }

    try {
      const result = await ipcRenderer.invoke('get-settings')
      
      if (result.success) {
        const settings = result.data
        
        document.getElementById('serverUrl').value = settings.server_url || ''
        document.getElementById('syncInterval').value = Math.floor((settings.sync_interval || 300000) / 60000)
        document.getElementById('gracePeriod').value = settings.grace_period || 5
      }
    } catch (error) {
      console.error('Error loading settings:', error)
      this.showSettingsStatus('Error loading settings', 'error')
    }
  }

  async loadSyncInfo() {
    if (!ipcRenderer) {
      document.getElementById('employeeCount').textContent = 'Employees in database: 25 (Demo)'
      document.getElementById('lastSync').textContent = 'Last sync: Just now (Demo)'
      document.getElementById('profileStatus').textContent = 'Profile images: 20/25 downloaded (Demo)'
      document.getElementById('syncInfo').style.display = 'block'
      return
    }

    try {
      const employeesResult = await ipcRenderer.invoke('get-employees')
      
      if (employeesResult.success) {
        document.getElementById('employeeCount').textContent = 
          `Employees in database: ${employeesResult.data.length}`
        
        const settingsResult = await ipcRenderer.invoke('get-settings')
        if (settingsResult.success && settingsResult.data.last_sync) {
          const lastSync = new Date(parseInt(settingsResult.data.last_sync))
          document.getElementById('lastSync').textContent = 
            `Last sync: ${lastSync.toLocaleString()}`
        } else {
          document.getElementById('lastSync').textContent = 'Last sync: Never'
        }
        
        const profileResult = await ipcRenderer.invoke('check-profile-images')
        if (profileResult.success) {
          document.getElementById('profileStatus').textContent = 
            `Profile images: ${profileResult.downloaded}/${profileResult.total} downloaded`
        }
        
        document.getElementById('syncInfo').style.display = 'block'
      }
    } catch (error) {
      console.error('Error loading sync info:', error)
    }
  }

  // Load attendance sync information
  async loadAttendanceSyncInfo() {
    if (!ipcRenderer) {
      // Demo values
      const attendanceSyncInfo = document.getElementById('attendanceSyncInfo')
      if (attendanceSyncInfo) {
        attendanceSyncInfo.innerHTML = `
          <div class="sync-info-item">
            <strong>Unsynced Records:</strong> 3 (Demo)
          </div>
          <div class="sync-info-item">
            <strong>Auto-sync:</strong> Enabled - Every 5 minutes
          </div>
          <div class="sync-info-item">
            <strong>Last Attendance Sync:</strong> 2 minutes ago (Demo)
          </div>
        `
      }
      return
    }

    try {
      const unsyncedResult = await ipcRenderer.invoke('get-unsynced-attendance-count')
      const attendanceSyncInfo = document.getElementById('attendanceSyncInfo')
      
      if (attendanceSyncInfo && unsyncedResult.success) {
        const syncIntervalMinutes = Math.floor(this.syncSettings.interval / 60000)
        const syncStatus = this.syncSettings.enabled ? `Enabled - Every ${syncIntervalMinutes} minutes` : 'Disabled'
        
        attendanceSyncInfo.innerHTML = `
          <div class="sync-info-item">
            <strong>Unsynced Records:</strong> ${unsyncedResult.count}
          </div>
          <div class="sync-info-item">
            <strong>Auto-sync:</strong> ${syncStatus}
          </div>
          <div class="sync-info-item">
            <strong>Next sync:</strong> <span id="nextSyncTime">Calculating...</span>
          </div>
        `
        
        // Update next sync time if auto-sync is enabled
        if (this.syncSettings.enabled && this.autoSyncInterval) {
          this.updateNextSyncTime()
        }
      }
    } catch (error) {
      console.error('Error loading attendance sync info:', error)
    }
  }

  // Update next sync countdown
  updateNextSyncTime() {
    // This is a simplified version - in a real app you might want to track the exact next sync time
    const nextSyncElement = document.getElementById('nextSyncTime')
    if (nextSyncElement) {
      const minutes = Math.floor(this.syncSettings.interval / 60000)
      nextSyncElement.textContent = `~${minutes} minutes`
    }
  }

  showSettingsStatus(message, type = 'info') {
    const statusElement = document.getElementById('settingsStatusMessage')
    statusElement.textContent = message
    statusElement.className = `status-message ${type}`
    statusElement.style.display = 'block'
    statusElement.style.position = 'relative'
    statusElement.style.top = 'auto'
    statusElement.style.right = 'auto'
    statusElement.style.transform = 'none'
    statusElement.style.marginBottom = '16px'
    statusElement.style.borderRadius = '8px'
    
    setTimeout(() => {
      statusElement.style.display = 'none'
    }, 4000)
  }

  focusInput() {
    const barcodeInput = document.getElementById("barcodeInput")
    setTimeout(() => {
      barcodeInput.focus()
      barcodeInput.select() // Select all text for easy replacement
    }, 100)
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
        // Trigger sync after attendance update
        setTimeout(() => {
          this.performAttendanceSync(true) // Silent sync
        }, 2000)
        break
      default:
        console.log("Unknown WebSocket message:", message)
    }
  }

  async handleScan() {
    // Clear any pending timeouts
    if (this.barcodeTimeout) {
      clearTimeout(this.barcodeTimeout)
    }

    const input = document.getElementById("barcodeInput").value.trim()
    const inputType = document.querySelector('input[name="inputType"]:checked').value

    if (!input) {
      this.showStatus("Please enter a barcode or ID number", "error")
      this.focusInput()
      return
    }

    // Show processing state
    const submitButton = document.getElementById("manualSubmit")
    const originalText = submitButton.textContent
    submitButton.textContent = "Processing..."
    submitButton.disabled = true

    try {
      const result = await ipcRenderer.invoke("clock-attendance", {
        input: input,
        inputType: inputType,
      })

      if (result.success) {
        this.showEmployeeDisplay(result.data)
        this.clearInput()
        await this.loadTodayAttendance()
        this.showStatus("Attendance recorded successfully", "success")
        
        // Trigger automatic sync after successful attendance recording
        setTimeout(() => {
          this.performAttendanceSync(true) // Silent sync
        }, 3000)
        
      } else {
        this.showStatus(result.error || "Employee not found", "error")
        this.focusInput()
      }
    } catch (error) {
      console.error("Clock error:", error)
      this.showStatus("System error occurred", "error")
      this.focusInput()
    } finally {
      // Restore submit button
      submitButton.textContent = originalText
      submitButton.disabled = false
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
    setTimeout(() => this.focusInput(), 100)
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

  // Clean up when app is being destroyed
  destroy() {
    this.stopAutoSync()
    
    if (this.employeeDisplayTimeout) {
      clearTimeout(this.employeeDisplayTimeout)
    }
    
    if (this.barcodeTimeout) {
      clearTimeout(this.barcodeTimeout)
    }
    
    if (this.ws) {
      this.ws.close()
    }
    
    // Clean up image load attempts
    this.imageLoadAttempts.clear()
    
    console.log('AttendanceApp destroyed and cleaned up')
  }
}

// Initialize app when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  // Store reference globally for cleanup if needed
  window.attendanceApp = new AttendanceApp()
})

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  if (window.attendanceApp && typeof window.attendanceApp.destroy === 'function') {
    window.attendanceApp.destroy()
  }
})