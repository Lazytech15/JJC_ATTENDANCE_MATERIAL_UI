// FaceRecognitionManager.js - Optimized Face Recognition for Electron Attendance System
class FaceRecognitionManager {
  constructor(attendanceApp) {
    this.attendanceApp = attendanceApp;
    this.electronAPI = window.electronAPI;
    
    // Face-api.js configuration
    this.modelsLoaded = false;
    this.modelPath = 'models';
    this.profilesPath = null;
    
    // Face recognition state
    this.isActive = false;
    this.videoStream = null;
    this.videoElement = null;
    this.canvasElement = null;
    this.detectionInterval = null;
    
    // Recognition settings
    this.detectionIntervalMs = 1000;
    this.confidenceThreshold = 0.6;
    this.faceDescriptors = new Map();
    
    // Recognition state
    this.lastRecognizedUID = null;
    this.lastRecognitionTime = 0;
    this.recognitionCooldown = 5000;
    
    // DOM elements
    this.container = null;
    this.statusElement = null;
    
    // Lazy loading flags
    this.initializationStarted = false;
    this.descriptorsLoaded = false;
    
    // REMOVED: this.init() - Don't auto-initialize on construction
    console.log('FaceRecognitionManager created (lazy initialization)');
  }

  // Lazy initialization - only runs when user opens face recognition
  async init() {
    if (this.initializationStarted) {
      return; // Already initializing or initialized
    }
    
    this.initializationStarted = true;
    
    try {
      console.log('Starting FaceRecognitionManager initialization...');
      
      // Get profiles path
      const pathResult = await this.electronAPI.invoke('get-profiles-path');
      if (pathResult.success) {
        this.profilesPath = pathResult.path;
      }
      
      // Create UI first (fast)
      this.createFaceRecognitionUI();
      this.showStatus('Initializing face recognition...', 'info');
      
      // Force WebGL backend (fix the WebGL error)
      await this.setTensorFlowBackend();
      
      // Load models (slow - show progress)
      await this.loadModels();
      
      // Load descriptors in background (don't block UI)
      this.loadEmployeeFaceDescriptorsAsync();
      
      console.log('FaceRecognitionManager initialized');
    } catch (error) {
      console.error('Failed to initialize FaceRecognitionManager:', error);
      this.showStatus('Initialization failed: ' + error.message, 'error');
    }
  }

