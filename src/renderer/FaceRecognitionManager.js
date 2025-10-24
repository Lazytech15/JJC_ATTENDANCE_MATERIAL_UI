// FaceRecognitionManager.js - WITH INTEGRATED EMPLOYEE DISPLAY
class FaceRecognitionManager {
  constructor(attendanceApp) {
    this.attendanceApp = attendanceApp;
    this.electronAPI = window.electronAPI;

    // Face-api.js configuration
    this.modelsLoaded = false;
    this.modelPath = 'models';

    // Face recognition state
    this.isActive = false;
    this.videoStream = null;
    this.videoElement = null;
    this.canvasElement = null;
    this.animationFrameId = null;

    // Detection settings
    this.detectionIntervalMs = 300;
    this.fastModeIntervalMs = 150;
    this.slowModeIntervalMs = 500;
    this.lastDetectionTime = 0;
    this.confidenceThreshold = 0.45;
    this.matchThreshold = 0.65;
    this.faceDescriptors = new Map();

    // Recognition state with cooldown
    this.lastRecognizedUID = null;
    this.lastRecognitionTime = 0;
    this.recognitionCooldown = 5000;

    // Employee-specific cooldown tracking
    this.employeeCooldowns = new Map();
    this.employeeCooldownDuration = 60 * 60 * 1000; // 1 hour for camera

    this.barcodeCooldowns = new Map();
    this.barcodeCooldownDuration = 2000; // 2 seconds for barcode

    // Adaptive detection speed
    this.consecutiveNoFaceFrames = 0;
    this.consecutiveFaceFrames = 0;
    this.currentMode = 'normal';

    this.lastFacePosition = null;
    this.faceMovementThreshold = 30;

    // DOM elements
    this.container = null;
    this.statusElement = null;

    // Lazy loading flags
    this.initializationStarted = false;
    this.descriptorsLoaded = false;

    // Debounce and batch updates
    this.statusDebounceTimeout = null;
    this.pendingStatusUpdate = null;

    // Reuse detection options
    this.detectionOptions = new faceapi.TinyFaceDetectorOptions({
      inputSize: 160,
      scoreThreshold: 0.4
    });

    // Cache face matcher
    this.cachedFaceMatcher = null;
    this.faceMatcherDirty = true;

    this.scanLog = [];
    this.maxLogEntries = 100;

    // Processing lock
    this.isProcessingAttendance = false;
    this.lastProcessedInput = null;
    this.lastProcessedTime = 0;
    this.processingLockDuration = 3000;

    // NEW: Employee display timeout
    this.employeeDisplayTimeout = null;

    this.autoCloseTimeout = null;
    this.autoCloseCountdownInterval = null;
    this.autoCloseDuration = 15 * 60 * 1000; // 15 minutes in milliseconds
    this.autoCloseStartTime = null;

    // Current time display
    this.currentTimeInterval = null;

    // Barcode input tracking
    this.barcodeInputInitialized = false;

    console.log('FaceRecognitionManager created with integrated employee display');
  }

  async init() {
    if (this.initializationStarted) {
      return;
    }

    this.initializationStarted = true;

    try {
      console.log('Starting FaceRecognitionManager...');

      this.createFaceRecognitionUI();
      this.showStatus('Initializing...', 'info');

      await this.setTensorFlowBackend();
      await this.loadModelsOptimized();
      this.loadEmployeeFaceDescriptorsFromDB();

      console.log('✓ FaceRecognitionManager initialized');
    } catch (error) {
      console.error('Failed to initialize:', error);
      this.showStatus('Initialization failed: ' + error.message, 'error');
    }
  }

  async setTensorFlowBackend() {
    try {
      if (typeof faceapi === 'undefined') {
        await this.waitForFaceApi();
      }

      if (faceapi.tf?.setBackend) {
        const originalConsoleError = console.error;
        console.error = (...args) => {
          const msg = args.join(' ');
          if (!msg.includes('WebGL') && !msg.includes('backend webgl')) {
            originalConsoleError.apply(console, args);
          }
        };

        try {
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');

          if (gl && gl instanceof WebGLRenderingContext) {
            await faceapi.tf.setBackend('webgl');
            await faceapi.tf.ready();
            console.log('✓ TensorFlow backend: WebGL (GPU accelerated)');
          } else {
            throw new Error('WebGL not available');
          }
        } catch (e) {
          await faceapi.tf.setBackend('cpu');
          await faceapi.tf.ready();
          console.log('✓ TensorFlow backend: CPU (WebGL unavailable)');
        } finally {
          console.error = originalConsoleError;
        }
      }
    } catch (error) {
      console.warn('Could not set TensorFlow backend:', error);
    }
  }

