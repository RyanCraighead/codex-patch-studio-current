using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

internal static class BootstrapLauncher
{
    private const uint MbIconError = 0x00000010;
    private const uint MbOk = 0x00000000;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(
        IntPtr windowHandle,
        string text,
        string caption,
        uint type);

    private static int Main()
    {
        try
        {
            string extractionRoot = AppDomain.CurrentDomain.BaseDirectory;
            string bootstrapPath = Path.Combine(extractionRoot, "bootstrap.ps1");
            if (!File.Exists(bootstrapPath))
            {
                throw new FileNotFoundException("Portable bootstrap script was not extracted.", bootstrapPath);
            }

            string powershellPath = Path.Combine(
                Environment.SystemDirectory,
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe");
            if (!File.Exists(powershellPath))
            {
                throw new FileNotFoundException("Windows PowerShell was not found.", powershellPath);
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = powershellPath,
                Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + bootstrapPath + "\"",
                WorkingDirectory = extractionRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            };

            using (Process process = Process.Start(startInfo))
            {
                if (process == null)
                {
                    throw new InvalidOperationException("Windows could not start the portable bootstrap process.");
                }
                process.WaitForExit();
                if (process.ExitCode != 0)
                {
                    throw new InvalidOperationException(
                        "Portable bootstrap exited with code " + process.ExitCode + ".");
                }
            }

            return 0;
        }
        catch (Exception error)
        {
            string logPath = WriteFailureLog(error);
            MessageBoxW(
                IntPtr.Zero,
                "Codex Patch Studio Current could not start.\n\n" +
                    error.Message + "\n\nDetails: " + logPath,
                "Codex Patch Studio Current",
                MbOk | MbIconError);
            return 1;
        }
    }

    private static string WriteFailureLog(Exception error)
    {
        try
        {
            string logRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "CodexPatchStudioCurrent",
                "logs");
            Directory.CreateDirectory(logRoot);
            string logPath = Path.Combine(logRoot, "portable-bootstrap-launcher.log");
            File.AppendAllText(
                logPath,
                "[" + DateTimeOffset.Now.ToString("o") + "] " + error + Environment.NewLine);
            return logPath;
        }
        catch
        {
            return "Unable to write the launcher log.";
        }
    }
}
