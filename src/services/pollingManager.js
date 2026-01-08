// services/pollingManager.js - ENHANCED VERSION WITH CURRENTLY CLOCKED SYNC

const fetch = require('node-fetch');
const EventEmitter = require('events');
const { getDatabase, updateDailyAttendanceSummary } = require('../database/setup');

class PollingManager extends EventEmitter {
  constructor() {
    super();
    this.isPolling = false;
    this.pollingInterval = null;
    this.lastEventTimestamp = 0;
    this.serverUrl = null;
    this.pollingEndpoint = null;
    this.pollingTimeout = 30000;
    this.reconnectDelay = 5000;
    this.maxReconnectAttempts = 5;
    this.reconnectAttempts = 0;
    this.abortController = null;
    this.healthCheckPassed = false;
    
    // Validation & Re-upload tracking
    this.isValidating = false;
    this.validationQueue = new Set();
    this.reuploadQueue = new Map();
    this.autoValidateEnabled = true;
    this.autoReuploadEnabled = true;
    this.validationDebounceTimer = null;
    this.validationDebounceDelay = 3000;
    
    // ✅ NEW: Currently clocked employees sync
    this.lastClockedSync = 0;
    this.clockedSyncInterval = 300000; // Sync every 5 minutes
    
    this.subscribedEvents = [
      'employee_created',
      'employee_updated',
      'employee_deleted',
      'employee_status_changed',
      'employee_bulk_deleted',
      'employee_password_changed',
      'employee_fcm_token_registered',
      'employee_fcm_token_unregistered',
      'attendance_created',
      'attendance_updated',
      'attendance_deleted',
      'attendance_synced',
      'attendance_update',
      'daily_summary_synced',
      'daily_summary_deleted',
      'daily_summary_rebuilt',
      'daily_summary_created',
      'daily_summary_updated'
    ];

    console.log('PollingManager initialized with validation & currently-clocked sync');
  }

