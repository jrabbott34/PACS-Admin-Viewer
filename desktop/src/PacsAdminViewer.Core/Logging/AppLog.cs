using System.Globalization;
using System.Text;

namespace PacsAdminViewer.Core.Logging;

public enum LogLevel { Info, Warn, Error }

public interface IAppLog
{
    void Write(LogLevel level, string message, Exception? ex = null);
}

public static class AppLogExtensions
{
    public static void Info(this IAppLog log, string message) => log.Write(LogLevel.Info, message);
    public static void Warn(this IAppLog log, string message, Exception? ex = null) => log.Write(LogLevel.Warn, message, ex);
    public static void Error(this IAppLog log, string message, Exception? ex = null) => log.Write(LogLevel.Error, message, ex);
}

/// <summary>
/// Daily log files (app-yyyyMMdd.log), kept for <see cref="RetentionDays"/> days.
///
/// House rule for every caller: log archive resource IDs, counts, status codes and server
/// addresses — never passwords, Authorization headers, or patient identifiers (names, IDs,
/// accession numbers). Logs get attached to support tickets; PHI and secrets must not ride along.
/// </summary>
public sealed class FileAppLog : IAppLog
{
    public const int RetentionDays = 14;
    private readonly object _gate = new();
    private readonly Func<DateTime> _now;

    public FileAppLog(string directory, Func<DateTime>? now = null)
    {
        Directory = directory;
        _now = now ?? (() => DateTime.Now);
        System.IO.Directory.CreateDirectory(directory);
        Prune();
    }

    public string Directory { get; }

    public string CurrentFile => Path.Combine(Directory, $"app-{_now():yyyyMMdd}.log");

    public void Write(LogLevel level, string message, Exception? ex = null)
    {
        var line = new StringBuilder()
            .Append(_now().ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture))
            .Append(' ').Append(level.ToString().ToUpperInvariant().PadRight(5))
            .Append(' ').Append(message);
        if (ex is not null) line.Append(" | ").Append(ex.GetType().Name).Append(": ").Append(ex.Message);
        line.AppendLine();
        try
        {
            lock (_gate) File.AppendAllText(CurrentFile, line.ToString());
        }
        catch (IOException)
        {
            // Logging must never take the app down.
        }
    }

    private void Prune()
    {
        var cutoff = _now().Date.AddDays(-RetentionDays);
        foreach (var file in System.IO.Directory.EnumerateFiles(Directory, "app-*.log"))
        {
            var stamp = Path.GetFileNameWithoutExtension(file)["app-".Length..];
            if (DateTime.TryParseExact(stamp, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day) && day < cutoff)
            {
                try { File.Delete(file); } catch (IOException) { }
            }
        }
    }
}
