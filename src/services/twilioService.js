// services/twilioService.js
const twilio = require('twilio');

class TwilioService {
  constructor() {
    this.client = null;
    this.phoneNumber = null;
    this.isConfigured = false;
  }

  /**
   * Initialize Twilio client with credentials
   * @param {string} accountSid - Twilio Account SID
   * @param {string} authToken - Twilio Auth Token
   * @param {string} phoneNumber - Twilio Phone Number (format: +1234567890)
   */
  initialize(accountSid, authToken, phoneNumber) {
    try {
      if (!accountSid || !authToken || !phoneNumber) {
        console.error('Missing Twilio credentials');
        return false;
      }

      this.client = twilio(accountSid, authToken);
      this.phoneNumber = phoneNumber;
      this.isConfigured = true;
      
      console.log('✓ Twilio service initialized successfully');
      return true;
    } catch (error) {
      console.error('Error initializing Twilio:', error);
      this.isConfigured = false;
      return false;
    }
  }

  /**
   * Send SMS notification
   * @param {string} to - Recipient phone number
   * @param {string} message - SMS message content
   */
  async sendSMS(to, message) {
    if (!this.isConfigured) {
      console.warn('Twilio service not configured. SMS not sent.');
      return { success: false, error: 'Twilio not configured' };
    }

    try {
      // Validate phone number format
      if (!to || !to.startsWith('+')) {
        throw new Error('Invalid phone number format. Must start with + and country code');
      }

      const result = await this.client.messages.create({
        body: message,
        from: this.phoneNumber,
        to: to
      });

      console.log(`✓ SMS sent successfully to ${to} (SID: ${result.sid})`);
      return { 
        success: true, 
        messageSid: result.sid,
        status: result.status 
      };

    } catch (error) {
      console.error('Error sending SMS:', error);
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

  /**
   * Format clock in/out notification message
   * @param {object} data - Clock data
   */
  formatClockMessage(data) {
    const { 
      employee, 
      clockType, 
      sessionType, 
      clockTime, 
      regularHours, 
      overtimeHours,
      resolvedPendingClock,
      isNewClockIn 
    } = data;

    const name = `${employee.first_name} ${employee.last_name}`;
    const time = new Date(clockTime).toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: true 
    });
    const date = new Date(clockTime).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });

    // Clock In Message
    if (isNewClockIn) {
      return `Hello ${name}!\n\n` +
             `✓ Clock In: ${sessionType}\n` +
             `Time: ${time}\n` +
             `Date: ${date}\n\n` +
             `Have a productive ${sessionType.toLowerCase()} session!`;
    }

    // Clock Out Message
    const totalHours = (regularHours || 0) + (overtimeHours || 0);
    let message = `Hello ${name}!\n\n` +
                  `✓ Clock Out: ${sessionType}\n` +
                  `Time: ${time}\n` +
                  `Date: ${date}\n\n`;

    if (totalHours > 0) {
      message += `Hours Logged:\n`;
      if (regularHours > 0) {
        message += `- Regular: ${regularHours.toFixed(2)} hrs\n`;
      }
      if (overtimeHours > 0) {
        message += `- Overtime: ${overtimeHours.toFixed(2)} hrs\n`;
      }
      message += `Total: ${totalHours.toFixed(2)} hrs\n\n`;
    }

    if (resolvedPendingClock) {
      message += `(Completed pending session)\n\n`;
    }

    message += `Thank you for your hard work!`;

    return message;
  }

  /**
   * Send clock in/out notification to employee
   * @param {object} employee - Employee object with phone_number
   * @param {object} clockData - Clock in/out data
   */
  async sendClockNotification(employee, clockData) {
    if (!employee.phone_number) {
      console.warn(`No phone number for employee ${employee.uid}`);
      return { success: false, error: 'No phone number' };
    }

    const message = this.formatClockMessage({
      employee,
      ...clockData
    });

    return await this.sendSMS(employee.phone_number, message);
  }

  /**
   * Send bulk notifications
   * @param {array} notifications - Array of {employee, clockData} objects
   */
  async sendBulkNotifications(notifications) {
    const results = [];
    
    for (const { employee, clockData } of notifications) {
      const result = await this.sendClockNotification(employee, clockData);
      results.push({
        employeeUid: employee.uid,
        employeeName: `${employee.first_name} ${employee.last_name}`,
        ...result
      });
      
      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return results;
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      configured: this.isConfigured,
      phoneNumber: this.isConfigured ? this.phoneNumber : null
    };
  }
}

// Create singleton instance
const twilioService = new TwilioService();

module.exports = twilioService;