  // Force CPU backend to avoid WebGL issues
  async setTensorFlowBackend() {
    try {
      if (typeof faceapi === 'undefined') {
        await this.waitForFaceApi();
      }
      
      // Try to set CPU backend explicitly to avoid WebGL errors
      if (faceapi.tf && faceapi.tf.setBackend) {
        console.log('Setting TensorFlow backend to CPU...');
        await faceapi.tf.setBackend('cpu');
        await faceapi.tf.ready();
        console.log('✓ TensorFlow backend set to CPU');
      }
    } catch (error) {
      console.warn('Could not set TensorFlow backend:', error);
      // Continue anyway - it will fall back to CPU automatically
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

  async loadModels() {
    try {
      if (typeof faceapi === 'undefined') {
        await this.waitForFaceApi();
      }
      
      this.showStatus('Loading AI models (1/3)...', 'info');
      await faceapi.nets.ssdMobilenetv1.loadFromUri(this.modelPath);
      
      this.showStatus('Loading AI models (2/3)...', 'info');
      await faceapi.nets.faceLandmark68Net.loadFromUri(this.modelPath);
      
      this.showStatus('Loading AI models (3/3)...', 'info');
      await faceapi.nets.faceRecognitionNet.loadFromUri(this.modelPath);
      
      this.modelsLoaded = true;
      console.log('✓ Face-api.js models loaded');
      this.showStatus('AI models loaded successfully', 'success');
      
    } catch (error) {
      console.error('Error loading models:', error);
      this.showStatus('Failed to load AI models', 'error');
      throw error;
    }
  }

  // Async loading - doesn't block UI
  async loadEmployeeFaceDescriptorsAsync() {
    try {
      this.showStatus('Loading employee profiles in background...', 'info');
      
      const employeesResult = await this.electronAPI.getEmployees();
      if (!employeesResult.success || !employeesResult.data) {
        this.showStatus('No employee profiles found', 'info');
        this.descriptorsLoaded = true;
        return;
      }
      
      const employees = employeesResult.data;
      let loadedCount = 0;
      let failedCount = 0;
      
      // Process in batches to avoid blocking
      const batchSize = 5;
      for (let i = 0; i < employees.length; i += batchSize) {
        const batch = employees.slice(i, i + batchSize);
        
        await Promise.all(
          batch.map(async (employee) => {
            try {
              const descriptor = await this.loadEmployeeFaceDescriptor(employee);
              if (descriptor) {
                // Convert UID to string for face-api.js
                const uidString = String(employee.uid);
                this.faceDescriptors.set(uidString, {
                  descriptor: descriptor,
                  employee: employee,
                  name: `${employee.first_name} ${employee.last_name}`
                });
                loadedCount++;
              } else {
                failedCount++;
              }
            } catch (error) {
              failedCount++;
            }
          })
        );
        
        // Update progress
        const progress = Math.round(((i + batch.length) / employees.length) * 100);
        this.showStatus(`Loading profiles: ${loadedCount} loaded (${progress}%)`, 'info');
        document.getElementById('facesLoadedCount').textContent = loadedCount;
        
        // Small delay to prevent blocking
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      this.descriptorsLoaded = true;
      console.log(`✓ Loaded ${loadedCount} face descriptors (${failedCount} failed)`);
      this.showStatus(`Ready: ${loadedCount} profiles loaded`, 'success');
      document.getElementById('facesLoadedCount').textContent = loadedCount;
      
    } catch (error) {
      console.error('Error loading descriptors:', error);
      this.showStatus('Error loading employee profiles', 'error');
      this.descriptorsLoaded = true;
    }
  }

  async loadEmployeeFaceDescriptor(employee) {
    try {
      const pathResult = await this.electronAPI.getLocalProfilePath(employee.uid);
      
      if (!pathResult.success || !pathResult.path) {
        return null;
      }
      
      const imagePath = pathResult.path;
      // Generate descriptor cache path (same location as image, with .json extension)
      const descriptorPath = imagePath.replace(/\.(jpg|jpeg|png|gif|webp)$/i, '.descriptor.json');
      
      // Try to load cached descriptor first
      try {
        const cachedDescriptor = await this.electronAPI.invoke('read-face-descriptor', descriptorPath);
        if (cachedDescriptor.success && cachedDescriptor.data) {
          console.log(`✓ Loaded cached descriptor for ${employee.uid}`);
          // Convert array back to Float32Array
          return new Float32Array(cachedDescriptor.data);
        }
      } catch (error) {
        // Cache doesn't exist, will generate new one
      }
      
      // Generate new descriptor from image
      console.log(`Generating descriptor for ${employee.uid}...`);
      const img = await faceapi.fetchImage(imagePath);
      const detection = await faceapi
        .detectSingleFace(img)
        .withFaceLandmarks()
        .withFaceDescriptor();
      
      if (!detection) {
        console.warn(`No face detected in profile image for ${employee.uid}`);
        return null;
      }
      
      // Save descriptor to cache
      try {
        await this.electronAPI.invoke('save-face-descriptor', {
          path: descriptorPath,
          descriptor: Array.from(detection.descriptor) // Convert Float32Array to regular array for JSON
        });
        console.log(`✓ Cached descriptor for ${employee.uid}`);
      } catch (error) {
        console.warn(`Failed to cache descriptor for ${employee.uid}:`, error);
        // Continue anyway, just won't be cached
      }
      
      return detection.descriptor;
      
    } catch (error) {
      console.warn(`Error loading face descriptor for ${employee.uid}:`, error);
      return null;
    }
  }

  createFaceRecognitionUI() {
    this.container = document.createElement('div');
    this.container.id = 'faceRecognitionContainer';
    this.container.className = 'face-recognition-container hidden';
    this.container.innerHTML = `
      <div class="face-recognition-header">
        <h3>Face Recognition</h3>
        <button id="closeFaceRecognition" class="close-btn">✕</button>
      </div>
      
      <div class="face-recognition-content">
        <div class="video-wrapper">
          <video id="faceRecognitionVideo" autoplay muted playsinline></video>
          <canvas id="faceRecognitionCanvas"></canvas>
        </div>
        
        <div class="face-recognition-status" id="faceRecognitionStatus">
          Ready to scan faces...
        </div>
        
        <div class="face-recognition-info">
          <div class="info-item">
            <span class="info-label">Profiles Loaded:</span>
            <span class="info-value" id="facesLoadedCount">0</span>
          </div>
          <div class="info-item">
            <span class="info-label">Detection Status:</span>
            <span class="info-value" id="detectionStatus">Inactive</span>
          </div>
        </div>
        
        <div class="face-recognition-controls">
          <button id="startFaceRecognition" class="btn btn-primary">
            📷 Start Recognition
          </button>
          <button id="stopFaceRecognition" class="btn btn-secondary" disabled>
            ⏹️ Stop Recognition
          </button>
        </div>
      </div>
    `;
    
    document.body.appendChild(this.container);
    
    this.videoElement = document.getElementById('faceRecognitionVideo');
    this.canvasElement = document.getElementById('faceRecognitionCanvas');
    this.statusElement = document.getElementById('faceRecognitionStatus');
    
    this.setupEventListeners();
    this.addStyles();
    
    document.getElementById('facesLoadedCount').textContent = this.faceDescriptors.size;
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
        width: 90%;
        max-width: 700px;
        background: white;
        border-radius: 12px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.3);
        z-index: 9999;
        display: flex;
        flex-direction: column;
        max-height: 90vh;
      }
      
      .face-recognition-container.hidden {
        display: none;
      }
      
      .face-recognition-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 20px;
        border-bottom: 1px solid #e5e7eb;
      }
      
      .face-recognition-header h3 {
        margin: 0;
        font-size: 20px;
        color: #1f2937;
      }
      
      .close-btn {
        background: none;
        border: none;
        font-size: 24px;
        color: #6b7280;
        cursor: pointer;
        padding: 0;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        transition: all 0.2s;
      }
      
      .close-btn:hover {
        background: #f3f4f6;
        color: #1f2937;
      }
      
      .face-recognition-content {
        padding: 20px;
        overflow-y: auto;
      }
      
      .video-wrapper {
        position: relative;
        width: 100%;
        background: #000;
        border-radius: 8px;
        overflow: hidden;
        margin-bottom: 20px;
      }
      
      #faceRecognitionVideo {
        width: 100%;
        height: auto;
        display: block;
      }
      