  /**
   * Initialize with proper URL handling
   */
  async initialize(serverUrl, options = {}) {
    try {
      if (!serverUrl) {
        throw new Error('Server URL is required');
      }

      let baseUrl = serverUrl.trim();
      baseUrl = baseUrl.replace(/\/api\/employees\/?$/, '');
      baseUrl = baseUrl.replace(/\/$/, '');
      
      if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
        baseUrl = 'https://' + baseUrl;
      }
      
      this.serverUrl = baseUrl;
      this.pollingEndpoint = `${baseUrl}/api/socket`;
      
      this.autoValidateEnabled = options.autoValidate !== false;
      this.autoReuploadEnabled = options.autoReupload !== false;
      
      console.log(`✓ Polling endpoint configured: ${this.pollingEndpoint}`);
      console.log(`✓ Auto-validate: ${this.autoValidateEnabled}`);
      console.log(`✓ Auto-reupload: ${this.autoReuploadEnabled}`);
      console.log(`✓ Clocked sync interval: ${this.clockedSyncInterval}ms`);
      
      const healthCheck = await this.performHealthCheck();
      
      if (!healthCheck.success) {
        console.warn('⚠️ Polling health check failed:', healthCheck.error);
        return {
          success: false,
          error: healthCheck.error,
          endpoint: this.pollingEndpoint
        };
      }
      
      console.log('✓ Polling health check passed');
      this.healthCheckPassed = true;
      this.lastEventTimestamp = Date.now() / 1000;
      this.reconnectAttempts = 0;
      
      return {
        success: true,
        message: 'Polling manager initialized',
        endpoint: this.pollingEndpoint,
        healthCheck: healthCheck
      };
    } catch (error) {
      console.error('PollingManager initialization error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Health check
   */
  async performHealthCheck() {
    try {
      console.log('🔍 Performing polling health check...');
      
      const testUrl = `${this.pollingEndpoint}?action=poll&since=${Date.now() / 1000}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetch(testUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'AttendanceApp-PollingManager/1.0',
          'Accept': 'application/json'
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      const responseText = await response.text();
      const contentType = response.headers.get('content-type');
      
      if (!contentType || !contentType.includes('application/json')) {
        return {
          success: false,
          error: `Server returned ${contentType || 'unknown content type'} instead of JSON`
        };
      }
      
      const data = JSON.parse(responseText);
      
      return {
        success: true,
        status: response.status,
        endpoint: this.pollingEndpoint,
        eventsSupported: Array.isArray(data.events),
        serverTimestamp: data.timestamp
      };
      
    } catch (error) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          error: 'Health check timeout - server not responding',
          timeout: true
        };
      }
      
      return {
        success: false,
        error: error.message,
        code: error.code
      };
    }
  }

  /**
   * Start polling
   */
  async startPolling(options = {}) {
    if (this.isPolling) {
      console.log('Polling already active');
      return { success: true, message: 'Already polling' };
    }

    try {
      if (!this.pollingEndpoint) {
        throw new Error('Polling manager not initialized. Call initialize() first.');
      }
      
      if (!this.healthCheckPassed) {
        console.warn('⚠️ Health check not passed, attempting re-check...');
        const healthCheck = await this.performHealthCheck();
        
        if (!healthCheck.success) {
          return {
            success: false,
            error: 'Cannot start polling - health check failed: ' + healthCheck.error,
            details: healthCheck
          };
        }
        
        this.healthCheckPassed = true;
      }

      const {
        pollInterval = 5000,
        subscribedEvents = this.subscribedEvents,
        autoValidate = this.autoValidateEnabled,
        autoReupload = this.autoReuploadEnabled
      } = options;

      this.isPolling = true;
      this.subscribedEvents = subscribedEvents;
      this.autoValidateEnabled = autoValidate;
      this.autoReuploadEnabled = autoReupload;

      console.log(`🔄 Starting polling with ${pollInterval}ms interval`);
      console.log(`📡 Subscribed to events:`, this.subscribedEvents);

      this.poll();

      return {
        success: true,
        message: 'Polling started',
        interval: pollInterval,
        subscribedEvents: this.subscribedEvents,
        autoValidate: this.autoValidateEnabled,
        autoReupload: this.autoReuploadEnabled
      };
    } catch (error) {
      console.error('Error starting polling:', error);
      this.isPolling = false;
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Stop polling
   */
  stopPolling() {
    this.isPolling = false;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.pollingInterval) {
      clearTimeout(this.pollingInterval);
      this.pollingInterval = null;
    }
    
    if (this.validationDebounceTimer) {
      clearTimeout(this.validationDebounceTimer);
      this.validationDebounceTimer = null;
    }

    console.log('🛑 Polling stopped');

    return {
      success: true,
      message: 'Polling stopped'
    };
  }

  /**
   * Main polling loop with currently clocked sync
   */
  async poll() {
    if (!this.isPolling) {
      return;
    }

    try {
      this.abortController = new AbortController();
      const timeoutId = setTimeout(() => this.abortController.abort(), this.pollingTimeout);

      const url = `${this.pollingEndpoint}?action=poll&since=${this.lastEventTimestamp}`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'AttendanceApp-PollingManager/1.0'
        },
        signal: this.abortController.signal
      });

      clearTimeout(timeoutId);

      const responseText = await response.text();
      
      if (responseText.trim().toLowerCase().startsWith('<!doctype') || 
          responseText.trim().toLowerCase().startsWith('<html')) {
        throw new Error('Server returned HTML error page instead of JSON');
      }

      const data = JSON.parse(responseText);

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}: ${data.error || response.statusText}`);
      }

      if (data.success && data.events) {
        const events = data.events;
        
        if (events.length > 0) {
          console.log(`📥 Received ${events.length} event(s)`);
          this.lastEventTimestamp = data.timestamp;
          await this.processEvents(events);
          this.reconnectAttempts = 0;
        }
      }

      // ✅ NEW: Check if it's time to sync currently clocked employees
      const now = Date.now();
      if (now - this.lastClockedSync >= this.clockedSyncInterval) {
        await this.syncCurrentlyClockedEmployees();
        this.lastClockedSync = now;
      }

      if (this.isPolling) {
        this.pollingInterval = setTimeout(() => this.poll(), 3000);
      }

    } catch (error) {
      if (error.name === 'AbortError') {
        if (this.isPolling) {
          this.pollingInterval = setTimeout(() => this.poll(), 3000);
        }
      } else {
        console.error('Polling error:', error.message);
        this.handlePollingError(error);

        if (this.isPolling && this.reconnectAttempts < this.maxReconnectAttempts) {
          const delay = Math.min(
            this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
            60000
          );
          
          console.log(`⏳ Retrying poll in ${delay}ms (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);
          
          this.pollingInterval = setTimeout(() => this.poll(), delay);
          this.reconnectAttempts++;
        } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          console.error('❌ Max reconnect attempts reached, stopping polling');
          this.emit('polling-failed', {
            error: 'Max reconnect attempts reached',
            attempts: this.reconnectAttempts
          });
          this.stopPolling();
        }
      }
    }
  }

  /**
 * ✅ ENHANCED: Sync currently clocked employees AND today's daily summary from server
 */
async syncCurrentlyClockedEmployees() {
  try {
    console.log('🔄 Syncing currently clocked employees and daily summary from server...');
    
    const { getSettings } = require('../api/routes/settings');
    const settings = await getSettings();

    if (!settings.success) {
      throw new Error('Settings not available');
    }

    const serverUrl = settings.data.server_url.replace('/api/employees', '');
    const today = new Date().toISOString().split('T')[0];
    
    // ✅ STEP 1: Fetch currently clocked employees from server
    const clockedResponse = await fetch(`${serverUrl}/api/attendance/currently-clocked`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      }
    });

    if (!clockedResponse.ok) {
      const errorText = await clockedResponse.text();
      throw new Error(`Server returned ${clockedResponse.status}: ${errorText}`);
    }

    const clockedResult = await clockedResponse.json();
    
    if (!clockedResult.success || !clockedResult.data) {
      console.log('⏭️ No currently clocked employees on server');
      return;
    }

    const clockedEmployees = clockedResult.data;
    console.log(`📊 Server: ${clockedEmployees.length} currently clocked employees`);

    // ✅ STEP 2: Fetch today's daily summary from server
    console.log(`📊 Fetching today's daily summary from server (${today})...`);
    
    const summaryResponse = await fetch(
      `${serverUrl}/api/daily-summary?start_date=${today}&end_date=${today}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        }
      }
    );

    let serverSummaries = [];
    if (summaryResponse.ok) {
      const summaryResult = await summaryResponse.json();
      if (summaryResult.success && summaryResult.data) {
        serverSummaries = summaryResult.data;
        console.log(`📊 Server: ${serverSummaries.length} daily summary records for today`);
      }
    } else {
      console.warn(`⚠️ Failed to fetch daily summary: ${summaryResponse.status}`);
    }

    // ✅ STEP 3: Compare with local database
    const db = getDatabase();
    
    // Get local currently clocked employees
    const localClocked = db.prepare(`
      SELECT DISTINCT 
        employee_uid, 
        clock_type, 
        clock_time,
        id as attendance_id
      FROM attendance
      WHERE date = ?
      AND clock_type LIKE '%_in'
      AND NOT EXISTS (
        SELECT 1 FROM attendance a2
        WHERE a2.employee_uid = attendance.employee_uid
        AND a2.date = attendance.date
        AND a2.clock_type LIKE '%_out'
        AND REPLACE(a2.clock_type, '_out', '') = REPLACE(attendance.clock_type, '_in', '')
        AND a2.clock_time > attendance.clock_time
      )
    `).all(today);

    console.log(`📊 Local: ${localClocked.length} currently clocked employees`);

    // Create sets for comparison
    const serverUids = new Set(clockedEmployees.map(e => e.employee_uid));
    const localUids = new Set(localClocked.map(e => e.employee_uid));

    // Find employees clocked on server but not locally
    const missingLocally = clockedEmployees.filter(e => !localUids.has(e.employee_uid));
    
    let syncedAttendanceCount = 0;
    
    // ✅ STEP 4: Download missing attendance records
    if (missingLocally.length > 0) {
      console.log(`⚠️ Found ${missingLocally.length} employees clocked on server but not locally`);
      
      for (const employee of missingLocally) {
        try {
          console.log(`📥 Downloading attendance for ${employee.employee_uid} (${employee.first_name} ${employee.last_name})`);
          
          const attendanceResponse = await fetch(
            `${serverUrl}/api/attendance?employee_uid=${employee.employee_uid}&date=${today}`,
            {
              method: 'GET',
              headers: { 'Content-Type': 'application/json' }
            }
          );

          if (attendanceResponse.ok) {
            const attendanceData = await attendanceResponse.json();
            
            if (attendanceData.success && attendanceData.data && attendanceData.data.length > 0) {
              console.log(`   Found ${attendanceData.data.length} attendance records for ${employee.employee_uid}`);
              
              // Insert ALL missing records
              for (const record of attendanceData.data) {
                // ✅ FIX: More precise duplicate check - use UNIQUE constraint fields
                const existingRecord = db.prepare(`
                  SELECT id FROM attendance 
                  WHERE employee_uid = ? 
                  AND clock_time = ? 
                  AND date = ? 
                  AND clock_type = ?
                `).get(
                  record.employee_uid,
                  record.clock_time,
                  record.date,
                  record.clock_type
                );

                if (existingRecord) {
                  console.log(`   ⏭️ Record for ${record.clock_type} at ${record.clock_time} already exists (ID: ${existingRecord.id}), skipping`);
                  continue;
                }
                
                // Format clock_time properly
                let formattedClockTime = record.clock_time;
                if (formattedClockTime && record.date) {
                  if (/^\d{2}:\d{2}:\d{2}/.test(formattedClockTime) && !formattedClockTime.includes('T')) {
                    const timeOnly = formattedClockTime.trim();
                    const timeParts = timeOnly.split('.');
                    const milliseconds = timeParts[1] ? timeParts[1].substring(0, 3).padEnd(3, '0') : '000';
                    const timeWithMs = timeParts[0] + '.' + milliseconds;
                    formattedClockTime = `${record.date}T${timeWithMs}`;
                  } else {
                    formattedClockTime = formattedClockTime
                      .replace('Z', '')
                      .replace(/[+-]\d{2}:\d{2}$/, '')
                      .trim();
                    
                    if (!formattedClockTime.includes('.')) {
                      formattedClockTime += '.000';
                    }
                  }
                }
                
                // ✅ FIX: Don't use server's ID - let local DB generate a new one
                const insertStmt = db.prepare(`
                  INSERT INTO attendance (
                    employee_uid, id_number, clock_type, clock_time, 
                    regular_hours, overtime_hours, date, is_late, is_synced, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                `);

                try {
                  const insertResult = insertStmt.run(
                    record.employee_uid,
                    record.id_number,
                    record.clock_type,
                    formattedClockTime,
                    record.regular_hours || 0,
                    record.overtime_hours || 0,
                    record.date,
                    record.is_late || 0,
                    record.created_at || new Date().toISOString()
                  );

                  if (insertResult.changes > 0) {
                    console.log(`   ✓ Inserted ${record.clock_type} (Local ID: ${insertResult.lastInsertRowid}, Server ID: ${record.id}) at ${formattedClockTime}`);
                    syncedAttendanceCount++;
                  }
                } catch (insertError) {
                  // Check if it's a UNIQUE constraint violation
                  if (insertError.message.includes('UNIQUE constraint failed')) {
                    console.log(`   ⏭️ Duplicate detected during insert for ${record.clock_type} at ${record.clock_time}, skipping`);
                  } else {
                    throw insertError;
                  }
                }
              }
            } else {
              console.log(`   ⚠️ No attendance records found on server for ${employee.employee_uid}`);
            }
          } else {
            console.error(`   ✗ Failed to fetch attendance for ${employee.employee_uid}: ${attendanceResponse.status}`);
          }
        } catch (error) {
          console.error(`   ✗ Error downloading attendance for ${employee.employee_uid}:`, error.message);
        }
      }
    } else {
      console.log('✓ Local attendance is in sync with server for currently clocked employees');
    }

    // ✅ STEP 5: Sync daily summary records
    let syncedSummaryCount = 0;
    
    if (serverSummaries.length > 0) {
      console.log(`📊 Syncing ${serverSummaries.length} daily summary records from server...`);
      
      for (const serverSummary of serverSummaries) {
        try {
          // Check if local summary exists
          const localSummary = db.prepare(`
            SELECT * FROM daily_attendance_summary
            WHERE employee_uid = ? AND date = ?
          `).get(serverSummary.employee_uid, serverSummary.date);

          // Format datetime fields
          const formatDateTime = (dt) => {
            if (!dt) return null;
            if (dt.includes('T')) {
              return dt.replace('Z', '').replace(/[+-]\d{2}:\d{2}$/, '').trim() + 
                     (dt.includes('.') ? '' : '.000');
            }
            return dt + (dt.includes('.') ? '' : '.000');
          };

          if (!localSummary) {
            // Insert new summary
            const insertStmt = db.prepare(`
              INSERT INTO daily_attendance_summary (
                employee_uid, id_number, employee_name, first_name, last_name,
                department, date, first_clock_in, last_clock_out,
                morning_in, morning_out, afternoon_in, afternoon_out,
                evening_in, evening_out, overtime_in, overtime_out,
                regular_hours, overtime_hours, total_hours,
                morning_hours, afternoon_hours, evening_hours, overtime_session_hours,
                is_incomplete, has_late_entry, has_overtime
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            insertStmt.run(
              serverSummary.employee_uid,
              serverSummary.id_number,
              serverSummary.employee_name,
              serverSummary.first_name,
              serverSummary.last_name,
              serverSummary.department,
              serverSummary.date,
              formatDateTime(serverSummary.first_clock_in),
              formatDateTime(serverSummary.last_clock_out),
              formatDateTime(serverSummary.morning_in),
              formatDateTime(serverSummary.morning_out),
              formatDateTime(serverSummary.afternoon_in),
              formatDateTime(serverSummary.afternoon_out),
              formatDateTime(serverSummary.evening_in),
              formatDateTime(serverSummary.evening_out),
              formatDateTime(serverSummary.overtime_in),
              formatDateTime(serverSummary.overtime_out),
              serverSummary.regular_hours || 0,
              serverSummary.overtime_hours || 0,
              serverSummary.total_hours || 0,
              serverSummary.morning_hours || 0,
              serverSummary.afternoon_hours || 0,
              serverSummary.evening_hours || 0,
              serverSummary.overtime_session_hours || 0,
              serverSummary.is_incomplete || 0,
              serverSummary.has_late_entry || 0,
              serverSummary.has_overtime || 0
            );

            syncedSummaryCount++;
            console.log(`   ✓ Inserted summary for ${serverSummary.employee_uid}`);
          } else {
            // Compare and update if different
            const needsUpdate = 
              localSummary.regular_hours !== (serverSummary.regular_hours || 0) ||
              localSummary.overtime_hours !== (serverSummary.overtime_hours || 0) ||
              localSummary.total_hours !== (serverSummary.total_hours || 0);

            if (needsUpdate) {
              const updateStmt = db.prepare(`
                UPDATE daily_attendance_summary SET
                  first_clock_in = ?, last_clock_out = ?,
                  morning_in = ?, morning_out = ?,
                  afternoon_in = ?, afternoon_out = ?,
                  evening_in = ?, evening_out = ?,
                  overtime_in = ?, overtime_out = ?,
                  regular_hours = ?, overtime_hours = ?, total_hours = ?,
                  morning_hours = ?, afternoon_hours = ?, evening_hours = ?,
                  overtime_session_hours = ?,
                  is_incomplete = ?, has_late_entry = ?, has_overtime = ?
                WHERE employee_uid = ? AND date = ?
              `);

              updateStmt.run(
                formatDateTime(serverSummary.first_clock_in),
                formatDateTime(serverSummary.last_clock_out),
                formatDateTime(serverSummary.morning_in),
                formatDateTime(serverSummary.morning_out),
                formatDateTime(serverSummary.afternoon_in),
                formatDateTime(serverSummary.afternoon_out),
                formatDateTime(serverSummary.evening_in),
                formatDateTime(serverSummary.evening_out),
                formatDateTime(serverSummary.overtime_in),
                formatDateTime(serverSummary.overtime_out),
                serverSummary.regular_hours || 0,
                serverSummary.overtime_hours || 0,
                serverSummary.total_hours || 0,
                serverSummary.morning_hours || 0,
                serverSummary.afternoon_hours || 0,
                serverSummary.evening_hours || 0,
                serverSummary.overtime_session_hours || 0,
                serverSummary.is_incomplete || 0,
                serverSummary.has_late_entry || 0,
                serverSummary.has_overtime || 0,
                serverSummary.employee_uid,
                serverSummary.date
              );

              syncedSummaryCount++;
              console.log(`   ✓ Updated summary for ${serverSummary.employee_uid}`);
            }
          }
        } catch (error) {
          console.error(`   ✗ Error syncing summary for ${serverSummary.employee_uid}:`, error.message);
        }
      }
    }

    console.log(`✅ Sync completed: ${syncedAttendanceCount} attendance, ${syncedSummaryCount} summaries`);

    // ✅ STEP 6: Emit events for UI update
    if (syncedAttendanceCount > 0 || syncedSummaryCount > 0) {
      this.emit('currently-clocked-synced', {
        synced: syncedAttendanceCount,
        total: clockedEmployees.length,
        missingCount: missingLocally.length,
        summariesSynced: syncedSummaryCount,
        timestamp: new Date().toISOString()
      });

      this.emit('ui-refresh-needed', {
        reason: 'currently-clocked-sync',
        syncedCount: syncedAttendanceCount,
        summariesSynced: syncedSummaryCount,
        employeeUids: missingLocally.map(e => e.employee_uid),
        timestamp: new Date().toISOString()
      });

      this.emit('attendance-changed', {
        type: 'currently_clocked_sync',
        count: syncedAttendanceCount,
        timestamp: new Date().toISOString()
      });

      if (syncedSummaryCount > 0) {
        this.emit('summary-synced', {
          count: syncedSummaryCount,
          date: today,
          timestamp: new Date().toISOString()
        });
      }
    }

    this.emit('clocked-employees-checked', {
      server: clockedEmployees.length,
      local: localClocked.length,
      syncedAttendance: syncedAttendanceCount,
      syncedSummaries: syncedSummaryCount,
      statistics: clockedResult.statistics
    });

  } catch (error) {
    console.error('❌ Error syncing currently clocked employees:', error.message);
    this.emit('clocked-sync-error', {
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}

  /**
   * Process events
   */
  async processEvents(events) {
    const db = getDatabase();
    const processedEvents = {
      employees: [],
      attendance: [],
      summaries: [],
      other: []
    };

    for (const event of events) {
      try {
        const { event: eventType, data, timestamp } = event;

        if (!this.subscribedEvents.includes(eventType)) {
          console.log(`⏭️ Skipping unsubscribed event: ${eventType}`);
          continue;
        }

        console.log(`📨 Processing event: ${eventType}`);

        if (eventType.startsWith('employee_')) {
          await this.handleEmployeeEvent(eventType, data, db);
          processedEvents.employees.push(eventType);
        } else if (eventType.startsWith('attendance_')) {
          const insertResult = await this.downloadAndInsertAttendance(eventType, data, db);
          
          if (insertResult.success) {
            processedEvents.attendance.push(eventType);
            
            if (this.autoValidateEnabled && data.employee_uid && data.date) {
              this.queueValidation(data.employee_uid, data.date);
            }
          }
        } else if (eventType.startsWith('daily_summary_')) {
          await this.handleSummaryEvent(eventType, data, db);
          processedEvents.summaries.push(eventType);
        } else {
          this.emit('event-received', { eventType, data, timestamp });
          processedEvents.other.push(eventType);
        }

      } catch (error) {
        console.error(`Error processing event ${event.event}:`, error);
        this.emit('event-error', {
          event: event.event,
          error: error.message
        });
      }
    }

    this.emit('events-processed', {
      total: events.length,
      employees: processedEvents.employees.length,
      attendance: processedEvents.attendance.length,
      summaries: processedEvents.summaries.length,
      other: processedEvents.other.length
    });

    return processedEvents;
  }

  // Queue validation, process validation queue, process reupload queue, etc.
  // [Rest of the existing methods remain the same...]
  
  queueValidation(employeeUid, date) {
    const key = `${employeeUid}:${date}`;
    this.validationQueue.add(key);
    console.log(`📋 Queued validation for employee ${employeeUid} on ${date}`);
    
    if (this.validationDebounceTimer) {
      clearTimeout(this.validationDebounceTimer);
    }
    
    this.validationDebounceTimer = setTimeout(() => {
      this.processValidationQueue();
    }, this.validationDebounceDelay);
  }

  async processValidationQueue() {
    if (this.isValidating || this.validationQueue.size === 0) {
      return;
    }

    this.isValidating = true;
    const queueSnapshot = Array.from(this.validationQueue);
    this.validationQueue.clear();

    console.log(`🔍 Processing validation queue: ${queueSnapshot.length} items`);

    try {
      const validateTimeRoutes = require('./validateTime');
      
      for (const key of queueSnapshot) {
        const [employeeUid, date] = key.split(':');
        
        try {
          console.log(`✅ Validating employee ${employeeUid} on ${date}...`);
          
          const validationResult = await validateTimeRoutes.validateAttendanceData(
            date,
            date,
            employeeUid,
            {
              autoCorrect: true,
              updateSyncStatus: true,
              validateStatistics: true,
              rebuildSummary: true,
              apply8HourRule: true
            }
          );

          if (validationResult && validationResult.validationResults) {
            const results = validationResult.validationResults;
            
            console.log(`✅ Validation complete for ${employeeUid} on ${date}:`);
            console.log(`   - Records validated: ${results.totalRecords}`);
            console.log(`   - Corrections: ${results.correctedRecords}`);
            console.log(`   - Summaries regenerated: ${results.summariesRegenerated || 0}`);

            if (this.autoReuploadEnabled && results.correctedRecords > 0) {
              this.queueReupload(employeeUid, date, results);
            }

            this.emit('validation-completed', {
              employeeUid,
              date,
              results
            });
          }

        } catch (error) {
          console.error(`❌ Validation failed for ${employeeUid} on ${date}:`, error);
          this.emit('validation-error', {
            employeeUid,
            date,
            error: error.message
          });
        }

        await new Promise(resolve => setTimeout(resolve, 100));
      }

      console.log(`✓ Validation queue processed`);

    } catch (error) {
      console.error('Validation queue processing error:', error);
    } finally {
      this.isValidating = false;
      
      if (this.validationQueue.size > 0) {
        setTimeout(() => this.processValidationQueue(), 1000);
      }
    }
  }

  queueReupload(employeeUid, date, validationResults) {
    const key = `${employeeUid}:${date}`;
    this.reuploadQueue.set(key, {
      employeeUid,
      date,
      validationResults,
      timestamp: Date.now()
    });
    
    console.log(`📤 Queued re-upload for employee ${employeeUid} on ${date}`);
    setTimeout(() => this.processReuploadQueue(), 500);
  }

  async processReuploadQueue() {
    if (this.reuploadQueue.size === 0) {
      return;
    }

    const items = Array.from(this.reuploadQueue.values());
    this.reuploadQueue.clear();

    console.log(`📤 Processing re-upload queue: ${items.length} items`);

    try {
      const db = getDatabase();

      for (const item of items) {
        const { employeeUid, date, validationResults } = item;

        try {
          console.log(`📤 Re-uploading data for employee ${employeeUid} on ${date}...`);

          const attendanceRecords = db.prepare(`
            SELECT * FROM attendance 
            WHERE employee_uid = ? AND date = ? AND is_synced = 0
            ORDER BY clock_time ASC
          `).all(employeeUid, date);

          if (attendanceRecords.length > 0) {
            console.log(`   - Found ${attendanceRecords.length} attendance records to upload`);

            for (const record of attendanceRecords) {
              try {
                const uploadResult = await this.uploadAttendanceRecord(record);
                
                if (uploadResult.success) {
                  db.prepare(`
                    UPDATE attendance 
                    SET is_synced = 1 
                    WHERE id = ?
                  `).run(record.id);
                  
                  console.log(`   ✓ Uploaded attendance record ${record.id}`);
                }
              } catch (uploadError) {
                console.error(`   ✗ Failed to upload attendance ${record.id}:`, uploadError.message);
              }
            }
          }

          const summaryRecord = db.prepare(`
            SELECT * FROM daily_attendance_summary 
            WHERE employee_uid = ? AND date = ?
          `).get(employeeUid, date);

          if (summaryRecord) {
            console.log(`   - Uploading regenerated summary`);

            try {
              const summaryUpload = await this.uploadSummaryRecord(summaryRecord);
              
              if (summaryUpload.success) {
                db.prepare(`
                  UPDATE daily_attendance_summary 
                  SET is_synced = 1 
                  WHERE employee_uid = ? AND date = ?
                `).run(employeeUid, date);
                
                console.log(`   ✓ Uploaded summary for ${employeeUid} on ${date}`);
              }
            } catch (summaryError) {
              console.error(`   ✗ Failed to upload summary:`, summaryError.message);
            }
          }

          this.emit('reupload-completed', {
            employeeUid,
            date,
            attendanceCount: attendanceRecords.length,
            summaryUploaded: !!summaryRecord
          });

          console.log(`✓ Re-upload complete for employee ${employeeUid} on ${date}`);

        } catch (error) {
          console.error(`❌ Re-upload failed for ${employeeUid} on ${date}:`, error);
          this.emit('reupload-error', {
            employeeUid,
            date,
            error: error.message
          });
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      }

      console.log(`✓ Re-upload queue processed`);

    } catch (error) {
      console.error('Re-upload queue processing error:', error);
    }
  }

  async uploadAttendanceRecord(record) {
    try {
      const { getSettings } = require('../api/routes/settings');
      const settings = await getSettings();

      if (!settings.success) {
        throw new Error('Settings not available');
      }

      const serverUrl = settings.data.server_url.replace('/api/employees', '');
      
      const response = await fetch(`${serverUrl}/api/attendance`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          employee_uid: record.employee_uid,
          id_number: record.id_number,
          clock_type: record.clock_type,
          clock_time: record.clock_time,
          regular_hours: record.regular_hours,
          overtime_hours: record.overtime_hours,
          date: record.date,
          is_late: record.is_late,
          created_at: record.created_at
        })
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Server returned ${response.status}: ${error}`);
      }

      const result = await response.json();
      return { success: true, data: result };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * ✅ NEW: Upload single summary record to server
   */
  async uploadSummaryRecord(record) {
    try {
      const { getSettings } = require('../api/routes/settings');
      const settings = await getSettings();

      if (!settings.success) {
        throw new Error('Settings not available');
      }

      const serverUrl = settings.data.server_url.replace('/api/employees', '');
      
      const response = await fetch(`${serverUrl}/api/daily-summary`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          employee_uid: record.employee_uid,
          id_number: record.id_number,
          employee_name: record.employee_name,
          first_name: record.first_name,
          last_name: record.last_name,
          department: record.department,
          date: record.date,
          first_clock_in: record.first_clock_in,
          last_clock_out: record.last_clock_out,
          morning_in: record.morning_in,
          morning_out: record.morning_out,
          afternoon_in: record.afternoon_in,
          afternoon_out: record.afternoon_out,
          evening_in: record.evening_in,
          evening_out: record.evening_out,
          overtime_in: record.overtime_in,
          overtime_out: record.overtime_out,
          regular_hours: record.regular_hours,
          overtime_hours: record.overtime_hours,
          total_hours: record.total_hours,
          morning_hours: record.morning_hours,
          afternoon_hours: record.afternoon_hours,
          evening_hours: record.evening_hours,
          overtime_session_hours: record.overtime_session_hours,
          is_incomplete: record.is_incomplete,
          has_late_entry: record.has_late_entry,
          has_overtime: record.has_overtime
        })
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Server returned ${response.status}: ${error}`);
      }

      const result = await response.json();
      return { success: true, data: result };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Employee event handler (unchanged)
   */
  async handleEmployeeEvent(eventType, data, db) {
    try {
      const Employee = require('../database/models/employee');
      
      switch (eventType) {
        case 'employee_created':
          console.log('👤 New employee created:', data.id);
          this.emit('employee-created', data);
          await Employee.refreshCache();
          break;

        case 'employee_updated':
          console.log('✏️ Employee updated:', data.id);
          this.emit('employee-updated', data);
          await Employee.refreshCache();
          break;

        case 'employee_deleted':
          console.log('🗑️ Employee deleted:', data.id);
          this.emit('employee-deleted', data);
          await Employee.refreshCache();
          break;

        case 'employee_status_changed':
          console.log('📊 Employee status changed:', data.id);
          this.emit('employee-status-changed', data);
          await Employee.refreshCache();
          break;

        case 'employee_bulk_deleted':
          console.log('🗑️ Bulk employee deletion:', data.deleted_count);
          this.emit('employee-bulk-deleted', data);
          await Employee.refreshCache();
          break;

        case 'employee_password_changed':
          console.log('🔒 Employee password changed:', data.id);
          this.emit('employee-password-changed', data);
          break;

        case 'employee_fcm_token_registered':
          console.log('📱 FCM token registered:', data.employee_id);
          this.emit('employee-fcm-token-registered', data);
          break;

        case 'employee_fcm_token_unregistered':
          console.log('📱 FCM token unregistered:', data.employee_id);
          this.emit('employee-fcm-token-unregistered', data);
          break;
      }

    } catch (error) {
      console.error(`Error handling employee event ${eventType}:`, error);
      throw error;
    }
  }

  async downloadAndInsertAttendance(eventType, eventData, db) {
  try {
    console.log(`📥 Downloading attendance data from server...`);
    
    const { getSettings } = require('../api/routes/settings');
    const settings = await getSettings();

    if (!settings.success) {
      throw new Error('Settings not available');
    }

    const serverUrl = settings.data.server_url.replace('/api/employees', '');
    
    let attendanceId = eventData.id || eventData.attendance_id;
    let attendanceRecord;
    
    if (attendanceId) {
      console.log(`Fetching attendance record ${attendanceId} from server...`);
      
      const response = await fetch(`${serverUrl}/api/attendance/${attendanceId}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch attendance ${attendanceId}: ${response.status}`);
      }

      const result = await response.json();
      attendanceRecord = result.data || result;
      
    } else {
      console.warn('No ID in event data, using event data directly');
      attendanceRecord = eventData;
    }

    if (!attendanceRecord) {
      throw new Error('No attendance record data received');
    }

    // ✅ FIX: Format clock_time properly
    let formattedClockTime = attendanceRecord.clock_time;
    
    if (formattedClockTime && attendanceRecord.date) {
      // Check if clock_time is just time (HH:MM:SS or HH:MM:SS.mmm)
      if (/^\d{2}:\d{2}:\d{2}/.test(formattedClockTime) && !formattedClockTime.includes('T')) {
        // It's just time, combine with date
        const timeOnly = formattedClockTime.trim();
        
        // Ensure milliseconds
        const timeParts = timeOnly.split('.');
        const milliseconds = timeParts[1] ? timeParts[1].substring(0, 3).padEnd(3, '0') : '000';
        const timeWithMs = timeParts[0] + '.' + milliseconds;
        
        // Combine date and time: YYYY-MM-DDTHH:MM:SS.mmm
        formattedClockTime = `${attendanceRecord.date}T${timeWithMs}`;
        
        console.log(`✓ Combined date+time: ${attendanceRecord.date} + ${timeOnly} -> ${formattedClockTime}`);
      } else {
        // It's already a full datetime, just format it
        formattedClockTime = formattedClockTime
          .replace('Z', '')
          .replace(/[+-]\d{2}:\d{2}$/, '')
          .trim();
        
        // Ensure milliseconds
        if (!formattedClockTime.includes('.')) {
          formattedClockTime += '.000';
        } else {
          const parts = formattedClockTime.split('.');
          if (parts[1]) {
            parts[1] = parts[1].substring(0, 3).padEnd(3, '0');
            formattedClockTime = parts.join('.');
          }
        }
        
        console.log(`✓ Formatted datetime: ${attendanceRecord.clock_time} -> ${formattedClockTime}`);
      }
    }

    console.log(`✓ Downloaded attendance record:`, {
      id: attendanceRecord.id,
      employee_uid: attendanceRecord.employee_uid,
      date: attendanceRecord.date,
      clock_type: attendanceRecord.clock_type,
      original_clock_time: attendanceRecord.clock_time,
      formatted_clock_time: formattedClockTime
    });

    // ✅ Insert or update in local database with formatted time
    const insertStmt = db.prepare(`
      INSERT INTO attendance (
        id, employee_uid, id_number, scanned_barcode, clock_type, 
        clock_time, regular_hours, overtime_hours, date, is_late, 
        is_synced, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        employee_uid = excluded.employee_uid,
        id_number = excluded.id_number,
        scanned_barcode = excluded.scanned_barcode,
        clock_type = excluded.clock_type,
        clock_time = excluded.clock_time,
        regular_hours = excluded.regular_hours,
        overtime_hours = excluded.overtime_hours,
        date = excluded.date,
        is_late = excluded.is_late,
        is_synced = excluded.is_synced
    `);

    insertStmt.run(
      attendanceRecord.id,
      attendanceRecord.employee_uid,
      attendanceRecord.id_number,
      attendanceRecord.scanned_barcode || attendanceRecord.id_barcode,
      attendanceRecord.clock_type,
      formattedClockTime,  // ✅ Use formatted time
      attendanceRecord.regular_hours || 0,
      attendanceRecord.overtime_hours || 0,
      attendanceRecord.date,
      attendanceRecord.is_late || 0,
      1, // Mark as synced since it came from server
      attendanceRecord.created_at || new Date().toISOString()
    );

    console.log(`✓ Inserted/updated attendance in local database with formatted clock_time`);

    // ✅ Emit event with hyphenated name
    this.emit('attendance-downloaded', {
      id: attendanceRecord.id,
      employee_uid: attendanceRecord.employee_uid,
      date: attendanceRecord.date,
      clock_type: attendanceRecord.clock_type,
      clock_time: formattedClockTime
    });

    return {
      success: true,
      record: {
        ...attendanceRecord,
        clock_time: formattedClockTime
      }
    };

  } catch (error) {
    console.error('Error downloading/inserting attendance:', error);
    this.emit('download-error', {
      eventType,
      error: error.message
    });
    
    return {
      success: false,
      error: error.message
    };
  }
}

  /**
   * Attendance event handler - SIMPLIFIED (removed, now handled in processEvents)
   */
  async handleAttendanceEvent(eventType, data, db) {
    try {
      switch (eventType) {
        case 'attendance_created':
        case 'attendance_updated':
        case 'attendance_update':
          console.log('📋 Attendance changed:', data.id || 'unknown');
          this.emit('attendance-changed', data);
          break;

        case 'attendance_deleted':
          console.log('🗑️ Attendance deleted:', data.id || 'unknown');
          this.emit('attendance-deleted', data);
          
          // Delete from local database
          if (data.id) {
            db.prepare('DELETE FROM attendance WHERE id = ?').run(data.id);
            console.log(`✓ Deleted attendance ${data.id} from local database`);
          }
          break;

        case 'attendance_synced':
          console.log('🔄 Attendance synced');
          this.emit('attendance-synced', data);
          break;
      }

    } catch (error) {
      console.error(`Error handling attendance event ${eventType}:`, error);
      throw error;
    }
  }

  /**
   * Summary event handler (unchanged)
   */
  async handleSummaryEvent(eventType, data, db) {
    try {
      switch (eventType) {
        case 'daily_summary_synced':
          console.log('📊 Summary synced');
          this.emit('summary-synced', data);
          break;

        case 'daily_summary_deleted':
          console.log('🗑️ Summary deleted');
          this.emit('summary-deleted', data);
          break;

        case 'daily_summary_rebuilt':
          console.log('🔄 Summary rebuilt');
          this.emit('summary-rebuilt', data);
          break;

        case 'daily_summary_created':
          console.log('✅ Summary created');
          this.emit('summary-created', data);
          break;

        case 'daily_summary_updated':
          console.log('🔄 Summary updated');
          this.emit('summary-updated', data);
          break;
      }

    } catch (error) {
      console.error(`Error handling summary event ${eventType}:`, error);
      throw error;
    }
  }

  /**
   * Error handler (unchanged)
   */
  handlePollingError(error) {
    this.emit('polling-error', {
      error: error.message,
      timestamp: new Date().toISOString(),
      reconnectAttempt: this.reconnectAttempts
    });
  }

  /**
   * ✅ ENHANCED: Get status with validation stats
   */
  getStatus() {
    return {
      isPolling: this.isPolling,
      healthCheckPassed: this.healthCheckPassed,
      serverUrl: this.serverUrl,
      pollingEndpoint: this.pollingEndpoint,
      lastEventTimestamp: this.lastEventTimestamp,
      reconnectAttempts: this.reconnectAttempts,
      subscribedEvents: this.subscribedEvents,
      autoValidateEnabled: this.autoValidateEnabled,
      autoReuploadEnabled: this.autoReuploadEnabled,
      validationQueue: this.validationQueue.size,
      reuploadQueue: this.reuploadQueue.size,
      isValidating: this.isValidating
    };
  }
}

module.exports = new PollingManager();