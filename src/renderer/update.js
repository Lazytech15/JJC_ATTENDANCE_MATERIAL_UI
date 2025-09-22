// Update Notification System for HTML Interface
// Add this to your existing app.js or create a separate update.js file

class UpdateNotificationSystem {
  constructor() {
    this.currentStatus = null;
    this.downloadProgress = { percent: 0 };
    this.statusUnsubscribe = null;
    this.progressUnsubscribe = null;
    this.isInitialized = false;
    
    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.init());
    } else {
      this.init();
    }
  }

  init() {
    if (this.isInitialized || !window.electronAPI?.updater) {
      return;
    }

    console.log('Initializing Update Notification System...');
    
    // Create update UI elements
    this.createUpdateUI();
    
    // Set up event listeners
    this.setupEventListeners();
    
    // Get initial app version
    this.getAppVersion();
    
    this.isInitialized = true;
    console.log('Update Notification System initialized');
  }

  createUpdateUI() {
    // Create update notification container
    const updateContainer = document.createElement('div');
    updateContainer.id = 'updateNotificationContainer';
    updateContainer.className = 'update-notification-container';
    updateContainer.innerHTML = `
      <!-- Update Status Toast -->
      <div id="updateStatusToast" class="update-toast">
        <div class="update-toast-content">
          <div class="update-icon" id="updateIcon">🔄</div>
          <div class="update-info">
            <div class="update-title" id="updateTitle">Checking for updates...</div>
            <div class="update-message" id="updateMessage"></div>
          </div>
          <button class="update-close-btn" id="updateCloseBtn">&times;</button>
        </div>
        <div class="update-progress-bar" id="updateProgressBar">
          <div class="update-progress-fill" id="updateProgressFill"></div>
        </div>
      </div>

      <!-- Update Modal -->
      <div id="updateModal" class="update-modal">
        <div class="update-modal-content">
          <div class="update-modal-header">
            <h3 id="updateModalTitle">Update Available</h3>
            <button class="close-btn" id="updateModalClose">&times;</button>
          </div>
          <div class="update-modal-body">
            <div class="update-details" id="updateDetails">
              <p>A new version of the application is available.</p>
            </div>
            <div class="update-progress-section" id="updateProgressSection" style="display: none;">
              <div class="progress-info">
                <span id="progressText">Downloading update...</span>
                <span id="progressPercent">0%</span>
              </div>
              <div class="progress-bar">
                <div class="progress-fill" id="modalProgressFill"></div>
              </div>
              <div class="progress-stats">
                <span id="downloadSpeed">0 KB/s</span>
                <span id="downloadSize">0 MB / 0 MB</span>
              </div>
            </div>
          </div>
          <div class="update-modal-actions" id="updateModalActions">
            <button class="btn btn-primary" id="downloadUpdateBtn">Download Now</button>
            <button class="btn btn-secondary" id="laterBtn">Later</button>
          </div>
        </div>
      </div>
    `;

    // Add CSS styles
    this.addUpdateStyles();

    // Append to body
    document.body.appendChild(updateContainer);

    // Set up click handlers
    this.setupClickHandlers();
  }

  addUpdateStyles() {
    const styles = `
      <style>
        .update-notification-container {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          z-index: 9999;
        }

        .update-toast {
          position: fixed;
          top: 20px;
          right: 20px;
          background: white;
          border-radius: 12px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
          min-width: 320px;
          max-width: 420px;
          opacity: 0;
          transform: translateX(100%);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          pointer-events: auto;
          border-left: 4px solid #1976d2;
        }

        .update-toast.show {
          opacity: 1;
          transform: translateX(0);
        }

        .update-toast.success {
          border-left-color: #4caf50;
        }

        .update-toast.error {
          border-left-color: #f44336;
        }

        .update-toast.warning {
          border-left-color: #ff9800;
        }

        .update-toast-content {
          display: flex;
          align-items: center;
          padding: 16px;
          gap: 12px;
        }

        .update-icon {
          font-size: 24px;
          flex-shrink: 0;
        }

        .update-info {
          flex: 1;
          min-width: 0;
        }

        .update-title {
          font-weight: 600;
          color: #212121;
          margin-bottom: 4px;
          font-size: 14px;
        }

        .update-message {
          color: #666;
          font-size: 13px;
          line-height: 1.4;
        }

        .update-close-btn {
          background: none;
          border: none;
          font-size: 20px;
          color: #666;
          cursor: pointer;
          padding: 4px;
          border-radius: 4px;
          flex-shrink: 0;
        }

        .update-close-btn:hover {
          background: #f5f5f5;
        }

        .update-progress-bar {
          height: 3px;
          background: #f5f5f5;
          border-radius: 0 0 12px 12px;
          overflow: hidden;
        }

        .update-progress-fill {
          height: 100%;
          background: #1976d2;
          width: 0%;
          transition: width 0.3s ease;
        }

        .update-modal {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.6);
          display: none;
          align-items: center;
          justify-content: center;
          backdrop-filter: blur(4px);
          pointer-events: auto;
        }

        .update-modal.show {
          display: flex;
        }

        .update-modal-content {
          background: white;
          border-radius: 16px;
          max-width: 500px;
          width: 90%;
          max-height: 80vh;
          overflow: hidden;
          box-shadow: 0 12px 48px rgba(0, 0, 0, 0.3);
        }

        .update-modal-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 24px 24px 16px;
          border-bottom: 1px solid #e0e0e0;
        }

        .update-modal-header h3 {
          margin: 0;
          color: #212121;
          font-size: 20px;
          font-weight: 600;
        }

        .update-modal-body {
          padding: 24px;
        }

        .update-details {
          margin-bottom: 20px;
        }

        .update-details p {
          margin: 8px 0;
          color: #666;
          line-height: 1.5;
        }

        .update-progress-section {
          margin-top: 20px;
        }

        .progress-info {
          display: flex;
          justify-content: space-between;
          margin-bottom: 12px;
          font-size: 14px;
        }

        .progress-bar {
          height: 8px;
          background: #f5f5f5;
          border-radius: 4px;
          overflow: hidden;
          margin-bottom: 12px;
        }

        .progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #1976d2, #42a5f5);
          width: 0%;
          transition: width 0.3s ease;
        }

        .progress-stats {
          display: flex;
          justify-content: space-between;
          font-size: 12px;
          color: #666;
        }

        .update-modal-actions {
          display: flex;
          gap: 12px;
          justify-content: flex-end;
          padding: 16px 24px 24px;
          border-top: 1px solid #e0e0e0;
        }

        .btn {
          padding: 10px 20px;
          border: none;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }

        .btn-primary {
          background: #1976d2;
          color: white;
        }

        .btn-primary:hover {
          background: #1565c0;
        }

        .btn-secondary {
          background: #f5f5f5;
          color: #666;
        }

        .btn-secondary:hover {
          background: #e0e0e0;
        }
      </style>
    `;

    document.head.insertAdjacentHTML('beforeend', styles);
  }

  setupEventListeners() {
    if (!window.electronAPI?.updater) {
      console.warn('Updater API not available');
      return;
    }

    // Listen to updater status changes
    this.statusUnsubscribe = window.electronAPI.updater.onStatusUpdate((data) => {
      console.log('Update status:', data);
      this.currentStatus = data;
      this.handleStatusUpdate(data);
    });

    // Listen to download progress updates
    this.progressUnsubscribe = window.electronAPI.updater.onProgressUpdate((data) => {
      console.log('Download progress:', data);
      this.downloadProgress = data;
      this.updateProgressUI(data);
    });
  }

  setupClickHandlers() {
    // Close toast
    document.getElementById('updateCloseBtn')?.addEventListener('click', () => {
      this.hideToast();
    });

    // Close modal
    document.getElementById('updateModalClose')?.addEventListener('click', () => {
      this.hideModal();
    });

    // Download update button
    document.getElementById('downloadUpdateBtn')?.addEventListener('click', async () => {
      await this.downloadUpdate();
    });

    // Later button
    document.getElementById('laterBtn')?.addEventListener('click', () => {
      this.hideModal();
    });

    // Auto-hide toast after 5 seconds
    let autoHideTimeout;
    const toast = document.getElementById('updateStatusToast');
    if (toast) {
      toast.addEventListener('transitionend', () => {
        if (toast.classList.contains('show')) {
          clearTimeout(autoHideTimeout);
          autoHideTimeout = setTimeout(() => {
            if (this.currentStatus?.status !== 'downloading') {
              this.hideToast();
            }
          }, 5000);
        }
      });
    }
  }

  handleStatusUpdate(data) {
    const { status, message, version, error } = data;

    switch (status) {
      case 'checking':
        this.showToast('🔄', 'Checking for updates...', message, 'info');
        break;

      case 'available':
        this.showToast('📥', 'Update Available!', `Version ${version} is ready to download`, 'success');
        this.showUpdateModal(data);
        break;

      case 'not-available':
        this.showToast('✅', 'Up to date', 'You are using the latest version', 'success');
        break;

      case 'downloading':
        this.showToast('⬇️', 'Downloading Update...', `${this.downloadProgress.percent || 0}% complete`, 'info', false);
        this.showProgressInModal();
        break;

      case 'downloaded':
        this.showToast('✅', 'Update Downloaded!', 'Ready to install. Restart to apply.', 'success');
        this.showRestartModal(data);
        break;

      case 'error':
        this.showToast('❌', 'Update Error', error || message || 'Failed to check for updates', 'error');
        break;

      case 'postponed':
        this.showToast('⏰', 'Update Postponed', 'Update will be available next time', 'info');
        break;

      case 'ready-to-install':
        this.showToast('🔄', 'Ready to Install', 'Update will install on next restart', 'warning');
        break;

      default:
        console.log('Unknown update status:', status);
    }
  }

  updateProgressUI(progress) {
    const { percent, bytesPerSecond, transferred, total } = progress;

    // Update toast progress
    const progressFill = document.getElementById('updateProgressFill');
    if (progressFill) {
      progressFill.style.width = `${percent}%`;
    }

    const updateMessage = document.getElementById('updateMessage');
    if (updateMessage) {
      updateMessage.textContent = `${Math.round(percent)}% complete`;
    }

    // Update modal progress
    const modalProgressFill = document.getElementById('modalProgressFill');
    if (modalProgressFill) {
      modalProgressFill.style.width = `${percent}%`;
    }

    const progressPercent = document.getElementById('progressPercent');
    if (progressPercent) {
      progressPercent.textContent = `${Math.round(percent)}%`;
    }

    const downloadSpeed = document.getElementById('downloadSpeed');
    if (downloadSpeed && bytesPerSecond) {
      downloadSpeed.textContent = this.formatBytes(bytesPerSecond) + '/s';
    }

    const downloadSize = document.getElementById('downloadSize');
    if (downloadSize && transferred && total) {
      downloadSize.textContent = `${this.formatBytes(transferred)} / ${this.formatBytes(total)}`;
    }
  }

  showToast(icon, title, message, type = 'info', autoHide = true) {
    const toast = document.getElementById('updateStatusToast');
    const iconEl = document.getElementById('updateIcon');
    const titleEl = document.getElementById('updateTitle');
    const messageEl = document.getElementById('updateMessage');

    if (!toast || !iconEl || !titleEl || !messageEl) return;

    iconEl.textContent = icon;
    titleEl.textContent = title;
    messageEl.textContent = message;

    // Reset classes
    toast.className = 'update-toast';
    toast.classList.add('show', type);

    if (autoHide && type !== 'downloading') {
      setTimeout(() => this.hideToast(), 5000);
    }
  }

  hideToast() {
    const toast = document.getElementById('updateStatusToast');
    if (toast) {
      toast.classList.remove('show');
    }
  }

  showUpdateModal(data) {
    const modal = document.getElementById('updateModal');
    const title = document.getElementById('updateModalTitle');
    const details = document.getElementById('updateDetails');

    if (!modal || !title || !details) return;

    title.textContent = `Update Available - v${data.version}`;
    
    let detailsHTML = `<p>A new version (${data.version}) is available!</p>`;
    
    if (data.releaseNotes) {
      detailsHTML += `<div style="margin-top: 12px;"><strong>What's new:</strong></div>`;
      detailsHTML += `<div style="background: #f5f5f5; padding: 12px; border-radius: 6px; margin-top: 6px; font-size: 13px; line-height: 1.4;">${data.releaseNotes}</div>`;
    }

    if (data.releaseDate) {
      detailsHTML += `<p style="margin-top: 12px; font-size: 12px; color: #666;">Released: ${new Date(data.releaseDate).toLocaleDateString()}</p>`;
    }

    details.innerHTML = detailsHTML;

    // Show modal
    modal.classList.add('show');
  }

  showProgressInModal() {
    const progressSection = document.getElementById('updateProgressSection');
    const actions = document.getElementById('updateModalActions');
    
    if (progressSection) {
      progressSection.style.display = 'block';
    }
    
    if (actions) {
      actions.style.display = 'none';
    }
  }

  showRestartModal(data) {
    const modal = document.getElementById('updateModal');
    const title = document.getElementById('updateModalTitle');
    const details = document.getElementById('updateDetails');
    const actions = document.getElementById('updateModalActions');
    const progressSection = document.getElementById('updateProgressSection');

    if (!modal || !title || !details || !actions) return;

    title.textContent = 'Update Ready to Install';
    details.innerHTML = `
      <p>The update has been downloaded successfully!</p>
      <p>The application will restart to apply the update. Would you like to restart now?</p>
    `;

    // Hide progress section
    if (progressSection) {
      progressSection.style.display = 'none';
    }

    // Update action buttons
    actions.innerHTML = `
      <button class="btn btn-primary" id="restartNowBtn">Restart Now</button>
      <button class="btn btn-secondary" id="restartLaterBtn">Later</button>
    `;

    // Set up new button handlers
    document.getElementById('restartNowBtn')?.addEventListener('click', async () => {
      await this.quitAndInstall();
    });

    document.getElementById('restartLaterBtn')?.addEventListener('click', () => {
      this.hideModal();
    });

    // Show modal
    modal.classList.add('show');
  }

  hideModal() {
    const modal = document.getElementById('updateModal');
    if (modal) {
      modal.classList.remove('show');
    }
  }

  async getAppVersion() {
    try {
      if (window.electronAPI?.updater?.getAppVersion) {
        const versionInfo = await window.electronAPI.updater.getAppVersion();
        console.log('App version:', versionInfo);
        
        // Display version in settings if there's a version element
        const versionElement = document.getElementById('appVersion');
        if (versionElement && versionInfo.version) {
          versionElement.textContent = `v${versionInfo.version}${versionInfo.isDev ? ' (Development)' : ''}`;
        }
      }
    } catch (error) {
      console.error('Failed to get app version:', error);
    }
  }

  async checkForUpdates() {
    try {
      if (window.electronAPI?.updater?.checkForUpdates) {
        const result = await window.electronAPI.updater.checkForUpdates();
        console.log('Manual update check result:', result);
        
        if (!result.success) {
          this.showToast('❌', 'Update Check Failed', result.error, 'error');
        }
      }
    } catch (error) {
      console.error('Failed to check for updates:', error);
      this.showToast('❌', 'Update Check Failed', error.message, 'error');
    }
  }

  async downloadUpdate() {
    try {
      if (window.electronAPI?.updater?.downloadUpdate) {
        const result = await window.electronAPI.updater.downloadUpdate();
        console.log('Download update result:', result);
        
        if (!result.success) {
          this.showToast('❌', 'Download Failed', result.error, 'error');
        } else {
          // Hide modal and show progress
          this.hideModal();
          this.showToast('⬇️', 'Downloading Update...', 'Download started', 'info', false);
        }
      }
    } catch (error) {
      console.error('Failed to download update:', error);
      this.showToast('❌', 'Download Failed', error.message, 'error');
    }
  }

  async quitAndInstall() {
    try {
      if (window.electronAPI?.updater?.quitAndInstall) {
        const result = await window.electronAPI.updater.quitAndInstall();
        console.log('Quit and install result:', result);
        
        if (!result.success) {
          this.showToast('❌', 'Installation Failed', result.error, 'error');
        }
      }
    } catch (error) {
      console.error('Failed to quit and install:', error);
      this.showToast('❌', 'Installation Failed', error.message, 'error');
    }
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // Public methods that can be called from your existing app.js
  manualUpdateCheck() {
    this.checkForUpdates();
  }

  // Cleanup method
  destroy() {
    if (this.statusUnsubscribe) {
      this.statusUnsubscribe();
    }
    if (this.progressUnsubscribe) {
      this.progressUnsubscribe();
    }
    
    const container = document.getElementById('updateNotificationContainer');
    if (container) {
      container.remove();
    }
  }
}

// Initialize the update notification system
let updateNotificationSystem;

// Auto-initialize when script loads
if (typeof window !== 'undefined') {
  updateNotificationSystem = new UpdateNotificationSystem();
}

// Expose to global scope for manual usage
window.UpdateNotificationSystem = UpdateNotificationSystem;
window.updateNotificationSystem = updateNotificationSystem;