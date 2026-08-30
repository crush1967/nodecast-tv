Start-ScheduledTask -TaskName "NodeCastTV"
Start-Sleep -Seconds 3
Get-ScheduledTask -TaskName "NodeCastTV" | Get-ScheduledTaskInfo | Format-List
Write-Host "Started. Press Enter to close this window."
Read-Host
