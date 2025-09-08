; Custom installer script for Employee Attendance System

; Add custom pages or modify installer behavior here
!macro customInstall
  ; Create additional shortcuts or perform custom installation tasks
  WriteRegStr HKCU "Software\Employee Attendance System" "InstallPath" "$INSTDIR"
!macroend

!macro customUnInstall
  ; Clean up custom registry entries
  DeleteRegKey HKCU "Software\Employee Attendance System"
!macroend

; Custom installer welcome page text
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TEXT "This wizard will guide you through the installation of Employee Attendance System.$\r$\n$\r$\nThis application helps manage employee attendance with barcode scanning capabilities.$\r$\n$\r$\nClick Next to continue."
!macroend