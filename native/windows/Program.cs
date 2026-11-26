using System;
using System.Threading;
using System.Windows.Forms;

namespace WhisperAero;

internal static class Program
{
    public const string ActivateEventName = @"Global\WhisperAeroActivateEvent";

    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(true, @"Global\WhisperAeroSingleInstance", out var isNewInstance);
        if (!isNewInstance)
        {
            try
            {
                using var evt = EventWaitHandle.OpenExisting(ActivateEventName);
                evt.Set();
            }
            catch
            {
            }
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}
