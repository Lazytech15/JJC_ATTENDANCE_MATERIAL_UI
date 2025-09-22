// Extend your existing settings functionality to include update options
function enhanceSettingsWithUpdater() {
  // Add update section to your existing settings modal
  const settingsModal = document.getElementById('settingsModal');
  const settingsTabs = document.querySelector('.settings-tabs');
  const settingsBody = document.querySelector('.settings-body');

  if (!settingsModal || !settingsTabs || !settingsBody) {
    console.log('Settings modal not found, skipping updater integration');
    return;
  }

  // Add update tab
  const updateTab = document.createElement('button');
  updateTab.className = 'settings-tab';
  updateTab.setAttribute('data-tab', 'updates');
  updateTab.innerHTML = '🔄 Updates';
  settingsTabs.appendChild(updateTab);

  // Add update panel
  const updatePanel = document.createElement('div');
  updatePanel.className = 'settings-panel';
  updatePanel.id = 'updatesPanel';
  updatePanel.innerHTML = `
    <div class="sync-info">
      <h3>🔄 Application Updates</h3>
      
      <div class="form-group">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
          <div style="flex: 1;">
            <strong>Current Version:</strong>
            <span id="currentVersion" style="margin-left: 8px; color: #666;">Loading...</span>
          </div>
          <button class="btn btn-primary" id="checkUpdatesBtn" style="padding: 8px 16px; font-size: 14px;">
            🔍 Check for Updates
          </button>
        </div>
      </div>

      <div class="form-group">
        <label>
          <input type="checkbox" id="autoCheckUpdates" checked style="margin-right: 8px;">
          Automatically check for updates on startup
        </label>
        <div class="help-text">
          The application will check for updates when it starts and notify you if updates are available.
        </div>
      </div>

      <div class="form-group">
        <label>
          <input type="checkbox" id="autoDownloadUpdates" style="margin-right: 8px;">
          Automatically download updates
        </label>
        <div class="help-text">
          Updates will be downloaded automatically in the background. You'll still need to restart to install them.
        </div>
      </div>

      <div id="updateStatusSection" style="margin-top: 20px; padding: 16px; background: #f8f9fa; border-radius: 8px; display: none;">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <span id="updateStatusIcon">ℹ️</span>
          <strong id="updateStatusTitle">Update Status</strong>
        </div>
        <p id="updateStatusMessage" style="margin: 8px 0; color: #666;"></p>
        <div id="updateActions" style="margin-top: 12px; display: none;">
          <button class="btn btn-primary" id="downloadUpdateAction" style="margin-right: 8px;">Download</button>
          <button class="btn btn-primary" id="restartUpdateAction" style="margin-right: 8px;">Restart & Install</button>
          <button class="btn btn-secondary" id="dismissUpdateAction">Dismiss</button>
        </div>
      </div>

      <div class="sync-info-item" style="margin-top: 20px; font-size: 14px; color: #666;">
        <p><strong>Note:</strong> Updates are downloaded from the official GitHub repository. 
        The application will verify the authenticity of updates before installation.</p>
      </div>
    </div>
  `;

  settingsBody.appendChild(updatePanel);

  // Set up update panel event handlers
  setupUpdatePanelHandlers();

  // Enhance existing tab switching functionality
  enhanceTabSwitching();
}

function setupUpdatePanelHandlers() {
  // Load current version
  loadCurrentVersion();

  // Check for updates button
  const checkUpdatesBtn = document.getElementById('checkUpdatesBtn');
  if (checkUpdatesBtn) {
    checkUpdatesBtn.addEventListener('click', async () => {
      checkUpdatesBtn.disabled = true;
      checkUpdatesBtn.innerHTML = '🔄 Checking...';
      
      if (window.updateNotificationSystem) {
        await window.updateNotificationSystem.checkForUpdates();
      }
      
      setTimeout(() => {
        checkUpdatesBtn.disabled = false;
        checkUpdatesBtn.innerHTML = '🔍 Check for Updates';
      }, 2000);
    });
  }

  // Update action buttons
  const downloadBtn = document.getElementById('downloadUpdateAction');
  const restartBtn = document.getElementById('restartUpdateAction');
  const dismissBtn = document.getElementById('dismissUpdateAction');

  if (downloadBtn) {
    downloadBtn.addEventListener('click', async () => {
      if (window.updateNotificationSystem) {
        await window.updateNotificationSystem.downloadUpdate();
      }
    });
  }

  if (restartBtn) {
    restartBtn.addEventListener('click', async () => {
      if (window.updateNotificationSystem) {
        await window.updateNotificationSystem.quitAndInstall();
      }
    });
  }

  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      hideUpdateStatus();
    });
  }

  // Load update preferences
  loadUpdatePreferences();

  // Save preferences on change
  const autoCheckBox = document.getElementById('autoCheckUpdates');
  const autoDownloadBox = document.getElementById('autoDownloadUpdates');

  if (autoCheckBox) {
    autoCheckBox.addEventListener('change', saveUpdatePreferences);
  }

  if (autoDownloadBox) {
    autoDownloadBox.addEventListener('change', saveUpdatePreferences);
  }
}

