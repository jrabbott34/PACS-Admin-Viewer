using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;
using PacsAdminViewer.Core.Logging;

namespace PacsAdminViewer.Desktop;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        try
        {
            Services.Init();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"PACS Admin Viewer couldn't create its settings or log folders:\n\n{ex.Message}",
                "PACS Admin Viewer", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
            return;
        }

        Services.Log.Info($"Starting PACS Admin Viewer {AppInfo.Version} on {Environment.OSVersion}");
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            Services.Log.Error("Unhandled exception", args.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            Services.Log.Warn("Unobserved task exception", args.Exception);
            args.SetObserved();
        };

        var main = new MainWindow();
        MainWindow = main;
        main.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        Services.Log?.Info("Exiting");
        base.OnExit(e);
    }

    private static void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        // Log and keep running: one failed click shouldn't take the whole window (and the
        // images someone is looking at) down with it.
        Services.Log.Error("Unhandled UI exception", e.Exception);
        MessageBox.Show($"Something went wrong: {e.Exception.Message}\n\nDetails were written to the log (Logs button).",
            "PACS Admin Viewer", MessageBoxButton.OK, MessageBoxImage.Warning);
        e.Handled = true;
    }
}
