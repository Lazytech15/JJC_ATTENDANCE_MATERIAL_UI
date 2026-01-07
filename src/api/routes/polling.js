const pollingManager = require('../../services/pollingManager');
const { getSettings } = require('./settings');

/**
 * Initialize polling manager
 */
async function initializePolling() {
  try {
    const settings = await getSettings();
    
    if (!settings.success || !settings.data.server_url) {
      return {
        success: false,
        error: 'Server URL not configured'
      };
    }

    const result = await pollingManager.initialize(settings.data.server_url);
    
    return result;
  } catch (error) {
    console.error('Initialize polling error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Start polling
 */
async function startPolling(options = {}) {
  try {
    const result = await pollingManager.startPolling(options);
    return result;
  } catch (error) {
    console.error('Start polling error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Stop polling
 */
function stopPolling() {
  try {
    const result = pollingManager.stopPolling();
    return result;
  } catch (error) {
    console.error('Stop polling error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get polling status
 */
function getPollingStatus() {
  try {
    const status = pollingManager.getStatus();
    return {
      success: true,
      data: status
    };
  } catch (error) {
    console.error('Get polling status error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Update subscribed events
 */
function updateSubscribedEvents(events) {
  try {
    if (!Array.isArray(events)) {
      throw new Error('Events must be an array');
    }

    pollingManager.subscribedEvents = events;
    
    return {
      success: true,
      message: 'Subscribed events updated',
      events: events
    };
  } catch (error) {
    console.error('Update subscribed events error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  initializePolling,
  startPolling,
  stopPolling,
  getPollingStatus,
  updateSubscribedEvents,
  pollingManager // Export instance for event listening
};