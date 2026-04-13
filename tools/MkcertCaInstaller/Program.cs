using System.Diagnostics;
using System.Security.Principal;

// Build (eine EXE, kein .NET auf Ziel-PC nötig):
//   cd tools\MkcertCaInstaller
//   dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true
// Ausgabe: bin\Release\net8.0-windows\win-x64\publish\MkcertCaInstaller.exe
//
// Aufruf (als Administrator):
//   MkcertCaInstaller.exe https://10.0.0.180/mkcert-root.pem
// Oder Umgebungsvariable MKCERT_CA_URL setzen.
//
// Hinweis: Für HTTPS ist das Serverzertifikat beim ersten Abruf noch nicht vertrauenswürdig.
// Dieses Tool deaktiviert die TLS-Serverprüfung nur für den Download der Stamm-CA (Bootstrap).

namespace MkcertCaInstaller;

internal static class Program
{
    private const string DefaultUrl = "https://10.0.0.180/mkcert-root.pem";

    private static bool IsAdministrator()
    {
        try
        {
            using var id = WindowsIdentity.GetCurrent();
            var p = new WindowsPrincipal(id);
            return p.IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch
        {
            return false;
        }
    }

    private static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;

        if (!IsAdministrator())
        {
            Console.Error.WriteLine("Bitte als Administrator ausführen (Rechtsklick → Als Administrator ausführen).");
            return 1;
        }

        var url = Environment.GetEnvironmentVariable("MKCERT_CA_URL");
        if (string.IsNullOrWhiteSpace(url))
            url = args.Length > 0 ? args[0].Trim() : DefaultUrl;

        if (string.IsNullOrWhiteSpace(url) || !Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            Console.Error.WriteLine("Ungültige URL. Aufruf: MkcertCaInstaller.exe <https://server/pfad/rootCA.pem>");
            return 1;
        }

        Console.WriteLine("URL: " + uri);

        var tmp = Path.Combine(Path.GetTempPath(), "mkcert-rootca-" + Guid.NewGuid().ToString("N") + ".pem");

        try
        {
            using var handler = new HttpClientHandler();
            handler.ServerCertificateCustomValidationCallback = static (_, _, _, _) => true;

            using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(60) };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("MkcertCaInstaller/1.0");

            Console.WriteLine("Lade Zertifikat …");
            await using (var fs = File.Create(tmp))
            {
                await using var resp = await client.GetStreamAsync(uri);
                await resp.CopyToAsync(fs);
            }

            if (new FileInfo(tmp).Length < 200)
            {
                Console.Error.WriteLine("Heruntergeladene Datei ist zu klein – prüfen Sie die URL (evtl. HTML-Fehlerseite).");
                return 1;
            }

            var head = await File.ReadAllTextAsync(tmp);
            if (!head.Contains("BEGIN CERTIFICATE", StringComparison.Ordinal))
            {
                Console.Error.WriteLine("Kein PEM-Zertifikat erkannt (BEGIN CERTIFICATE fehlt).");
                return 1;
            }

            Console.WriteLine("Installiere in \"Vertrauenswuerdige Stammzertifizierungsstellen\" (ROOT-Store) ...");

            var psi = new ProcessStartInfo
            {
                FileName = "certutil.exe",
                ArgumentList = { "-addstore", "-f", "ROOT", tmp },
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };

            using var p = Process.Start(psi);
            if (p is null)
            {
                Console.Error.WriteLine("certutil.exe konnte nicht gestartet werden.");
                return 1;
            }

            var stdout = await p.StandardOutput.ReadToEndAsync();
            var stderr = await p.StandardError.ReadToEndAsync();
            await p.WaitForExitAsync();

            if (!string.IsNullOrWhiteSpace(stdout))
                Console.WriteLine(stdout.TrimEnd());
            if (!string.IsNullOrWhiteSpace(stderr))
                Console.Error.WriteLine(stderr.TrimEnd());

            if (p.ExitCode != 0)
            {
                Console.Error.WriteLine("certutil ExitCode: " + p.ExitCode);
                return p.ExitCode;
            }

            Console.WriteLine("Fertig. Edge/Firefox vollständig schließen und neu starten.");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("Fehler: " + ex.Message);
            return 1;
        }
        finally
        {
            try
            {
                if (File.Exists(tmp))
                    File.Delete(tmp);
            }
            catch { /* ignore */ }
        }
    }
}