async function loadCurrentVersion() {
  try {
    if (window.electronAPI?.updater?.getAppVersion) {
      const versionInfo = await window.electronAPI.updater.getAppVersion();
      const versionElement = document.getElementById('currentVersion');
      if (versionElement) {
        versionElement.textContent = `v${versionInfo.version}${versionInfo.isDev ? ' (Development)' : ''}`;
      }
    }
  } catch (error) {
    console.error('Failed to load current version:', error);
    const versionElement = document.getElementById('currentVersion');
    if (versionElement) {
      versionElement.textContent = 'Unknown';
    }
  }
}

function loadUpdatePreferences() {
  const autoCheck = localStorage.getItem('autoCheckUpdates');
  const autoDownload = localStorage.getItem('autoDownloadUpdates');

  const autoCheckBox = document.getElementById('autoCheckUpdates');
  const autoDownloadBox = document.getElementById('autoDownloadUpdates');

  if (autoCheckBox && autoCheck !== null) {
    autoCheckBox.checked = autoCheck === 'true';
  }

  if (autoDownloadBox && autoDownload !== null) {
    autoDownloadBox.checked = autoDownload === 'true';
  }
}

function saveUpdatePreferences() {
  const autoCheckBox = document.getElementById('autoCheckUpdates');
  const autoDownloadBox = document.getElementById('autoDownloadUpdates');

  if (autoCheckBox) {
    localStorage.setItem('autoCheckUpdates', autoCheckBox.checked.toString());
  }

  if (autoDownloadBox) {
    localStorage.setItem('autoDownloadUpdates', autoDownloadBox.checked.toString());
  }
}

function showUpdateStatus(icon, title, message, actions = []) {
  const statusSection = document.getElementById('updateStatusSection');
  const statusIcon = document.getElementById('updateStatusIcon');
  const statusTitle = document.getElementById('updateStatusTitle');
  const statusMessage = document.getElementById('updateStatusMessage');
  const actionsContainer = document.getElementById('updateActions');

  if (!statusSection || !statusIcon || !statusTitle || !statusMessage || !actionsContainer) {
    return;
  }

  statusIcon.textContent = icon;
  statusTitle.textContent = title;
  statusMessage.textContent = message;

  // Show/hide action buttons based on what's needed
  const downloadBtn = document.getElementById('downloadUpdateAction');
  const restartBtn = document.getElementById('restartUpdateAction');
  const dismissBtn = document.getElementById('dismissUpdateAction');

  if (downloadBtn) downloadBtn.style.display = actions.includes('download') ? 'inline-block' : 'none';
  if (restartBtn) restartBtn.style.display = actions.includes('restart') ? 'inline-block' : 'none';
  if (dismissBtn) dismissBtn.style.display = actions.includes('dismiss') ? 'inline-block' : 'none';

  actionsContainer.style.display = actions.length > 0 ? 'block' : 'none';
  statusSection.style.display = 'block';
}

function hideUpdateStatus() {
  const statusSection = document.getElementById('updateStatusSection');
  if (statusSection) {
    statusSection.style.display = 'none';
  }
}

function enhanceTabSwitching() {
  // Find all tab buttons and enhance the existing tab functionality
  const tabButtons = document.querySelectorAll('.settings-tab');
  const panels = document.querySelectorAll('.settings-panel');

  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const targetTab = button.getAttribute('data-tab');

      // Remove active class from all tabs and panels
      tabButtons.forEach(btn => btn.classList.remove('active'));
      panels.forEach(panel => panel.classList.remove('active'));

      // Add active class to clicked tab
      button.classList.add('active');

      // Show corresponding panel
      const targetPanel = document.getElementById(targetTab + 'Panel');
      if (targetPanel) {
        targetPanel.classList.add('active');
      }
    });
  });
}