      #faceRecognitionCanvas {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
      }
      
      .face-recognition-status {
        padding: 16px;
        background: #f3f4f6;
        border-radius: 8px;
        text-align: center;
        font-weight: 500;
        margin-bottom: 20px;
        color: #1f2937;
      }
      
      .face-recognition-status.detecting {
        background: #dbeafe;
        color: #1e40af;
      }
      
      .face-recognition-status.recognized {
        background: #dcfce7;
        color: #166534;
      }
      
      .face-recognition-status.error {
        background: #fee2e2;
        color: #991b1b;
      }
      
      .face-recognition-info {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
        margin-bottom: 20px;
      }
      
      .info-item {
        padding: 12px;
        background: #f9fafb;
        border-radius: 6px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      
      .info-label {
        font-size: 12px;
        color: #6b7280;
        font-weight: 500;
      }
      
      .info-value {
        font-size: 16px;
        color: #1f2937;
        font-weight: 600;
      }
      
      .face-recognition-controls {
        display: flex;
        gap: 12px;
      }
      
      .face-recognition-controls .btn {
        flex: 1;
        padding: 12px 24px;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .btn-primary {
        background: #3b82f6;
        color: white;
      }
      
      .btn-primary:hover:not(:disabled) {
        background: #2563eb;
      }
      
      .btn-secondary {
        background: #ef4444;
        color: white;
      }
      
      .btn-secondary:hover:not(:disabled) {
        background: #dc2626;
      }
      
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `;
    
    document.head.appendChild(style);
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
      this.showStatus('Employee profiles still loading...', 'info');
      return;
    }
    
    if (this.faceDescriptors.size === 0) {
      this.showStatus('No employee profiles available', 'error');
      return;
    }
    
    try {
      this.videoStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user'
        }
      });
      
      this.videoElement.srcObject = this.videoStream;
      this.isActive = true;
      
      document.getElementById('startFaceRecognition').disabled = true;
      document.getElementById('stopFaceRecognition').disabled = false;
      document.getElementById('detectionStatus').textContent = 'Active';
      this.showStatus('Face recognition active - position your face in frame', 'detecting');
      
      this.startDetectionLoop();
      
    } catch (error) {
      console.error('Error starting recognition:', error);
      this.showStatus('Failed to access camera: ' + error.message, 'error');
    }
  }

  stopRecognition() {
    this.isActive = false;
    
    if (this.detectionInterval) {
      clearInterval(this.detectionInterval);
      this.detectionInterval = null;
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
    
    document.getElementById('startFaceRecognition').disabled = false;
    document.getElementById('stopFaceRecognition').disabled = true;
    document.getElementById('detectionStatus').textContent = 'Inactive';
    this.showStatus('Face recognition stopped', 'info');
  }

  startDetectionLoop() {
    this.detectionInterval = setInterval(async () => {
      if (!this.isActive || !this.videoElement) return;
      
      try {
        await this.detectAndRecognizeFaces();
      } catch (error) {
        console.error('Detection error:', error);
      }
    }, this.detectionIntervalMs);
  }

  async detectAndRecognizeFaces() {
    if (!this.videoElement || this.videoElement.paused) return;
    
    const displaySize = {
      width: this.videoElement.videoWidth,
      height: this.videoElement.videoHeight
    };
    
    const detections = await faceapi
      .detectAllFaces(this.videoElement)
      .withFaceLandmarks()
      .withFaceDescriptors();
    
    if (detections.length === 0) {
      this.clearCanvas();
      this.showStatus('No face detected - move closer to camera', 'detecting');
      return;
    }
    
    const resizedDetections = faceapi.resizeResults(detections, displaySize);
    
    this.clearCanvas();
    
    const labeledDescriptors = Array.from(this.faceDescriptors.entries()).map(
      ([uid, data]) => new faceapi.LabeledFaceDescriptors(uid, [data.descriptor])
    );
    
    const faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, this.confidenceThreshold);
    
    let recognized = false;
    
    resizedDetections.forEach(detection => {
      const bestMatch = faceMatcher.findBestMatch(detection.descriptor);
      
      const box = detection.detection.box;
      this.drawDetectionBox(box, bestMatch);
      
      if (bestMatch.label !== 'unknown') {
        recognized = true;
        const employeeData = this.faceDescriptors.get(bestMatch.label);
        
        if (employeeData) {
          this.handleRecognition(employeeData, bestMatch.distance);
        }
      }
    });
    
    if (!recognized) {
      this.showStatus('Face detected but not recognized', 'detecting');
    }
  }

  drawDetectionBox(box, match) {
    const ctx = this.canvasElement.getContext('2d');
    const isRecognized = match.label !== 'unknown';
    
    ctx.strokeStyle = isRecognized ? '#22c55e' : '#3b82f6';
    ctx.lineWidth = 3;
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    
    if (isRecognized) {
      const employeeData = this.faceDescriptors.get(match.label);
      const label = employeeData ? employeeData.name : match.label;
      const confidence = Math.round((1 - match.distance) * 100);
      
      ctx.fillStyle = 'rgba(34, 197, 94, 0.9)';
      ctx.fillRect(box.x, box.y + box.height + 5, box.width, 25);
      
      ctx.fillStyle = 'white';
      ctx.font = '14px Arial';
      ctx.fillText(`${label} (${confidence}%)`, box.x + 5, box.y + box.height + 20);
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
    
    // Convert to string for comparison
    const uidString = String(employeeData.employee.uid);
    
    if (
      this.lastRecognizedUID === uidString &&
      currentTime - this.lastRecognitionTime < this.recognitionCooldown
    ) {
      return;
    }
    
    this.lastRecognizedUID = uidString;
    this.lastRecognitionTime = currentTime;
    
    this.showStatus(
      `Recognized: ${employeeData.name} (${confidence}% confidence)`,
      'recognized'
    );
    
    await this.processAttendance(employeeData.employee);
  }

  async processAttendance(employee) {
    try {
      const result = await this.electronAPI.clockAttendance({
        input: employee.uid,
        inputType: 'barcode'
      });
      
      if (result.success) {
        if (this.attendanceApp && this.attendanceApp.showEmployeeDisplay) {
          this.attendanceApp.showEmployeeDisplay(result.data);
        }
        
        this.showStatus(
          `✓ Attendance recorded for ${employee.first_name} ${employee.last_name}`,
          'recognized'
        );
        
        setTimeout(() => {
          if (this.isActive) {
            this.showStatus('Ready for next scan...', 'detecting');
          }
        }, 3000);
        
      } else {
        this.showStatus(`Error: ${result.error}`, 'error');
      }
      
    } catch (error) {
      console.error('Error processing attendance:', error);
      this.showStatus('Failed to record attendance', 'error');
    }
  }

  showStatus(message, type = 'info') {
    if (!this.statusElement) return;
    
    this.statusElement.textContent = message;
    this.statusElement.className = `face-recognition-status ${type}`;
  }

  async show() {
    // Initialize on first show
    if (!this.initializationStarted) {
      await this.init();
    }
    
    if (this.container) {
      this.container.classList.remove('hidden');
    }
  }

  hide() {
    this.stopRecognition();
    if (this.container) {
      this.container.classList.add('hidden');
    }
  }

  async refreshEmployeeFaceDescriptors(forceRegenerate = false) {
    this.faceDescriptors.clear();
    
    if (forceRegenerate) {
      // Clear all cached descriptors
      try {
        const result = await this.electronAPI.invoke('clear-all-face-descriptors', this.profilesPath);
        if (result.success) {
          console.log(`Cleared ${result.deletedCount} cached descriptors`);
        }
      } catch (error) {
        console.warn('Failed to clear descriptor cache:', error);
      }
    }
    
    this.descriptorsLoaded = false;
    await this.loadEmployeeFaceDescriptorsAsync();
  }

  // Add method to refresh single employee descriptor
  async refreshSingleDescriptor(uid, forceRegenerate = false) {
    try {
      const uidString = String(uid);
      
      if (forceRegenerate) {
        // Delete cached descriptor
        const pathResult = await this.electronAPI.getLocalProfilePath(uid);
        if (pathResult.success && pathResult.path) {
          const descriptorPath = pathResult.path.replace(/\.(jpg|jpeg|png|gif|webp)$/i, '.descriptor.json');
          await this.electronAPI.invoke('delete-face-descriptor', descriptorPath);
        }
      }
      
      // Get employee data
      const employeesResult = await this.electronAPI.getEmployees();
      if (!employeesResult.success) return false;
      
      const employee = employeesResult.data.find(e => String(e.uid) === uidString);
      if (!employee) return false;
      
      // Load new descriptor
      const descriptor = await this.loadEmployeeFaceDescriptor(employee);
      
      if (descriptor) {
        this.faceDescriptors.set(uidString, {
          descriptor: descriptor,
          employee: employee,
          name: `${employee.first_name} ${employee.last_name}`
        });
        
        // Update UI count
        if (document.getElementById('facesLoadedCount')) {
          document.getElementById('facesLoadedCount').textContent = this.faceDescriptors.size;
        }
        
        console.log(`✓ Refreshed descriptor for ${employee.first_name} ${employee.last_name}`);
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('Error refreshing single descriptor:', error);
      return false;
    }
  }

  destroy() {
    this.stopRecognition();
    
    if (this.container) {
      this.container.remove();
    }
    
    this.faceDescriptors.clear();
    console.log('FaceRecognitionManager destroyed');
  }
}

window.FaceRecognitionManager = FaceRecognitionManager;