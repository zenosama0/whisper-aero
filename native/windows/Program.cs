using System;
using System.Threading;
using System.Windows.Forms;

namespace WhisperAero;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(true, @"Global\WhisperAeroSingleInstance", out var isNewInstance);
        if (!isNewInstance)
        {
            MessageBox.Show(
                "Whisper is already running. Check your system tray if the window is minimized.",
                "Whisper",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}