  waitForFaceApi(timeout = 10000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const checkInterval = setInterval(() => {
        if (typeof faceapi !== 'undefined') {
          clearInterval(checkInterval);
          resolve();
        } else if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval);
          reject(new Error('Timeout waiting for face-api.js'));
        }
      }, 100);
    });
  }

  async loadModelsOptimized() {
    try {
      if (typeof faceapi === 'undefined') {
        await this.waitForFaceApi();
      }

      this.showStatus('Loading AI models...', 'info');

      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(this.modelPath),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(this.modelPath),
        faceapi.nets.faceRecognitionNet.loadFromUri(this.modelPath)
      ]);

      this.modelsLoaded = true;
      console.log('✓ Models loaded');
      this.showStatus('AI models ready', 'success');

    } catch (error) {
      console.error('Error loading models:', error);
      this.showStatus('Failed to load AI models', 'error');
      throw error;
    }
  }

  async loadEmployeeFaceDescriptorsFromDB() {
    try {
      this.showStatus('Loading profiles...', 'info');

      const employeesResult = await this.electronAPI.getEmployees();
      if (!employeesResult.success || !employeesResult.data) {
        this.showStatus('No employee profiles found', 'info');
        this.descriptorsLoaded = true;
        return;
      }

      const employees = employeesResult.data;
      let loadedCount = 0;
      let skippedCount = 0;

      employees.forEach((employee) => {
        try {
          if (!employee.face_descriptor) {
            skippedCount++;
            return;
          }

          const descriptorArray = JSON.parse(employee.face_descriptor);

          if (!Array.isArray(descriptorArray) || descriptorArray.length !== 128) {
            skippedCount++;
            return;
          }

          const descriptor = new Float32Array(descriptorArray);
          const uidString = String(employee.uid);

          this.faceDescriptors.set(uidString, {
            descriptor: descriptor,
            employee: {
              uid: employee.uid,
              id: employee.id,
              first_name: employee.first_name,
              middle_name: employee.middle_name,
              last_name: employee.last_name,
              id_number: employee.id_number,
              id_barcode: employee.id_barcode,
              department: employee.department,
              position: employee.position
            },
            name: `${employee.first_name} ${employee.last_name}`
          });

          loadedCount++;

        } catch (error) {
          console.error(`Error processing descriptor for ${employee.uid}:`, error);
          skippedCount++;
        }
      });

      this.faceMatcherDirty = true;
      this.descriptorsLoaded = true;
      console.log(`✓ Loaded ${loadedCount} descriptors (${skippedCount} skipped)`);

      if (loadedCount === 0) {
        this.showStatus('No valid face descriptors', 'error');
      } else {
        this.showStatus(`Ready: ${loadedCount} profiles`, 'success');
      }

      this.updateLoadedCount(loadedCount);

    } catch (error) {
      console.error('Error loading descriptors:', error);
      this.showStatus('Error loading profiles', 'error');
      this.descriptorsLoaded = true;
    }
  }

  updateLoadedCount(count) {
    const countElement = document.getElementById('facesLoadedCount');
    if (countElement) {
      countElement.textContent = count;
    }
  }

  getFaceMatcher() {
    if (!this.faceMatcherDirty && this.cachedFaceMatcher) {
      return this.cachedFaceMatcher;
    }

    const labeledDescriptors = Array.from(this.faceDescriptors.entries()).map(
      ([uid, data]) => new faceapi.LabeledFaceDescriptors(uid, [data.descriptor])
    );

    this.cachedFaceMatcher = new faceapi.FaceMatcher(labeledDescriptors, this.matchThreshold);
    this.faceMatcherDirty = false;

    return this.cachedFaceMatcher;
  }

  createFaceRecognitionUI() {
    this.container = document.createElement('div');
    this.container.id = 'faceRecognitionContainer';
    this.container.className = 'face-recognition-container hidden';
    this.container.innerHTML = `
  <div class="face-recognition-header">
  <div class="header-left">
    <h3>👤 Face Recognition System</h3>
    <span class="badge badge-ultra">Ultra Mode</span>
  </div>
  <div class="header-center">
    <span id="currentTimeDisplay" class="current-time-badge">⏰ --:--:--</span>
  </div>
  <div class="header-right">
    <span id="autoCloseCountdown" class="countdown-badge">⏱️ 15:00</span>
    <button id="closeFaceRecognition" class="close-btn">✕</button>
  </div>
</div>
  
  <div class="face-recognition-body">
    <!-- Left Panel: Video + Stats + Barcode -->
    <div class="left-section">
      <!-- Video Section -->
      <div class="video-section">
        <div class="video-wrapper">
          <video id="faceRecognitionVideo" autoplay muted playsinline></video>
          <canvas id="faceRecognitionCanvas"></canvas>
          <div class="video-overlay">
            <div class="performance-badge" id="performanceBadge">
              <span class="perf-dot"></span>
              <span id="perfMode">Stopped</span>
            </div>
          </div>
        </div>
        
        <div class="status-bar" id="faceRecognitionStatus">
          <span class="status-icon">⚪</span>
          <span class="status-text">Ready to scan faces...</span>
        </div>
      </div>

      <!-- Control Buttons -->
      <div class="control-buttons">
        <button id="startFaceRecognition" class="btn btn-start">
          <span class="btn-icon">▶️</span>
          <span>Start Recognition</span>
        </button>
        <button id="stopFaceRecognition" class="btn btn-stop" disabled>
          <span class="btn-icon">⏹️</span>
          <span>Stop</span>
        </button>
      </div>

      <!-- Stats Grid -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">👥</div>
          <div class="stat-content">
            <div class="stat-label">Profiles</div>
            <div class="stat-value" id="facesLoadedCount">0</div>
          </div>
        </div>
        
        <div class="stat-card">
          <div class="stat-icon">📊</div>
          <div class="stat-content">
            <div class="stat-label">FPS</div>
            <div class="stat-value" id="fpsCounter">0</div>
          </div>
        </div>
        
        <div class="stat-card">
          <div class="stat-icon">⚡</div>
          <div class="stat-content">
            <div class="stat-label">Backend</div>
            <div class="stat-value" id="backendType">CPU</div>
          </div>
        </div>
        
        <div class="stat-card">
          <div class="stat-icon">🎯</div>
          <div class="stat-content">
            <div class="stat-label">Status</div>
            <div class="stat-value" id="detectionStatus">Inactive</div>
          </div>
        </div>
      </div>

      <!-- Barcode Input -->
      <div class="barcode-section">
        <div class="barcode-header">
          <span class="barcode-icon">📷</span>
          <span>Barcode Scanner</span>
        </div>
        <input 
          type="text" 
          id="barcodeInput" 
          class="barcode-input" 
          placeholder="Scan barcode here..."
          autocomplete="off"
        />
        <div class="barcode-hint">💡 Focus here and scan employee barcode</div>
      </div>
    </div>

    <!-- Right Panel: Current Employee + Recent Scans (ROW) -->
    <div class="right-section">
      <!-- Current Employee (Top) -->
      <div class="employee-display-panel" id="employeeDisplayPanel">
        <div class="employee-display-header">
          <h4>📋 Current Employee</h4>
        </div>
        <div class="employee-display-content" id="employeeDisplayContent">
          <div class="employee-display-empty">
            <div class="empty-icon">👤</div>
            <div class="empty-text">Waiting for scan...</div>
            <div class="empty-hint">Scan a face or barcode to see employee details</div>
          </div>
        </div>
      </div>

      <!-- Recent Scans (Bottom) -->
      <div class="scan-log-panel">
        <div class="scan-log-header">
          <h4>📋 Recent Scans</h4>
          <button id="clearScanLog" class="clear-log-btn" title="Clear log">🗑️</button>
        </div>
        <div class="scan-log-list" id="scanLogList">
          <div class="scan-log-empty">No scans yet</div>
        </div>
      </div>
    </div>
  </div>
`;


    document.body.appendChild(this.container);

    this.videoElement = document.getElementById('faceRecognitionVideo');
    this.canvasElement = document.getElementById('faceRecognitionCanvas');
    this.statusElement = document.getElementById('faceRecognitionStatus');

    this.setupEventListeners();
    this.addStyles();

    this.updateLoadedCount(this.faceDescriptors.size);
    this.updateBackendType();
  }

  updateBackendType() {
    const backendElement = document.getElementById('backendType');
    if (backendElement && typeof faceapi !== 'undefined' && faceapi.tf) {
      const backend = faceapi.tf.getBackend();
      backendElement.textContent = backend === 'webgl' ? 'GPU' : 'CPU';

      if (backend === 'webgl') {
        backendElement.style.color = '#22c55e';
      }
    }
  }

  setupEventListeners() {
    document.getElementById('closeFaceRecognition').addEventListener('click', () => {
      this.hide();
    });

    document.getElementById('startFaceRecognition').addEventListener('click', () => {
      this.startRecognition();
    });

    document.getElementById('stopFaceRecognition').addEventListener('click', () => {
      this.stopRecognition();
    });

    if (this.videoElement) {
      this.videoElement.addEventListener('loadedmetadata', () => {
        this.setupCanvas();
      });
    }

    document.getElementById('clearScanLog').addEventListener('click', () => {
      this.clearScanLog();
    });

    // Initialize barcode scanner
    this.initializeBarcodeScanner();
  }

  initializeBarcodeScanner() {
    const barcodeInput = document.getElementById('barcodeInput');
    if (!barcodeInput) return;

    // Remove existing listeners if any
    const newBarcodeInput = barcodeInput.cloneNode(true);
    barcodeInput.parentNode.replaceChild(newBarcodeInput, barcodeInput);

    let barcodeBuffer = '';
    let barcodeTimeout = null;

    newBarcodeInput.addEventListener('input', (e) => {
      if (barcodeTimeout) {
        clearTimeout(barcodeTimeout);
      }

      barcodeTimeout = setTimeout(async () => {
        const barcode = newBarcodeInput.value.trim();

        if (barcode.length > 0) {
          console.log(`📷 Barcode input received: "${barcode}"`);
          await this.processBarcodeInput(barcode);
          newBarcodeInput.value = '';
          barcodeBuffer = '';
        }
      }, 150);
    });

    newBarcodeInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();

        if (barcodeTimeout) {
          clearTimeout(barcodeTimeout);
          barcodeTimeout = null;
        }

        const barcode = newBarcodeInput.value.trim();

        if (barcode.length > 0) {
          console.log(`⌨️ Manual barcode entry: "${barcode}"`);
          await this.processBarcodeInput(barcode);
          newBarcodeInput.value = '';
        }
      }
    });

    newBarcodeInput.addEventListener('focus', () => {
      newBarcodeInput.style.borderColor = '#3b82f6';
      newBarcodeInput.style.boxShadow = '0 0 0 3px rgba(59, 130, 246, 0.1)';
    });

    newBarcodeInput.addEventListener('blur', () => {
      newBarcodeInput.style.borderColor = '#e5e7eb';
      newBarcodeInput.style.boxShadow = 'none';
    });

    this.barcodeInputInitialized = true;
    console.log('✓ Barcode scanner initialized');
  }

  updateCurrentTimeDisplay() {
    const timeElement = document.getElementById('currentTimeDisplay');
    if (!timeElement) return;

    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;

    // const timeString = `${displayHours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')} ${ampm}`;

    // timeElement.textContent = `⏰ ${timeString}`;
  }

  startCurrentTimeDisplay() {
    this.updateCurrentTimeDisplay();

    if (this.currentTimeInterval) {
      clearInterval(this.currentTimeInterval);
    }

    this.currentTimeInterval = setInterval(() => {
      this.updateCurrentTimeDisplay();
    }, 1000);
  }

  stopCurrentTimeDisplay() {
    if (this.currentTimeInterval) {
      clearInterval(this.currentTimeInterval);
      this.currentTimeInterval = null;
    }
  }

  addStyles() {
    if (document.getElementById('faceRecognitionStyles')) return;

    const style = document.createElement('style');
    style.id = 'faceRecognitionStyles';
    style.textContent = `
    .face-recognition-container {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 96%;
      max-width: 1800px;
      height: 90vh;
      background: #ffffff;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      z-index: 9999;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .face-recognition-container.hidden {
      display: none;
    }

    .face-recognition-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 24px;
      background: linear-gradient(135deg, #52525b 0%, #3f3f46 100%);
      color: white;
      flex-shrink: 0;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .header-center {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
}

.current-time-badge {
  font-size: 16px;
  font-weight: 700;
  background: rgba(255, 255, 255, 0.25);
  color: white;
  padding: 8px 20px;
  border-radius: 12px;
  backdrop-filter: blur(10px);
  font-family: 'Courier New', monospace;
  letter-spacing: 1px;
  min-width: 160px;
  text-align: center;
}
      .header-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .countdown-badge {
      font-size: 13px;
      font-weight: 700;
      background: rgba(255, 255, 255, 0.25);
      color: white;
      padding: 6px 14px;
      border-radius: 12px;
      backdrop-filter: blur(10px);
      font-family: 'Courier New', monospace;
      letter-spacing: 0.5px;
      transition: all 0.3s;
    }

    .countdown-badge.warning {
      background: rgba(239, 68, 68, 0.9);
      animation: pulseWarning 1s ease-in-out infinite;
    }

    @keyframes pulseWarning {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }

    .face-recognition-header h3 {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
    }

    .badge {
      font-size: 11px;
      font-weight: 600;
      background: rgba(255, 255, 255, 0.25);
      color: white;
      padding: 4px 10px;
      border-radius: 12px;
      backdrop-filter: blur(10px);
    }

    .badge-ultra {
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    .close-btn {
      background: rgba(255, 255, 255, 0.2);
      border: none;
      font-size: 24px;
      color: white;
      cursor: pointer;
      padding: 0;
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      transition: all 0.2s;
    }

    .close-btn:hover {
      background: rgba(255, 255, 255, 0.3);
      transform: scale(1.1);
    }

    /* Main Body Layout - 2 Columns */
    .face-recognition-body {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr 780px;
      gap: 0;
      overflow: hidden;
      background: #f3f4f6;
    }

    /* Left Section */
    .left-section {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 20px;
      overflow-y: auto;
      background: #f9fafb;
      border-right: 1px solid #e5e7eb;
    }

    /* Right Section - Column (Employee Top, Scans Bottom) */
    .right-section {
      display: flex;
      flex-direction: row;
      gap: 16px;
      padding: 20px;
      overflow: hidden;
      background: #f3f4f6;
    }

    /* Video Section - Reduced Size */
    .video-section {
      background: white;
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      flex-shrink: 0;
    }

    .video-wrapper {
      position: relative;
      width: 100%;
      background: #000;
      border-radius: 8px;
      overflow: hidden;
      aspect-ratio: 3/2;
    }

    #faceRecognitionVideo {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    #faceRecognitionCanvas {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }

    .video-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
    }

    .performance-badge {
      position: absolute;
      top: 12px;
      right: 12px;
      background: rgba(0, 0, 0, 0.75);
      color: white;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
      backdrop-filter: blur(10px);
    }

    .perf-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #22c55e;
      animation: blink 1.5s ease-in-out infinite;
    }

    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    .status-bar {
      margin-top: 12px;
      padding: 12px 16px;
      background: #f3f4f6;
      border-radius: 8px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.3s;
    }

    .status-icon {
      font-size: 18px;
    }

    .status-bar.detecting {
      background: #dbeafe;
      color: #1e40af;
    }

    .status-bar.detecting .status-icon::before {
      content: '🔍';
    }

    .status-bar.recognized {
      background: #dcfce7;
      color: #166534;
    }

    .status-bar.recognized .status-icon::before {
      content: '✅';
    }

    .status-bar.error {
      background: #fee2e2;
      color: #991b1b;
    }

    .status-bar.error .status-icon::before {
      content: '❌';
    }

    /* Control Buttons */
    .control-buttons {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      flex-shrink: 0;
    }

    .btn {
      padding: 14px 24px;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }

    .btn-icon {
      font-size: 16px;
    }

    .btn-start {
      background: linear-gradient(135deg, #52525b 0%, #3f3f46 100%);
      color: white;
    }

    .btn-start:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(82, 82, 91, 0.4);
    }

    .btn-stop {
      background: #ef4444;
      color: white;
    }

    .btn-stop:hover:not(:disabled) {
      background: #dc2626;
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(239, 68, 68, 0.4);
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none !important;
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      flex-shrink: 0;
    }

    .stat-card {
      background: white;
      border-radius: 10px;
      padding: 14px;
      display: flex;
      align-items: center;
      gap: 10px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      transition: all 0.2s;
    }

    .stat-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }

    .stat-icon {
      font-size: 22px;
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #52525b 0%, #3f3f46 100%);
      border-radius: 8px;
    }

    .stat-content {
      flex: 1;
    }

    .stat-label {
      font-size: 10px;
      color: #6b7280;
      font-weight: 500;
      margin-bottom: 4px;
    }

    .stat-value {
      font-size: 16px;
      color: #1f2937;
      font-weight: 700;
    }

    /* Barcode Section */
    .barcode-section {
      display: none;
      background: white;
      border-radius: 12px;
      padding: 18px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      flex-shrink: 0;
    }

    .barcode-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      font-weight: 600;
      color: #1f2937;
      margin-bottom: 12px;
    }

    .barcode-icon {
      font-size: 18px;
    }

    .barcode-input {
      width: 100%;
      padding: 14px 16px;
      border: 2px solid #e5e7eb;
      border-radius: 8px;
      font-size: 16px;
      font-family: 'Courier New', monospace;
      transition: all 0.2s;
      background: #f9fafb;
    }

    .barcode-input:focus {
      outline: none;
      border-color: #52525b;
      background: white;
      box-shadow: 0 0 0 3px rgba(82, 82, 91, 0.1);
    }

    .barcode-hint {
      margin-top: 8px;
      font-size: 12px;
      color: #6b7280;
      text-align: center;
    }

    /* Employee Display Panel */
    .employee-display-panel {
      background: white;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      display: flex;
      flex-direction: column;
      flex: 0 0 auto;
      overflow: hidden;
    }

    .employee-display-header {
      padding: 16px 20px;
      background: linear-gradient(135deg, #52525b 0%, #3f3f46 100%);
      border-radius: 12px 12px 0 0;
      flex-shrink: 0;
    }

    .employee-display-header h4 {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      color: #ffffff;
    }

    .employee-display-content {
      padding: 20px;
      overflow-y: auto;
      flex: 1;
    }

    .employee-display-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 30px 20px;
      height: 100%;
    }

    .empty-icon {
      font-size: 48px;
      opacity: 0.25;
      margin-bottom: 12px;
    }

    .empty-text {
      font-size: 15px;
      font-weight: 600;
      color: #6b7280;
      margin-bottom: 6px;
    }

    .empty-hint {
      font-size: 12px;
      color: #9ca3af;
    }

    /* Employee Display Active State */
    .employee-display-active {
      animation: slideInFromRight 0.3s ease-out;
      display: flex;
      flex-direction: column;
      gap: 14px;
      align-items: center;
    }

    @keyframes slideInFromRight {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .employee-photo-section {
      text-align: center;
    }

    .employee-photo {
      width: 140px;
      height: 140px;
      border-radius: 12px;
      object-fit: cover;
      border: 3px solid #e5e7eb;
      box-shadow: 0 6px 16px rgba(0,0,0,0.1);
    }

    .employee-details-section {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .employee-info-section {
      background: #f9fafb;
      border-radius: 10px;
      padding: 14px;
      text-align: center;
    }

    .employee-name-display {
      font-size: 17px;
      font-weight: 700;
      color: #1f2937;
      margin-bottom: 5px;
    }

    .employee-dept-display {
      font-size: 12px;
      color: #6b7280;
      margin-bottom: 6px;
    }

    .employee-id-display {
      font-size: 11px;
      color: #9ca3af;
      font-family: 'Courier New', monospace;
    }

    .clock-info-section {
      background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%);
      border: 2px solid #3b82f6;
      border-radius: 10px;
      padding: 12px;
    }

    .clock-type-display {
      font-size: 14px;
      font-weight: 700;
      text-align: center;
      padding: 8px;
      border-radius: 6px;
      margin-bottom: 8px;
    }

    .clock-type-display.morning-in,
    .clock-type-display.afternoon-in {
      background: #dcfce7;
      color: #166534;
    }

    .clock-type-display.morning-out,
    .clock-type-display.afternoon-out {
      background: #fee2e2;
      color: #991b1b;
    }

    .clock-type-display.evening-in,
    .clock-type-display.overtime-in {
      background: #fef3c7;
      color: #92400e;
    }

    .clock-type-display.evening-out,
    .clock-type-display.overtime-out {
      background: #dbeafe;
      color: #1e40af;
    }

    .clock-time-display {
      font-size: 12px;
      text-align: center;
      color: #4b5563;
      margin-bottom: 10px;
    }

    .hours-breakdown-display {
      background: white;
      border-radius: 6px;
      padding: 8px;
    }

    .hours-row {
      display: flex;
      justify-content: space-between;
      padding: 5px 0;
      border-bottom: 1px solid #f3f4f6;
    }

    .hours-row:last-child {
      border-bottom: none;
      font-weight: 700;
      color: #1f2937;
    }

    .hours-label {
      font-size: 12px;
      color: #6b7280;
    }

    .hours-value {
      font-size: 12px;
      font-weight: 600;
      color: #1f2937;
    }

    /* Scan Log Panel */
    .scan-log-panel {
      background: white;
      display: flex;
      flex-direction: column;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      overflow: hidden;
      flex: 1;
      min-height: 0;
    }

    .scan-log-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      background: linear-gradient(135deg, #52525b 0%, #3f3f46 100%);
      flex-shrink: 0;
    }

    .scan-log-header h4 {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      color: #ffffff;
    }

    .clear-log-btn {
      background: rgba(255, 255, 255, 0.2);
      border: none;
      font-size: 16px;
      cursor: pointer;
      padding: 6px 10px;
      border-radius: 6px;
      transition: all 0.2s;
      color: white;
    }

    .clear-log-btn:hover {
      background: rgba(255, 255, 255, 0.3);
      transform: scale(1.05);
    }

    .scan-log-list {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .scan-log-empty {
      text-align: center;
      color: #9ca3af;
      font-size: 14px;
      padding: 40px 20px;
    }

    .scan-log-item {
      display: flex;
      gap: 12px;
      padding: 12px;
      background: #f9fafb;
      border-radius: 8px;
      border-left: 3px solid #22c55e;
      animation: slideIn 0.3s ease-out;
      transition: all 0.2s;
    }

    .scan-log-item:hover {
      transform: translateX(-2px);
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }

    .scan-log-item.error {
      border-left-color: #ef4444;
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateX(20px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }

    .scan-log-icon {
      font-size: 18px;
      font-weight: bold;
      color: #22c55e;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(34, 197, 94, 0.15);
      border-radius: 6px;
      flex-shrink: 0;
    }

    .scan-log-item.error .scan-log-icon {
      color: #ef4444;
      background: rgba(239, 68, 68, 0.15);
    }

    .scan-log-details {
      flex: 1;
      min-width: 0;
    }

    .scan-log-name {
      font-size: 14px;
      font-weight: 600;
      color: #1f2937;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 4px;
    }

    .scan-log-action {
      font-size: 12px;
      color: #6b7280;
      margin-bottom: 4px;
    }

    .scan-log-time {
      font-size: 11px;
      color: #9ca3af;
    }

    .scan-log-method {
      font-size: 10px;
      color: #9ca3af;
      font-weight: 600;
      text-transform: uppercase;
    }

    /* Responsive */
    @media (max-width: 1400px) {
      .face-recognition-body {
        grid-template-columns: 1fr 400px;
      }

      .stats-grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    @media (max-width: 1024px) {
      .face-recognition-container {
        width: 100%;
        height: 100vh;
        border-radius: 0;
      }

      .face-recognition-body {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr;
      }

      .right-section {
        max-height: none;
      }

      .employee-display-panel {
        max-height: 350px;
      }

      .stats-grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    @media (max-width: 768px) {
      .left-section {
        padding: 16px;
      }

      .right-section {
        padding: 16px;
        gap: 12px;
      }
    }
      /* Toast Notifications */
.face-recognition-toast {
  position: fixed;
  top: 100px;
  right: -400px;
  background: white;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.15);
  padding: 16px 20px;
  z-index: 10001;
  transition: right 0.3s ease-out;
  max-width: 400px;
  min-width: 300px;
}

.face-recognition-toast.show {
  right: 24px;
}

.toast-content {
  display: flex;
  align-items: center;
  gap: 12px;
}

.toast-icon {
  font-size: 24px;
  flex-shrink: 0;
}

.toast-message {
  font-size: 14px;
  font-weight: 500;
  color: #1f2937;
  line-height: 1.5;
}

.face-recognition-toast.toast-error {
  border-left: 4px solid #ef4444;
}

.face-recognition-toast.toast-success {
  border-left: 4px solid #22c55e;
}

.face-recognition-toast.toast-info {
  border-left: 4px solid #3b82f6;
}
  `;

    document.head.appendChild(style);
  }

  showIntegratedEmployeeDisplay(data) {
    const displayContent = document.getElementById('employeeDisplayContent');
    if (!displayContent) return;

    const {
      employee,
      clockType,
      sessionType,
      clockTime,
      regularHours,
      overtimeHours,
      isOvertimeSession,
    } = data;

    const fullName = `${employee.first_name} ${employee.middle_name || ''} ${employee.last_name}`.trim();
    const totalHours = (regularHours || 0) + (overtimeHours || 0);

    displayContent.innerHTML = `
      <div class="employee-display-active">
        <div class="employee-photo-section">
          <img 
            id="employeePhotoDisplay" 
            class="employee-photo" 
            src="${this.getDefaultImageDataURL()}"
            alt="${fullName}"
          />
        </div>

        <div class="employee-details-section">
          <div class="employee-info-section">
            <div class="employee-name-display">${fullName}</div>
            <div class="employee-dept-display">${employee.department || 'No Department'}</div>
            <div class="employee-id-display">ID: ${employee.id_number}</div>
          </div>

          <div class="clock-info-section">
            <div class="clock-type-display ${clockType.replace('_', '-')} ${isOvertimeSession ? 'overtime' : ''}">
              ${this.formatClockType(clockType, sessionType)}
            </div>
            <div class="clock-time-display">
              🕒 ${new Date(clockTime).toLocaleTimeString()}
            </div>
            <div class="hours-breakdown-display">
              <div class="hours-row">
                <span class="hours-label">Regular Hours:</span>
                <span class="hours-value">${(regularHours || 0).toFixed(1)}h</span>
              </div>
              <div class="hours-row">
                <span class="hours-label">Overtime Hours:</span>
                <span class="hours-value">${(overtimeHours || 0).toFixed(1)}h</span>
              </div>
              <div class="hours-row">
                <span class="hours-label">Total Hours:</span>
                <span class="hours-value">${totalHours.toFixed(1)}h</span>
              </div>
              ${isOvertimeSession ? `
              <div class="hours-row" style="background: #fef3c7; margin-top: 8px; padding: 8px; border-radius: 6px;">
                <span class="hours-label">🌙 Overtime Session</span>
              </div>
              ` : ''}
            </div>
          </div>
        </div>
      </div>
    `;

    // Load employee photo
    const photoElement = document.getElementById('employeePhotoDisplay');
    if (photoElement && this.attendanceApp?.setupImageWithFallback) {
      this.attendanceApp.setupImageWithFallback(photoElement, employee.uid, fullName);
    }

    // Auto-clear after 30 seconds
    if (this.employeeDisplayTimeout) {
      clearTimeout(this.employeeDisplayTimeout);
    }

    this.employeeDisplayTimeout = setTimeout(() => {
      this.clearIntegratedEmployeeDisplay();
    }, 30000);
  }

  clearIntegratedEmployeeDisplay() {
    const displayContent = document.getElementById('employeeDisplayContent');
    if (!displayContent) return;

    displayContent.innerHTML = `
      <div class="employee-display-empty">
        <div class="empty-icon">👤</div>
        <div class="empty-text">Waiting for scan...</div>
        <div class="empty-hint">Scan a face or barcode to see employee details</div>
      </div>
    `;
  }

  getDefaultImageDataURL() {
    const svg = `<svg width="180" height="180" xmlns="http://www.w3.org/2000/svg">
      <rect width="180" height="180" fill="#f0f0f0" rx="16"/>
      <circle cx="90" cy="70" r="30" fill="#ccc"/>
      <ellipse cx="90" cy="140" rx="40" ry="30" fill="#ccc"/>
    </svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  formatClockType(clockType, sessionType) {
    if (sessionType) {
      const isIn = clockType.endsWith('_in');
      const emoji = isIn ? '🟢' : '🔴';
      const action = isIn ? 'In' : 'Out';
      return `${emoji} ${sessionType} ${action}`;
    }

    const types = {
      morning_in: '🟢 Morning In',
      morning_out: '🔴 Morning Out',
      afternoon_in: '🟢 Afternoon In',
      afternoon_out: '🔴 Afternoon Out',
      evening_in: '🟢 Evening In',
      evening_out: '🔴 Evening Out',
      overtime_in: '🟢 Overtime In',
      overtime_out: '🔴 Overtime Out',
    };
    return types[clockType] || clockType;
  }

  // AUTO-CLOSE COUNTDOWN METHODS
  startAutoCloseCountdown() {
    // Clear any existing countdown
    this.stopAutoCloseCountdown();

    this.autoCloseStartTime = Date.now();

    // Update countdown display every second
    this.autoCloseCountdownInterval = setInterval(() => {
      this.updateAutoCloseDisplay();
    }, 1000);

    // Set timeout to auto-close after 15 minutes
    this.autoCloseTimeout = setTimeout(() => {
      console.log('⏰ Auto-closing Face Recognition after 15 minutes');
      this.showStatus('⏰ Session timeout - closing...', 'info');
      setTimeout(() => {
        this.hide();
      }, 2000);
    }, this.autoCloseDuration);

    // Initial display update
    this.updateAutoCloseDisplay();

    console.log('✓ Auto-close countdown started (15 minutes)');
  }

  stopAutoCloseCountdown() {
    if (this.autoCloseTimeout) {
      clearTimeout(this.autoCloseTimeout);
      this.autoCloseTimeout = null;
    }

    if (this.autoCloseCountdownInterval) {
      clearInterval(this.autoCloseCountdownInterval);
      this.autoCloseCountdownInterval = null;
    }

    this.autoCloseStartTime = null;

    // Reset countdown display
    const countdownElement = document.getElementById('autoCloseCountdown');
    if (countdownElement) {
      countdownElement.textContent = '⏱️ 15:00';
      countdownElement.classList.remove('warning');
    }
  }

  updateAutoCloseDisplay() {
    const countdownElement = document.getElementById('autoCloseCountdown');
    if (!countdownElement || !this.autoCloseStartTime) return;

    const elapsed = Date.now() - this.autoCloseStartTime;
    const remaining = Math.max(0, this.autoCloseDuration - elapsed);

    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);

    const timeString = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    countdownElement.textContent = `⏱️ ${timeString}`;

    // Add warning styling when less than 2 minutes remain
    if (remaining <= 120000 && remaining > 0) {
      countdownElement.classList.add('warning');
    } else {
      countdownElement.classList.remove('warning');
    }

    // Show status warning at 5 minutes
    if (remaining <= 300000 && remaining > 299000) {
      this.showStatus('⚠️ Session will close in 5 minutes', 'info');
    }

    // Show status warning at 1 minute
    if (remaining <= 60000 && remaining > 59000) {
      this.showStatus('⚠️ Session will close in 1 minute!', 'error');
    }
  }

  // NEW: Clear the integrated employee display
  clearIntegratedEmployeeDisplay() {
    const displayContent = document.getElementById('employeeDisplayContent');
    if (!displayContent) return;

    displayContent.innerHTML = `
      <div class="employee-display-empty">
        <div class="empty-icon">👤</div>
        <div class="empty-text">Waiting for scan...</div>
        <div class="empty-hint">Scan a face or barcode to see employee details</div>
      </div>
    `;
  }

  getDefaultImageDataURL() {
    const svg = `<svg width="180" height="180" xmlns="http://www.w3.org/2000/svg">
      <rect width="180" height="180" fill="#f0f0f0" rx="16"/>
      <circle cx="90" cy="70" r="30" fill="#ccc"/>
      <ellipse cx="90" cy="140" rx="40" ry="30" fill="#ccc"/>
    </svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  formatClockType(clockType, sessionType) {
    if (sessionType) {
      const isIn = clockType.endsWith('_in');
      const emoji = isIn ? '🟢' : '🔴';
      const action = isIn ? 'In' : 'Out';
      return `${emoji} ${sessionType} ${action}`;
    }

    const types = {
      morning_in: '🟢 Morning In',
      morning_out: '🔴 Morning Out',
      afternoon_in: '🟢 Afternoon In',
      afternoon_out: '🔴 Afternoon Out',
      evening_in: '🟢 Evening In',
      evening_out: '🔴 Evening Out',
      overtime_in: '🟢 Overtime In',
      overtime_out: '🔴 Overtime Out',
    };
    return types[clockType] || clockType;
  }

  setupCanvas() {
    if (!this.videoElement || !this.canvasElement) return;

    const displaySize = {
      width: this.videoElement.videoWidth,
      height: this.videoElement.videoHeight
    };

    faceapi.matchDimensions(this.canvasElement, displaySize);
  }

  async startRecognition() {
    if (!this.modelsLoaded) {
      this.showStatus('AI models not loaded yet', 'error');
      return;
    }

    if (!this.descriptorsLoaded) {
      this.showStatus('Employee profiles loading...', 'info');
      return;
    }

    if (this.faceDescriptors.size === 0) {
      this.showStatus('No employee profiles available', 'error');
      return;
    }

    try {
      this.videoStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user',
          frameRate: { ideal: 30, max: 30 }
        }
      });

      this.videoElement.srcObject = this.videoStream;
      this.isActive = true;
      this.currentMode = 'normal';
      this.consecutiveNoFaceFrames = 0;
      this.consecutiveFaceFrames = 0;

      document.getElementById('startFaceRecognition').disabled = true;
      document.getElementById('stopFaceRecognition').disabled = false;
      document.getElementById('detectionStatus').textContent = 'Active';
      document.getElementById('detectionStatus').style.color = '#22c55e';
      this.showStatus('Face recognition active', 'detecting');
      this.updatePerformanceMode('Normal');

      this.startDetectionLoop();

      this.cooldownCleanupInterval = setInterval(() => {
        this.cleanupExpiredCooldowns();
      }, 5 * 60 * 1000);

      const barcodeInput = document.getElementById('barcodeInput');
      if (barcodeInput) {
        setTimeout(() => barcodeInput.focus(), 500);
      }

    } catch (error) {
      console.error('Error starting recognition:', error);
      this.showStatus('Failed to access camera: ' + error.message, 'error');
    }
  }

  stopRecognition() {
    this.isActive = false;

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.videoStream) {
      this.videoStream.getTracks().forEach(track => track.stop());
      this.videoStream = null;
    }

    if (this.videoElement) {
      this.videoElement.srcObject = null;
    }

    if (this.canvasElement) {
      const ctx = this.canvasElement.getContext('2d');
      ctx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);
    }

    if (this.cooldownCleanupInterval) {
      clearInterval(this.cooldownCleanupInterval);
      this.cooldownCleanupInterval = null;
    }

    document.getElementById('startFaceRecognition').disabled = false;
    document.getElementById('stopFaceRecognition').disabled = true;
    document.getElementById('detectionStatus').textContent = 'Inactive';
    document.getElementById('detectionStatus').style.color = '#6b7280';
    document.getElementById('fpsCounter').textContent = '0';
    this.showStatus('Face recognition stopped', 'info');
    this.updatePerformanceMode('Stopped');
  }

  startDetectionLoop() {
    let frameCount = 0;
    let lastFpsUpdate = Date.now();

    const detectLoop = async () => {
      if (!this.isActive) return;

      const currentTime = Date.now();

      let currentInterval = this.detectionIntervalMs;
      if (this.currentMode === 'fast') {
        currentInterval = this.fastModeIntervalMs;
      } else if (this.currentMode === 'slow') {
        currentInterval = this.slowModeIntervalMs;
      }

      if (currentTime - this.lastDetectionTime >= currentInterval) {
        this.lastDetectionTime = currentTime;

        try {
          await this.detectAndRecognizeFaces();
        } catch (error) {
          console.error('Detection error:', error);
        }

        frameCount++;
      }

      if (currentTime - lastFpsUpdate >= 1000) {
        const fps = Math.round((frameCount * 1000) / (currentTime - lastFpsUpdate));
        const fpsElement = document.getElementById('fpsCounter');
        if (fpsElement) {
          fpsElement.textContent = fps;
        }
        frameCount = 0;
        lastFpsUpdate = currentTime;
      }

      this.animationFrameId = requestAnimationFrame(detectLoop);
    };

    detectLoop();
  }

  async detectAndRecognizeFaces() {
    if (!this.videoElement || this.videoElement.paused) return;

    const displaySize = {
      width: this.videoElement.videoWidth,
      height: this.videoElement.videoHeight
    };

    const detections = await faceapi
      .detectAllFaces(this.videoElement, this.detectionOptions)
      .withFaceLandmarks(true)
      .withFaceDescriptors();

    if (detections.length === 0) {
      this.clearCanvas();
      this.consecutiveNoFaceFrames++;
      this.consecutiveFaceFrames = 0;

      if (this.consecutiveNoFaceFrames > 3 && this.currentMode !== 'slow') {
        this.currentMode = 'slow';
        this.updatePerformanceMode('Power Save');
      }

      this.showStatusDebounced('No face detected', 'detecting');
      return;
    }

    this.consecutiveFaceFrames++;
    this.consecutiveNoFaceFrames = 0;

    if (this.consecutiveFaceFrames > 2 && this.currentMode !== 'fast') {
      this.currentMode = 'fast';
      this.updatePerformanceMode('High Speed');
    }

    const resizedDetections = faceapi.resizeResults(detections, displaySize);

    this.clearCanvas();

    const faceMatcher = this.getFaceMatcher();

    let recognized = false;

    resizedDetections.forEach(detection => {
      const bestMatch = faceMatcher.findBestMatch(detection.descriptor);
      const box = detection.detection.box;

      let isInCooldown = false;
      if (bestMatch.label !== 'unknown') {
        const uidString = String(bestMatch.label);
        isInCooldown = this.isInCameraCooldown(uidString);
      }

      this.drawDetectionBox(box, bestMatch, isInCooldown);

      if (bestMatch.label !== 'unknown') {
        recognized = true;
        const employeeData = this.faceDescriptors.get(bestMatch.label);

        if (employeeData) {
          this.handleRecognition(employeeData, bestMatch.distance);
        }
      }
    });

    if (!recognized) {
      this.showStatusDebounced('Face detected but not recognized', 'detecting');
    }
  }

  isInCameraCooldown(uidString) {
    if (!this.employeeCooldowns.has(uidString)) {
      return false;
    }

    const lastScanTime = this.employeeCooldowns.get(uidString);
    const timeSinceLastScan = Date.now() - lastScanTime;

    if (timeSinceLastScan >= this.employeeCooldownDuration) {
      this.employeeCooldowns.delete(uidString);
      return false;
    }

    return true;
  }

  isInBarcodeCooldown(uidString) {
    if (!this.barcodeCooldowns.has(uidString)) {
      return false;
    }

    const lastScanTime = this.barcodeCooldowns.get(uidString);
    const timeSinceLastScan = Date.now() - lastScanTime;

    if (timeSinceLastScan >= this.barcodeCooldownDuration) {
      this.barcodeCooldowns.delete(uidString);
      return false;
    }

    return true;
  }

  drawDetectionBox(box, match, isInCooldown = false) {
    const ctx = this.canvasElement.getContext('2d');
    const isRecognized = match.label !== 'unknown';

    let strokeColor = '#3b82f6';
    let fillColor = 'rgba(59, 130, 246, 0.95)';
    let statusText = '';

    if (isRecognized) {
      if (isInCooldown) {
        strokeColor = '#ef4444';
        fillColor = 'rgba(239, 68, 68, 0.95)';
        statusText = ' - Already Clocked';
      } else {
        strokeColor = '#22c55e';
        fillColor = 'rgba(34, 197, 94, 0.95)';
      }
    }

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 3;
    ctx.strokeRect(box.x, box.y, box.width, box.height);

    if (isRecognized) {
      const employeeData = this.faceDescriptors.get(match.label);
      const label = employeeData ? employeeData.name : match.label;
      const confidence = Math.round((1 - match.distance) * 100);

      const fullLabel = `${label} (${confidence}%)${statusText}`;

      ctx.fillStyle = fillColor;
      const padding = 8;
      const textHeight = 22;

      ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Arial';
      const textWidth = ctx.measureText(fullLabel).width;
      const bgWidth = Math.min(textWidth + padding * 2, box.width);

      ctx.fillRect(box.x, box.y + box.height + 5, bgWidth, textHeight + padding);

      ctx.fillStyle = 'white';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        fullLabel,
        box.x + padding,
        box.y + box.height + 5 + (textHeight + padding) / 2
      );
    }
  }

  updatePerformanceMode(mode) {
    const perfElement = document.getElementById('perfMode');
    if (perfElement) {
      perfElement.textContent = mode;
    }
  }

  clearCanvas() {
    if (!this.canvasElement) return;
    const ctx = this.canvasElement.getContext('2d');
    ctx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);
  }

  async handleRecognition(employeeData, distance) {
    const currentTime = Date.now();
    const confidence = Math.round((1 - distance) * 100);
    const uidString = String(employeeData.employee.uid);

    if (this.isProcessingAttendance) {
      const timeSinceLastProcess = currentTime - this.lastProcessedTime;

      if (timeSinceLastProcess < this.processingLockDuration) {
        console.log(`⏸️ Camera recognition blocked - processing lock active`);
        return;
      }
    }

    if (confidence < 70) {
      this.showStatusDebounced(
        `Low confidence: ${employeeData.name} (${confidence}%)`,
        'detecting'
      );
      return;
    }

    if (this.isInCameraCooldown(uidString)) {
      const lastScanTime = this.employeeCooldowns.get(uidString);
      const timeSinceLastScan = currentTime - lastScanTime;
      const remainingMinutes = Math.ceil((this.employeeCooldownDuration - timeSinceLastScan) / (60 * 1000));

      this.showStatus(
        `⏱️ ${employeeData.name} recently clocked. Wait ${remainingMinutes} min`,
        'info'
      );

      this.lastRecognizedUID = uidString;
      this.lastRecognitionTime = currentTime;

      return;
    }

    if (
      this.lastRecognizedUID === uidString &&
      currentTime - this.lastRecognitionTime < this.recognitionCooldown
    ) {
      return;
    }

    this.lastRecognizedUID = uidString;
    this.lastRecognitionTime = currentTime;

    this.showStatus(
      `✓ ${employeeData.name} (${confidence}%)`,
      'recognized'
    );

    await this.processAttendance(employeeData.employee, 'camera');
  }

  clearEmployeeCooldown(uid) {
    const uidString = String(uid);
    let cleared = false;

    if (this.employeeCooldowns.has(uidString)) {
      this.employeeCooldowns.delete(uidString);
      cleared = true;
    }

    if (this.barcodeCooldowns.has(uidString)) {
      this.barcodeCooldowns.delete(uidString);
      cleared = true;
    }

    if (cleared) {
      console.log(`Cleared cooldown for employee ${uid}`);
      return true;
    }
    return false;
  }

  getRemainingCooldown(uid) {
    const uidString = String(uid);

    if (this.employeeCooldowns.has(uidString)) {
      const lastScanTime = this.employeeCooldowns.get(uidString);
      const elapsed = Date.now() - lastScanTime;
      const remaining = Math.max(0, this.employeeCooldownDuration - elapsed);
      return Math.ceil(remaining / (60 * 1000));
    }

    if (this.barcodeCooldowns.has(uidString)) {
      const lastScanTime = this.barcodeCooldowns.get(uidString);
      const elapsed = Date.now() - lastScanTime;
      const remaining = Math.max(0, this.barcodeCooldownDuration - elapsed);
      return Math.ceil(remaining / 1000);
    }

    return 0;
  }

  addToScanLog(employee, clockAction, method = 'camera', success = true) {
    const logEntry = {
      uid: employee.uid,
      name: `${employee.first_name} ${employee.last_name}`,
      action: clockAction,
      method: method,
      timestamp: Date.now(),
      success: success
    };

    this.scanLog.unshift(logEntry);

    if (this.scanLog.length > this.maxLogEntries) {
      this.scanLog = this.scanLog.slice(0, this.maxLogEntries);
    }

    this.updateScanLogDisplay();
  }

  updateScanLogDisplay() {
    const logList = document.getElementById('scanLogList');
    if (!logList) return;

    if (this.scanLog.length === 0) {
      logList.innerHTML = '<div class="scan-log-empty">No scans yet</div>';
      return;
    }

    logList.innerHTML = this.scanLog.map(entry => {
      const time = new Date(entry.timestamp);
      const timeStr = time.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });

      const statusClass = entry.success ? '' : 'error';
      const statusIcon = entry.success ? '✓' : '✗';
      const methodIcon = entry.method === 'camera' ? '📹' : '🔲';
      const methodLabel = entry.method === 'camera' ? 'Camera' : 'Barcode';

      return `
      <div class="scan-log-item ${statusClass}">
        <div class="scan-log-icon">${statusIcon}</div>
        <div class="scan-log-details">
          <div class="scan-log-name">${entry.name}</div>
          <div class="scan-log-action">${entry.action}</div>
          <div class="scan-log-time">${timeStr}</div>
          <div class="scan-log-method">${methodIcon} ${methodLabel}</div>
        </div>
      </div>
    `;
    }).join('');
  }

  clearScanLog() {
    this.scanLog = [];
    this.updateScanLogDisplay();
  }

  cleanupExpiredCooldowns() {
    const currentTime = Date.now();
    const expiredCameraUIDs = [];
    const expiredBarcodeUIDs = [];

    for (const [uid, timestamp] of this.employeeCooldowns.entries()) {
      if (currentTime - timestamp >= this.employeeCooldownDuration) {
        expiredCameraUIDs.push(uid);
      }
    }

    for (const [uid, timestamp] of this.barcodeCooldowns.entries()) {
      if (currentTime - timestamp >= this.barcodeCooldownDuration) {
        expiredBarcodeUIDs.push(uid);
      }
    }

    expiredCameraUIDs.forEach(uid => this.employeeCooldowns.delete(uid));
    expiredBarcodeUIDs.forEach(uid => this.barcodeCooldowns.delete(uid));

    const totalExpired = expiredCameraUIDs.length + expiredBarcodeUIDs.length;
    if (totalExpired > 0) {
      console.log(`Cleaned up ${totalExpired} expired cooldowns`);
    }
  }

  async processAttendance(employee, method = 'camera') {
    try {
      const uidString = String(employee.uid);

      // Check if already scanned in current session (recent scans)
      const alreadyScanned = this.scanLog.find(entry =>
        String(entry.uid) === uidString && entry.success === true
      );

      if (alreadyScanned) {
        const employeeName = `${employee.first_name} ${employee.last_name}`;
        const timeAgo = this.getTimeAgo(alreadyScanned.timestamp);

        console.log(`🚫 ${employeeName} already scanned ${timeAgo} ago`);
        this.showToast(
          `${employeeName} already recorded ${timeAgo} ago`,
          'error'
        );
        this.playErrorSound();
        return;
      }

      if (this.isProcessingAttendance) {
        console.log(`⏸️ Attendance processing already in progress, skipping...`);
        return;
      }

      this.isProcessingAttendance = true;
      this.lastProcessedInput = employee.id_barcode || employee.uid;
      this.lastProcessedTime = Date.now();

      console.log(`🔒 Processing lock activated (method: ${method})`);

      if (method === 'camera') {
        if (this.isInCameraCooldown(uidString)) {
          const lastScanTime = this.employeeCooldowns.get(uidString);
          const timeSinceLastScan = Date.now() - lastScanTime;
          const remainingMinutes = Math.ceil((this.employeeCooldownDuration - timeSinceLastScan) / (60 * 1000));

          this.showStatus(
            `⏱️ Please wait ${remainingMinutes} minutes...`,
            'info'
          );

          return;
        }
      } else if (method === 'barcode') {
        if (this.isInBarcodeCooldown(uidString)) {
          this.showStatus(
            `⏱️ Please wait 2 seconds...`,
            'info'
          );

          return;
        }
      }

      this.showStatus(
        `⏳ Processing ${employee.first_name} ${employee.last_name}...`,
        'info'
      );

      console.log(`${method.toUpperCase()} - Looking up employee by UID:`, employee.uid);

      const employeeResult = await this.electronAPI.getEmployees();

      if (!employeeResult.success || !employeeResult.data) {
        throw new Error('Failed to retrieve employee list');
      }

      const fullEmployee = employeeResult.data.find(emp =>
        String(emp.uid) === String(employee.uid)
      );

      if (!fullEmployee) {
        throw new Error('Employee not found in database');
      }

      console.log('Found employee:', fullEmployee.first_name, fullEmployee.last_name);
      console.log('Using barcode:', fullEmployee.id_barcode);

      const result = await this.electronAPI.clockAttendance({
        input: String(fullEmployee.id_barcode),
        inputType: 'barcode'
      });

      console.log('Clock result:', result.success ? 'SUCCESS' : 'FAILED');
      if (!result.success) {
        console.error('Clock error:', result.error);
      }

      if (result.success) {
        const clockAction = this.getClockActionText(result.data.clockType);

        if (method === 'camera') {
          this.employeeCooldowns.set(uidString, Date.now());
          console.log(`Added UID ${uidString} to camera cooldown (1 hour)`);
        } else if (method === 'barcode') {
          this.barcodeCooldowns.set(uidString, Date.now());
          console.log(`Added UID ${uidString} to barcode cooldown (2 seconds)`);
        }

        this.addToScanLog(employee, clockAction, method, true);

        this.showStatus(
          `✅ ${clockAction}: ${employee.first_name} ${employee.last_name}`,
          'recognized'
        );

        // NEW: Show in integrated display instead of popup
        this.showIntegratedEmployeeDisplay(result.data);

        this.playSuccessSound();

        setTimeout(() => {
          if (this.isActive) {
            this.showStatus('✓ Ready for next person', 'detecting');
          }
        }, 3000);

      } else {
        this.addToScanLog(employee, 'Failed to clock', method, false);
        this.showStatus(`❌ Error: ${result.error}`, 'error');
        this.playErrorSound();
      }

    } catch (error) {
      console.error('Error processing attendance:', error);
      this.showStatus(`❌ Failed: ${error.message}`, 'error');
      this.playErrorSound();
    } finally {
      setTimeout(() => {
        this.isProcessingAttendance = false;
        console.log(`🔓 Processing lock released`);
      }, this.processingLockDuration);
    }
  }

  async processBarcodeInput(barcode) {
    try {
      const currentTime = Date.now();
      const trimmedBarcode = String(barcode).trim();

      // ENHANCED: Pre-lookup employee to check cooldown BEFORE setting lock
      let employeeUID = null;
      const employeesResult = await this.electronAPI.getEmployees();

      if (employeesResult.success && employeesResult.data) {
        const employee = employeesResult.data.find(emp =>
          String(emp.id_barcode) === trimmedBarcode
        );

        if (employee) {
          const employeeUID = String(employee.uid);

          // Check if already scanned in current session (recent scans)
          const alreadyScanned = this.scanLog.find(entry =>
            String(entry.uid) === employeeUID && entry.success === true
          );

          if (alreadyScanned) {
            const employeeName = `${employee.first_name} ${employee.last_name}`;
            const timeAgo = this.getTimeAgo(alreadyScanned.timestamp);

            console.log(`🚫 ${employeeName} already scanned ${timeAgo} ago`);
            this.showToast(
              `${employeeName} already recorded ${timeAgo} ago`,
              'error'
            );
            this.playErrorSound();
            return;
          }

          // Check if in barcode cooldown
          if (this.isInBarcodeCooldown(employeeUID)) {
            const lastScanTime = this.barcodeCooldowns.get(employeeUID);
            const timeSinceLastScan = currentTime - lastScanTime;
            const remainingSeconds = Math.ceil((this.barcodeCooldownDuration - timeSinceLastScan) / 1000);

            console.log(`🚫 Employee ${employee.first_name} ${employee.last_name} in barcode cooldown`);
            this.showStatus(
              `⏱️ ${employee.first_name} ${employee.last_name} - Wait ${remainingSeconds}s`,
              'info'
            );
            return;
          }
        }
      }

      // Check if exact same barcode was just processed
      if (this.lastProcessedInput === trimmedBarcode) {
        const timeSinceLastProcess = currentTime - this.lastProcessedTime;

        if (timeSinceLastProcess < 5000) {
          console.log(`🚫 Duplicate barcode detected within 5 seconds - REJECTED`);
          this.showStatus(
            `⏸️ Please wait ${Math.ceil((5000 - timeSinceLastProcess) / 1000)}s before scanning again`,
            'info'
          );
          return;
        }
      }

      // ENHANCED: Global processing lock - stricter check
      if (this.isProcessingAttendance) {
        const timeSinceLastProcess = currentTime - this.lastProcessedTime;

        if (timeSinceLastProcess < this.processingLockDuration) {
          console.log(`⏸️ Barcode input blocked - processing lock active (${Math.ceil((this.processingLockDuration - timeSinceLastProcess) / 1000)}s remaining)`);
          this.showStatus(
            `⏸️ Processing... please wait ${Math.ceil((this.processingLockDuration - timeSinceLastProcess) / 1000)}s`,
            'info'
          );
          return;
        }
      }



      if (employeesResult.success && employeesResult.data) {
        const employee = employeesResult.data.find(emp =>
          String(emp.id_barcode) === trimmedBarcode
        );

        if (employee) {
          employeeUID = String(employee.uid);

          // Check if employee is in barcode cooldown
          if (this.isInBarcodeCooldown(employeeUID)) {
            const lastScanTime = this.barcodeCooldowns.get(employeeUID);
            const timeSinceLastScan = currentTime - lastScanTime;
            const remainingSeconds = Math.ceil((this.barcodeCooldownDuration - timeSinceLastScan) / 1000);

            console.log(`🚫 Employee ${employee.first_name} ${employee.last_name} in barcode cooldown`);
            this.showStatus(
              `⏱️ ${employee.first_name} ${employee.last_name} - Wait ${remainingSeconds}s`,
              'info'
            );
            return;
          }

          // Check if employee already clocked via camera in this session
          const employeeCameraScan = this.scanLog.find(entry =>
            String(entry.uid) === employeeUID &&
            entry.method === 'camera' &&
            entry.success === true
          );

          if (employeeCameraScan) {
            console.log(`🚫 Barcode blocked - Employee already clocked via camera in this session`);
            this.showStatus(
              `⚠️ ${employee.first_name} ${employee.last_name} already clocked via camera`,
              'error'
            );
            this.playErrorSound();
            return;
          }
        }
      }

      // ENHANCED: Set processing lock AFTER all pre-checks pass
      this.isProcessingAttendance = true;
      this.lastProcessedInput = trimmedBarcode;
      this.lastProcessedTime = currentTime;

      console.log(`🔒 Processing lock activated (barcode: ${trimmedBarcode})`);

      this.showStatus(`⏳ Processing barcode...`, 'info');

      // ENHANCED: Call attendance API with trimmed barcode
      const result = await this.electronAPI.clockAttendance({
        input: trimmedBarcode,
        inputType: 'barcode'
      });

      console.log(`Barcode Clock Result: ${result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
      if (!result.success) {
        console.error('Clock error:', result.error);
      }

      if (result.success) {
        const clockAction = this.getClockActionText(result.data.clockType);

        const employeeName = result.data.employee
          ? `${result.data.employee.first_name} ${result.data.employee.last_name}`
          : 'Employee';

        // ENHANCED: Set barcode cooldown with longer duration (5 seconds)
        if (result.data.employee && result.data.employee.uid) {
          const uidString = String(result.data.employee.uid);
          this.barcodeCooldowns.set(uidString, currentTime);
          console.log(`✓ Added UID ${uidString} to barcode cooldown (5 seconds)`);
        }

        if (result.data.employee) {
          this.addToScanLog(result.data.employee, clockAction, 'barcode', true);
        }

        this.showStatus(
          `✅ ${clockAction}: ${employeeName}`,
          'recognized'
        );

        this.showIntegratedEmployeeDisplay(result.data);
        this.playSuccessSound();

        // ENHANCED: Clear status after 3 seconds
        setTimeout(() => {
          if (this.isActive) {
            this.showStatus('✓ Ready for next scan', 'detecting');
          }
        }, 3000);

      } else {
        // Handle error cases
        this.showStatus(`❌ Error: ${result.error}`, 'error');
        this.playErrorSound();
      }

    } catch (error) {
      console.error('Error processing barcode:', error);
      this.showStatus(`❌ Failed: ${error.message}`, 'error');
      this.playErrorSound();
    } finally {
      // ENHANCED: Release lock after 3 seconds (reduced from processingLockDuration)
      setTimeout(() => {
        this.isProcessingAttendance = false;
        console.log(`🔓 Processing lock released`);
      }, 3000);
    }
  }

  getClockActionText(clockType) {
    if (!clockType) return 'Clocked';

    const actions = {
      'morning_in': 'Morning Clock In',
      'morning_out': 'Morning Clock Out',
      'afternoon_in': 'Afternoon Clock In',
      'afternoon_out': 'Afternoon Clock Out',
      'evening_in': 'Evening Clock In',
      'evening_out': 'Evening Clock Out',
      'overtime_in': 'Overtime Clock In',
      'overtime_out': 'Overtime Clock Out'
    };

    return actions[clockType] || 'Clocked';
  }

  getTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return `${seconds} second${seconds !== 1 ? 's' : ''}`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;

    const hours = Math.floor(minutes / 60);
    return `${hours} hour${hours !== 1 ? 's' : ''}`;
  }

  playSuccessSound() {
    try {
      const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuFzvLZizcIHGm98OScTQwOUKrm8K1gGgU7k9byz3osBSh+zPLaizsIGGS57OihUhEJTKXh8bJeGAU7k9byz3osBSh+zPLaizsIGGS57OihUhEJTKXh8bJeGAU7k9byz3osBSh+zPLaizsIGGS57OihUhEJTKXh8bJeGAU=');
      audio.volume = 0.5;
      audio.play().catch(err => console.log('Could not play success sound:', err));
    } catch (error) {
      // Sound playback failed, ignore
    }
  }

  playErrorSound() {
    try {
      const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQoGAAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA');
      audio.volume = 0.3;
      audio.play().catch(err => console.log('Could not play error sound:', err));
    } catch (error) {
      // Sound playback failed, ignore
    }
  }

  showStatusDebounced(message, type = 'info', delay = 200) {
    if (this.statusDebounceTimeout) {
      clearTimeout(this.statusDebounceTimeout);
    }

    this.statusDebounceTimeout = setTimeout(() => {
      this.showStatus(message, type);
    }, delay);
  }

  showStatus(message, type = 'info') {
    if (!this.statusElement) return;

    this.statusElement.className = `status-bar ${type}`;
    const statusText = this.statusElement.querySelector('.status-text');
    if (statusText) {
      statusText.textContent = message;
    }
  }

  showToast(message, type = 'info') {
    // Remove existing toast if any
    const existingToast = document.querySelector('.face-recognition-toast');
    if (existingToast) {
      existingToast.remove();
    }

    // Create toast element
    const toast = document.createElement('div');
    toast.className = `face-recognition-toast toast-${type}`;
    toast.innerHTML = `
    <div class="toast-content">
      <span class="toast-icon">${type === 'error' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️'}</span>
      <span class="toast-message">${message}</span>
    </div>
  `;

    document.body.appendChild(toast);

    // Trigger animation
    setTimeout(() => toast.classList.add('show'), 10);

    // Auto remove after 4 seconds
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  async show() {
    if (!this.initializationStarted) {
      await this.init();
    }

    if (this.container) {
      this.container.classList.remove('hidden');
    }

    this.startCurrentTimeDisplay();
    this.startAutoCloseCountdown();
    this.initializeBarcodeScanner();

    // Focus barcode input after a short delay
    setTimeout(() => {
      const barcodeInput = document.getElementById('barcodeInput');
      if (barcodeInput) {
        barcodeInput.focus();
        console.log('✓ Barcode input focused');
      }
    }, 300);
  }

  hide() {
    this.stopRecognition();

    // Stop current time display
    this.stopCurrentTimeDisplay();

    // Clear auto-close countdown
    this.stopAutoCloseCountdown();

    if (this.container) {
      this.container.classList.add('hidden');
    }

    this.clearScanLog();
    this.clearIntegratedEmployeeDisplay();
    console.log('Face recognition closed - scan log cleared');
  }

  async refreshEmployeeFaceDescriptors() {
    this.faceDescriptors.clear();
    this.descriptorsLoaded = false;
    this.faceMatcherDirty = true;
    this.cachedFaceMatcher = null;
    await this.loadEmployeeFaceDescriptorsFromDB();
  }

  async refreshSingleDescriptor(uid) {
    try {
      const uidString = String(uid);

      const employeesResult = await this.electronAPI.getEmployees();
      if (!employeesResult.success) return false;

      const employee = employeesResult.data.find(e => String(e.uid) === uidString);
      if (!employee?.face_descriptor) return false;

      const descriptorArray = JSON.parse(employee.face_descriptor);
      if (!Array.isArray(descriptorArray) || descriptorArray.length !== 128) {
        return false;
      }

      const descriptor = new Float32Array(descriptorArray);
      this.faceDescriptors.set(uidString, {
        descriptor: descriptor,
        employee: employee,
        name: `${employee.first_name} ${employee.last_name}`
      });

      this.faceMatcherDirty = true;

      this.updateLoadedCount(this.faceDescriptors.size);

      console.log(`✓ Refreshed: ${employee.first_name} ${employee.last_name}`);
      return true;

    } catch (error) {
      console.error('Error refreshing descriptor:', error);
      return false;
    }
  }

  destroy() {
    this.stopRecognition();

    if (this.statusDebounceTimeout) {
      clearTimeout(this.statusDebounceTimeout);
    }

    if (this.cooldownCleanupInterval) {
      clearInterval(this.cooldownCleanupInterval);
    }

    if (this.employeeDisplayTimeout) {
      clearTimeout(this.employeeDisplayTimeout);
    }

    if (this.container) {
      this.container.remove();
    }

    this.faceDescriptors.clear();
    this.employeeCooldowns.clear();
    this.barcodeCooldowns.clear();
    this.cachedFaceMatcher = null;
    console.log('FaceRecognitionManager destroyed');
  }
}

window.FaceRecognitionManager = FaceRecognitionManager;