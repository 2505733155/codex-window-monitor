using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

internal static class CodexRelayLauncher
{
    private static string Quote(string value)
    {
        var quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            quoted.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            quoted.Append(character);
            slashes = 0;
        }
        return quoted.Append('\\', slashes * 2).Append('"').ToString();
    }

    private static async Task Pump(Stream source, Stream destination)
    {
        var buffer = new byte[8192];
        int count;
        while ((count = await source.ReadAsync(buffer, 0, buffer.Length)) > 0)
        {
            await destination.WriteAsync(buffer, 0, count);
            await destination.FlushAsync();
        }
    }

    public static int Main(string[] args)
    {
        try
        {
            string folder = AppDomain.CurrentDomain.BaseDirectory;
            string node = File.ReadAllText(Path.Combine(folder, "node.path")).Trim();
            string script = Path.Combine(folder, "codex-relay.cjs");
            var settings = new ProcessStartInfo(node, String.Join(" ", new[] { Quote(script) }.Concat(args.Select(Quote))));
            settings.UseShellExecute = false;
            settings.CreateNoWindow = true;
            settings.RedirectStandardInput = true;
            settings.RedirectStandardOutput = true;
            settings.RedirectStandardError = true;
            using (var child = Process.Start(settings))
            {
                Task.Run(async () =>
                {
                    try { await Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); }
                    finally { child.StandardInput.Close(); }
                });
                Task.WaitAll(Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()),
                             Pump(child.StandardError.BaseStream, Console.OpenStandardError()));
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Codex monitor relay: " + error.Message);
            return 1;
        }
    }
}