// Enhanced status message function that integrates with your existing system
function showEnhancedStatusMessage(message, type = 'info', duration = 5000) {
  // Use your existing status message system
  const existingStatusMsg = document.getElementById('statusMessage');
  if (existingStatusMsg) {
    existingStatusMsg.textContent = message;
    existingStatusMsg.className = `status-message ${type} show`;
    
    setTimeout(() => {
      existingStatusMsg.classList.remove('show');
    }, duration);
  }

  // Also show in the download toast if available
  const downloadToast = document.getElementById('downloadToast');
  if (downloadToast) {
    downloadToast.textContent = message;
    downloadToast.className = `download-toast ${type} show`;
    
    setTimeout(() => {
      downloadToast.classList.remove('show');
    }, duration);
  }
}

// Integrate with your existing menu system
function addUpdateMenuOption() {
  // This would enhance your existing menu if you have one
  // Since you're using HTML/CSS/JS, this might not be needed
  // But it's here for completeness
}

// Listen for update events and integrate with settings panel
function setupUpdateStatusIntegration() {
  if (!window.electronAPI?.updater) {
    return;
  }

  // Listen to update status and reflect in settings panel
  const statusUnsubscribe = window.electronAPI.updater.onStatusUpdate((data) => {
    const { status, message, version, error } = data;

    switch (status) {
      case 'checking':
        showUpdateStatus('🔄', 'Checking for Updates', 'Checking for available updates...', ['dismiss']);
        break;

      case 'available':
        showUpdateStatus('📥', 'Update Available!', `Version ${version} is available for download`, ['download', 'dismiss']);
        break;

      case 'not-available':
        showUpdateStatus('✅', 'Up to Date', 'You are using the latest version', ['dismiss']);
        break;

      case 'downloading':
        showUpdateStatus('⬇️', 'Downloading Update', 'Downloading update in progress...', []);
        break;

      case 'downloaded':
        showUpdateStatus('🔄', 'Ready to Install', 'Update has been downloaded and is ready to install', ['restart', 'dismiss']);
        break;

      case 'error':
        showUpdateStatus('❌', 'Update Error', error || message || 'Failed to check for updates', ['dismiss']);
        break;

      default:
        break;
    }

    // Auto-hide status after some time for certain statuses
    if (['not-available', 'error'].includes(status)) {
      setTimeout(hideUpdateStatus, 10000);
    }
  });

  // Store unsubscribe function for cleanup
  window.updateStatusUnsubscribe = statusUnsubscribe;
}

// Initialize updater integration when DOM is ready
function initializeUpdaterIntegration() {
  console.log('Initializing updater integration...');
  
  // Enhance settings with updater options
  enhanceSettingsWithUpdater();
  
  // Setup status integration
  setupUpdateStatusIntegration();
  
  // Add context menu for manual update check (optional)
  document.addEventListener('contextmenu', (e) => {
    // You can add a context menu option here if needed
  });
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeUpdaterIntegration);
} else {
  initializeUpdaterIntegration();
}

// Add manual update check to your existing refresh button functionality
document.addEventListener('DOMContentLoaded', () => {
  const refreshBtn = document.querySelector('.refresh-btn');
  if (refreshBtn) {
    // Add update check on double-click of refresh button
    let clickCount = 0;
    refreshBtn.addEventListener('click', (e) => {
      clickCount++;
      if (clickCount === 1) {
        setTimeout(() => {
          if (clickCount === 2) {
            // Double-click detected - check for updates
            e.preventDefault();
            if (window.updateNotificationSystem) {
              window.updateNotificationSystem.manualUpdateCheck();
              showEnhancedStatusMessage('Checking for updates...', 'info');
            }
          } else {
            // Single click - normal refresh
            location.reload();
          }
          clickCount = 0;
        }, 300);
      }
    });
  }
});

