; The app writes its command-line launcher here on first start; take it away again on uninstall.
!macro customUnInstall
  Delete "$LOCALAPPDATA\Microsoft\WindowsApps\gdocs.cmd"
  Delete "$LOCALAPPDATA\Microsoft\WindowsApps\gauzzadocs.cmd"
!macroend
