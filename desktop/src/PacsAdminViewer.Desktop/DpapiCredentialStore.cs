using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PacsAdminViewer.Core.Security;

namespace PacsAdminViewer.Desktop;

/// <summary>
/// Saved passwords, encrypted with Windows DPAPI for the current Windows user: another user on
/// the same machine, or the same file copied elsewhere, can't decrypt them. Only used when the
/// user ticks "Remember password"; otherwise nothing is written.
/// </summary>
internal sealed class DpapiCredentialStore(string path) : ICredentialStore
{
    private static readonly byte[] Entropy = "PacsAdminViewer.credentials.v1"u8.ToArray();

    public string? Load(string key)
    {
        if (!Read().TryGetValue(key, out var protectedB64)) return null;
        try
        {
            var plain = ProtectedData.Unprotect(Convert.FromBase64String(protectedB64), Entropy, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(plain);
        }
        catch (Exception ex) when (ex is CryptographicException or FormatException)
        {
            return null; // e.g. copied from another Windows account — treat as not saved
        }
    }

    public void Save(string key, string secret)
    {
        var all = Read();
        var cipher = ProtectedData.Protect(Encoding.UTF8.GetBytes(secret), Entropy, DataProtectionScope.CurrentUser);
        all[key] = Convert.ToBase64String(cipher);
        Write(all);
    }

    public void Delete(string key)
    {
        var all = Read();
        if (all.Remove(key)) Write(all);
    }

    private Dictionary<string, string> Read()
    {
        try
        {
            return File.Exists(path)
                ? JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(path)) ?? []
                : [];
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    private void Write(Dictionary<string, string> all)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(all));
        File.Move(tmp, path, overwrite: true);
    }
}
