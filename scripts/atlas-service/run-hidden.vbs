' Runs the ATLAS supervisor with no window and waits for it, returning its exit code to Task Scheduler.
' A visible console could be closed by accident, and a paused console window blocks the supervisor's output.
' Usage: wscript.exe //B //Nologo run-hidden.vbs <program> [arguments...]
Set shell = CreateObject("WScript.Shell")
command = ""
For Each argument In WScript.Arguments
  command = command & " """ & argument & """"
Next
WScript.Quit shell.Run(Trim(command), 0, True)
