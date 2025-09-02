# Employee Attendance System

A comprehensive Electron-based employee attendance recording system with barcode scanning, offline-first architecture, and real-time updates.

## Features

- **Barcode Scanning**: Support for Goojprt barcode scanners and manual ID entry
- **Offline-First**: Local SQLite database with server synchronization
- **Real-Time Updates**: WebSocket integration for live data updates
- **Time Tracking**: Automatic calculation of regular and overtime hours
- **Employee Management**: Complete employee database with photo support
- **Modern UI**: Clean, responsive interface with real-time clock
- **Settings Management**: Configurable server URL and sync intervals

## Installation

1. Clone the repository
2. Install dependencies:
   \`\`\`bash
   npm install
   \`\`\`

3. Start the application:
   \`\`\`bash
   npm start
   \`\`\`

## Building for Production

To create a Windows installer:

\`\`\`bash
npm run build
\`\`\`

The installer will be created in the `dist` folder.

## Configuration

1. Open Settings from the main menu
2. Configure your server URL (e.g., `http://192.168.1.71:3001/api/tables/emp_list/data`)
3. Set sync interval and grace period
4. Click "Sync Now" to fetch employee data

## Database Schema

### Employees Table
- uid (Primary Key)
- id_number (Unique)
- id_barcode (Unique)
- first_name, middle_name, last_name
- email, department, status
- profile_picture
- created_at, updated_at

### Attendance Table
- id (Auto-increment Primary Key)
- employee_uid (Foreign Key)
- clock_type (morning_in, morning_out, afternoon_in, afternoon_out)
- clock_time, regular_hours, overtime_hours
- date, is_synced
- created_at

## Working Hours

- **Standard Hours**: 8:00 AM - 5:00 PM (8-hour shift)
- **Morning Session**: 8:00 AM - 12:00 PM (4 hours)
- **Afternoon Session**: 1:00 PM - 5:00 PM (4 hours)
- **Grace Period**: 5 minutes (configurable)
- **Overtime**: Any time outside standard hours

## API Integration

The system expects employee data in this format:
\`\`\`json
{
  "uid": 123,
  "id_number": "EMP001",
  "id_barcode": "1234567890",
  "first_name": "John",
  "middle_name": "M",
  "last_name": "Doe",
  "email": "john.doe@company.com",
  "department": "IT",
  "status": "Active",
  "profile_picture": "http://example.com/photo.jpg"
}
\`\`\`

## Usage

1. **Employee Clock In/Out**: 
   - Scan barcode or enter ID number
   - System automatically determines clock type
   - Employee info displays for 15 seconds

2. **View Current Status**:
   - See currently clocked-in employees
   - View today's attendance activity

3. **Settings**:
   - Configure server connection
   - Adjust sync intervals
   - Set grace periods

## Troubleshooting

- **Connection Issues**: Check server URL in settings
- **Barcode Scanner**: Ensure scanner is configured for keyboard input
- **Database Issues**: Check data folder permissions
- **Sync Problems**: Verify server API format matches expected schema

## Development

- **Framework**: Electron with Node.js backend
- **Database**: better-sqlite3 for local storage
- **Real-time**: WebSocket server on port 8080
- **UI**: Vanilla HTML/CSS/JavaScript

## License

MIT License - see LICENSE file for details.