// Check if we're in the renderer process and have access to electronAPI
if (typeof window !== 'undefined' && window.electronAPI) {
  
  // Auto-updater integration for your existing HTML interface
  class AttendanceSystemUpdater {
    constructor() {
      this.isInitialized = false;
      this.statusUnsubscribe = null;
      this.progressUnsubscribe = null;
      
      // Initialize when DOM is ready
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.init());
      } else {
        this.init();
      }
    }

    init() {
      if (this.isInitialized || !window.electronAPI?.updater) {
        console.log('Updater API not available or already initialized');
        return;
      }

      console.log('Initializing Attendance System Updater...');
      
      // Add update elements to your existing interface
      this.createUpdateElements();
      
      // Set up event listeners
      this.setupEventListeners();
      
      // Enhance existing settings modal
      this.enhanceSettingsModal();
      
      this.isInitialized = true;
      console.log('Attendance System Updater initialized successfully');
    }

    createUpdateElements() {
      // Create update notification that integrates with your existing toast system
      const updateNotification = document.createElement('div');
      updateNotification.id = 'updateNotification';
      updateNotification.className = 'download-toast'; // Use your existing toast styles
      updateNotification.style.display = 'none';
      updateNotification.innerHTML = `
        <div class="update-content">
          <span class="update-icon">🔄</span>
          <div class="update-text">
            <div class="update-title">Checking for updates...</div>
            <div class="update-message">Please wait...</div>
          </div>
          <button class="update-close" onclick="this.parentElement.parentElement.style.display='none'">&times;</button>
        </div>
        <div class="update-progress-bar" id="updateProgressBar" style="display: none;">
          <div class="update-progress-fill" id="updateProgressFill" style="width: 0%; height: 4px; background: #1976d2; transition: width 0.3s;"></div>
        </div>
      `;
      
      document.body.appendChild(updateNotification);
      
      // Add some specific styles for the update notification
      const updateStyles = document.createElement('style');
      updateStyles.textContent = `
        #updateNotification .update-content {
          display: flex;
          align-items: center;
          padding: 12px 16px;
          gap: 12px;
        }
        
        #updateNotification .update-icon {
          font-size: 20px;
          flex-shrink: 0;
        }
        
        #updateNotification .update-text {
          flex: 1;
        }
        
        #updateNotification .update-title {
          font-weight: 600;
          font-size: 14px;
          margin-bottom: 2px;
        }
        
        #updateNotification .update-message {
          font-size: 12px;
          opacity: 0.8;
        }
        
        #updateNotification .update-close {
          background: none;
          border: none;
          font-size: 18px;
          cursor: pointer;
          opacity: 0.7;
          padding: 4px;
        }
        
        #updateNotification .update-close:hover {
          opacity: 1;
        }
        
        #updateNotification .update-progress-bar {
          margin: 0;
        }
      `;
      document.head.appendChild(updateStyles);
    }

    setupEventListeners() {
      if (!window.electronAPI?.updater) return;

      // Listen to updater status changes
      this.statusUnsubscribe = window.electronAPI.updater.onStatusUpdate((data) => {
        console.log('Update status received:', data);
        this.handleStatusUpdate(data);
      });

      // Listen to download progress updates
      this.progressUnsubscribe = window.electronAPI.updater.onProgressUpdate((data) => {
        console.log('Download progress received:', data);
        this.updateProgress(data);
      });
    }

    handleStatusUpdate(data) {
      const { status, message, version, error } = data;
      const notification = document.getElementById('updateNotification');
      const icon = notification.querySelector('.update-icon');
      const title = notification.querySelector('.update-title');
      const messageEl = notification.querySelector('.update-message');
      const progressBar = document.getElementById('updateProgressBar');

      switch (status) {
        case 'checking':
          this.showNotification('🔄', 'Checking for Updates', 'Looking for new versions...', 'info');
          break;

        case 'available':
          this.showNotification('📥', 'Update Available!', `Version ${version} is ready to download`, 'success');
          this.showUpdateDialog(data);
          break;

        case 'not-available':
          this.showNotification('✅', 'Up to Date', 'You are using the latest version', 'success');
          setTimeout(() => this.hideNotification(), 3000);
          break;

        case 'downloading':
          this.showNotification('⬇️', 'Downloading Update', 'Download in progress...', 'info', false);
          if (progressBar) {
            progressBar.style.display = 'block';
          }
          break;

        case 'downloaded':
          this.showNotification('🔄', 'Update Ready!', 'Restart to install the update', 'success');
          this.showRestartDialog(data);
          if (progressBar) {
            progressBar.style.display = 'none';
          }
          break;

        case 'error':
          this.showNotification('❌', 'Update Error', error || message || 'Failed to check for updates', 'error');
          setTimeout(() => this.hideNotification(), 5000);
          break;

        case 'postponed':
          this.showNotification('⏰', 'Update Postponed', 'Update will be available later', 'info');
          setTimeout(() => this.hideNotification(), 3000);
          break;

        case 'ready-to-install':
          this.showNotification('🔄', 'Ready to Install', 'Update will install on next restart', 'warning');
          break;
      }
    }

    updateProgress(progress) {
      const { percent } = progress;
      const progressFill = document.getElementById('updateProgressFill');
      const messageEl = document.querySelector('#updateNotification .update-message');
      
      if (progressFill) {
        progressFill.style.width = `${percent}%`;
      }
      
      if (messageEl) {
        messageEl.textContent = `${Math.round(percent)}% complete`;
      }
    }

    showNotification(icon, title, message, type = 'info', autoHide = true) {
      const notification = document.getElementById('updateNotification');
      if (!notification) return;

      const iconEl = notification.querySelector('.update-icon');
      const titleEl = notification.querySelector('.update-title');
      const messageEl = notification.querySelector('.update-message');

      if (iconEl) iconEl.textContent = icon;
      if (titleEl) titleEl.textContent = title;
      if (messageEl) messageEl.textContent = message;

      // Use your existing toast classes
      notification.className = `download-toast ${type} show`;
      notification.style.display = 'block';

      if (autoHide && type !== 'downloading') {
        setTimeout(() => this.hideNotification(), 5000);
      }
    }

    hideNotification() {
      const notification = document.getElementById('updateNotification');
      if (notification) {
        notification.classList.remove('show');
        setTimeout(() => {
          notification.style.display = 'none';
        }, 300);
      }
    }

    showUpdateDialog(data) {
      const result = confirm(
        `A new version (${data.version}) is available!\n\n` +
        `Would you like to download it now? The update will be installed when you restart the application.`
      );
      
      if (result && window.electronAPI?.updater?.downloadUpdate) {
        window.electronAPI.updater.downloadUpdate();
      }
    }

    showRestartDialog(data) {
      const result = confirm(
        `Update has been downloaded successfully!\n\n` +
        `The application will restart to apply the update. Would you like to restart now?`
      );
      
      if (result && window.electronAPI?.updater?.quitAndInstall) {
        window.electronAPI.updater.quitAndInstall();
      }
    }

    enhanceSettingsModal() {
      // Wait for settings modal to be available
      setTimeout(() => {
        const settingsModal = document.getElementById('settingsModal');
        if (!settingsModal) return;

        // Add update tab to existing tabs
        const tabsContainer = settingsModal.querySelector('.settings-tabs');
        if (tabsContainer && !document.querySelector('[data-tab="updates"]')) {
          const updateTab = document.createElement('button');
          updateTab.className = 'settings-tab';
          updateTab.setAttribute('data-tab', 'updates');
          updateTab.innerHTML = '🔄 Updates';
          tabsContainer.appendChild(updateTab);

          // Add update panel
          const settingsBody = settingsModal.querySelector('.settings-body');
          if (settingsBody) {
            const updatePanel = this.createUpdatePanel();
            settingsBody.appendChild(updatePanel);
          }

          // Set up tab switching for the new tab
          updateTab.addEventListener('click', () => {
            // Remove active from all tabs and panels
            settingsModal.querySelectorAll('.settings-tab').forEach(tab => 
              tab.classList.remove('active'));
            settingsModal.querySelectorAll('.settings-panel').forEach(panel => 
              panel.classList.remove('active'));

            // Activate update tab and panel
            updateTab.classList.add('active');
            document.getElementById('updatesPanel').classList.add('active');
          });
        }
      }, 1000);
    }

    createUpdatePanel() {
      const updatePanel = document.createElement('div');
      updatePanel.className = 'settings-panel';
      updatePanel.id = 'updatesPanel';
      updatePanel.innerHTML = `
        <div class="sync-info">
          <h3>🔄 Application Updates</h3>
          
          <div class="form-group">
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
              <div style="flex: 1;">
                <strong>Current Version:</strong>
                <span id="currentVersionDisplay" style="margin-left: 8px; color: #666;">Loading...</span>
              </div>
              <button class="btn btn-primary" id="manualUpdateCheck" 
                style="padding: 8px 16px; font-size: 14px; background: #1976d2; color: white; border: none; border-radius: 4px; cursor: pointer;">
                🔍 Check for Updates
              </button>
            </div>
          </div>

          <div id="updateStatusInfo" style="margin-top: 16px; padding: 12px; background: #f8f9fa; border-radius: 6px; display: none;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
              <span id="updateStatusIcon">ℹ️</span>
              <strong id="updateStatusTitle">Status</strong>
            </div>
            <p id="updateStatusMessage" style="margin: 0; font-size: 14px; color: #666;"></p>
          </div>

          <div style="margin-top: 20px; padding: 12px; background: #e3f2fd; border-radius: 6px; font-size: 14px;">
            <strong>💡 Tip:</strong> Updates are automatically checked when you start the application. 
            You can also double-click the "Refresh" button in the header to manually check for updates.
          </div>
        </div>
      `;

      // Set up event handlers for the update panel
      setTimeout(() => {
        this.setupUpdatePanelHandlers();
      }, 100);

      return updatePanel;
    }

    setupUpdatePanelHandlers() {
      // Load and display current version
      this.loadCurrentVersion();

      // Manual update check button
      const checkButton = document.getElementById('manualUpdateCheck');
      if (checkButton) {
        checkButton.addEventListener('click', async () => {
          checkButton.disabled = true;
          checkButton.textContent = '🔄 Checking...';
          
          try {
            if (window.electronAPI?.updater?.checkForUpdates) {
              await window.electronAPI.updater.checkForUpdates();
            }
          } catch (error) {
            console.error('Manual update check failed:', error);
          } finally {
            setTimeout(() => {
              checkButton.disabled = false;
              checkButton.textContent = '🔍 Check for Updates';
            }, 2000);
          }
        });
      }
    }

    async loadCurrentVersion() {
      try {
        if (window.electronAPI?.updater?.getAppVersion) {
          const versionInfo = await window.electronAPI.updater.getAppVersion();
          const versionDisplay = document.getElementById('currentVersionDisplay');
          if (versionDisplay && versionInfo) {
            versionDisplay.textContent = `v${versionInfo.version}${versionInfo.isDev ? ' (Development)' : ''}`;
          }
        }
      } catch (error) {
        console.error('Failed to load version info:', error);
        const versionDisplay = document.getElementById('currentVersionDisplay');
        if (versionDisplay) {
          versionDisplay.textContent = 'Unknown';
        }
      }
    }

    // Method to manually trigger update check (can be called from your existing code)
    async checkForUpdates() {
      if (window.electronAPI?.updater?.checkForUpdates) {
        try {
          const result = await window.electronAPI.updater.checkForUpdates();
          console.log('Update check result:', result);
          return result;
        } catch (error) {
          console.error('Update check failed:', error);
          throw error;
        }
      } else {
        console.warn('Update check not available');
        return { success: false, error: 'Update API not available' };
      }
    }

    // Cleanup method
    destroy() {
      if (this.statusUnsubscribe) {
        this.statusUnsubscribe();
      }
      if (this.progressUnsubscribe) {
        this.progressUnsubscribe();
      }
      
      const notification = document.getElementById('updateNotification');
      if (notification) {
        notification.remove();
      }
    }
  }

  // Initialize the updater system
  const attendanceUpdater = new AttendanceSystemUpdater();

  // Enhance your existing refresh button with double-click update check
  document.addEventListener('DOMContentLoaded', () => {
    const refreshBtn = document.querySelector('.refresh-btn');
    if (refreshBtn) {
      let clickCount = 0;
      let clickTimer = null;

      refreshBtn.addEventListener('click', (e) => {
        clickCount++;
        
        if (clickCount === 1) {
          clickTimer = setTimeout(() => {
            if (clickCount === 1) {
              // Single click - normal refresh
              location.reload();
            }
            clickCount = 0;
          }, 300);
        } else if (clickCount === 2) {
          // Double click - check for updates
          clearTimeout(clickTimer);
          e.preventDefault();
          
          console.log('Double-click detected - checking for updates');
          attendanceUpdater.checkForUpdates().catch(error => {
            console.error('Update check failed:', error);
          });
          
          clickCount = 0;
        }
      });
    }
  });

  // Export for global access
  window.attendanceSystemUpdater = attendanceUpdater;

} else {
  console.warn('Updater integration skipped - electronAPI not available');
}

// Export functions for global access
window.updaterIntegration = {
  showUpdateStatus,
  hideUpdateStatus,
  loadCurrentVersion,
  checkForUpdates: () => window.updateNotificationSystem?.manualUpdateCheck()
};