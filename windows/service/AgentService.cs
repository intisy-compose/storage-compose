using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace StorageCompose
{
    public static class Program
    {
        public static int Main(string[] arguments)
        {
            if (arguments.Length > 0 && arguments[0] == "run-as-user") return UserRelay.Run(arguments);
            ServiceBase.Run(new AgentService(arguments));
            return 0;
        }
    }

    /// <summary>
    /// Hosts the PowerShell agent (agent.ps1 beside this exe) as a Windows service: starts it, restarts it
    /// when it dies, and stops the service once the agent reports that it removed itself.
    /// </summary>
    /// <remarks>
    /// AutoLog is off because the event source it registers would outlive the service in the registry.
    /// </remarks>
    public class AgentService : ServiceBase
    {
        public const string Name = "storage-compose-agent";
        public const string StopSignalName = "Global\\storage-compose-agent-stop";
        const int RemovedItselfExitCode = 3;
        const int RestartDelayMilliseconds = 10000;
        const int StopWaitMilliseconds = 45000;

        readonly string[] agentArguments;
        readonly string folder;
        EventWaitHandle stopSignal;
        Thread supervisor;
        Process agent;
        volatile bool isStopping;

        public AgentService(string[] arguments)
        {
            ServiceName = Name;
            AutoLog = false;
            CanStop = true;
            CanShutdown = true;
            agentArguments = arguments;
            folder = Path.GetDirectoryName(typeof(AgentService).Assembly.Location);
        }

        protected override void OnStart(string[] startArguments)
        {
            stopSignal = new EventWaitHandle(false, EventResetMode.ManualReset, StopSignalName);
            stopSignal.Reset();
            supervisor = new Thread(Supervise);
            supervisor.IsBackground = true;
            supervisor.Start();
        }

        protected override void OnStop() { StopAgent(); }

        protected override void OnShutdown() { StopAgent(); }

        void Supervise()
        {
            while (!isStopping)
            {
                int exitCode = RunAgentOnce();
                if (isStopping) return;
                if (exitCode == RemovedItselfExitCode)
                {
                    Log("the agent removed the stack's traces; stopping the service");
                    isStopping = true;
                    Stop();
                    return;
                }
                Log("the agent exited with " + exitCode + "; restarting it in " + RestartDelayMilliseconds / 1000 + " s");
                if (stopSignal.WaitOne(RestartDelayMilliseconds)) return;
            }
        }

        int RunAgentOnce()
        {
            var start = new ProcessStartInfo("powershell.exe", AgentCommandLine());
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WorkingDirectory = folder;
            try { agent = Process.Start(start); }
            catch (Exception error) { Log("could not start the agent: " + error.Message); return -1; }
            agent.WaitForExit();
            return agent.ExitCode;
        }

        string AgentCommandLine()
        {
            var parts = new List<string> { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", Path.Combine(folder, "agent.ps1") };
            parts.AddRange(agentArguments);
            parts.Add("-StopSignal");
            parts.Add(StopSignalName);
            return CommandLine.Join(parts);
        }

        void StopAgent()
        {
            isStopping = true;
            if (stopSignal != null) stopSignal.Set();
            var running = agent;
            if (running == null || running.HasExited) return;
            RequestAdditionalTime(StopWaitMilliseconds + 5000);
            if (running.WaitForExit(StopWaitMilliseconds)) return;
            Log("the agent did not stop within " + StopWaitMilliseconds / 1000 + " s; ending it");
            try { running.Kill(); } catch (Exception) { }
        }

        void Log(string message)
        {
            try { File.AppendAllText(Path.Combine(folder, "service.log"), DateTime.Now.ToString("s") + " " + message + Environment.NewLine); }
            catch (Exception) { }
        }
    }

    public static class CommandLine
    {
        public static string Join(IEnumerable<string> arguments)
        {
            var line = new StringBuilder();
            foreach (var argument in arguments)
            {
                if (line.Length > 0) line.Append(' ');
                line.Append(Quote(argument));
            }
            return line.ToString();
        }

        /// <remarks>The rules of CommandLineToArgvW: backslashes are literal unless they precede a quote.</remarks>
        public static string Quote(string argument)
        {
            if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return argument;
            var quoted = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char character in argument)
            {
                if (character == '\\') { backslashes++; continue; }
                if (character == '"') quoted.Append('\\', backslashes * 2 + 1);
                else quoted.Append('\\', backslashes);
                backslashes = 0;
                quoted.Append(character);
            }
            quoted.Append('\\', backslashes * 2);
            quoted.Append('"');
            return quoted.ToString();
        }
    }

    /// <summary>
    /// <c>run-as-user &lt;sid&gt; &lt;timeout seconds&gt; [--env NAME=VALUE]... -- &lt;program&gt; [arguments]</c>:
    /// runs a program in a session of that user with the user's full (elevated) token, relays its output
    /// and returns its exit code.
    /// </summary>
    /// <remarks>
    /// WSL refuses LocalSystem (Wsl/WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED) and keeps one VM per user, so the
    /// pass-through must run as the user whose Docker Desktop holds the VM, while the service itself is
    /// SYSTEM so the nodes run before anyone logs in. Only a SYSTEM caller holds SeTcbPrivilege, which
    /// WTSQueryUserToken needs.
    /// </remarks>
    public static class UserRelay
    {
        public const int UserNotLoggedOn = 70;
        public const int RelayFailed = 71;
        public const int TimedOut = 72;

        public static int Run(string[] arguments)
        {
            try
            {
                var request = RelayRequest.Parse(arguments);
                EnablePrivileges();
                IntPtr userToken = FindUserToken(request.Sid);
                if (userToken == IntPtr.Zero)
                {
                    Console.Error.WriteLine("storage-compose-agent: " + request.Sid + " has no session on this computer");
                    return UserNotLoggedOn;
                }
                try { return RunWithToken(FullToken(userToken), request); }
                finally { Native.CloseHandle(userToken); }
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("storage-compose-agent: " + error.Message);
                return RelayFailed;
            }
        }

        static void EnablePrivileges()
        {
            IntPtr processToken;
            if (!Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TOKEN_ADJUST_PRIVILEGES | Native.TOKEN_QUERY, out processToken)) return;
            try
            {
                foreach (var name in new[] { "SeTcbPrivilege", "SeAssignPrimaryTokenPrivilege", "SeIncreaseQuotaPrivilege" })
                {
                    var privileges = new Native.TOKEN_PRIVILEGES { PrivilegeCount = 1, Attributes = Native.SE_PRIVILEGE_ENABLED };
                    if (!Native.LookupPrivilegeValue(null, name, out privileges.Luid)) continue;
                    Native.AdjustTokenPrivileges(processToken, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero);
                }
            }
            finally { Native.CloseHandle(processToken); }
        }

        static IntPtr FindUserToken(string sid)
        {
            IntPtr sessions;
            int count;
            if (!Native.WTSEnumerateSessions(IntPtr.Zero, 0, 1, out sessions, out count)) throw new Win32Exception();
            try
            {
                int size = Marshal.SizeOf(typeof(Native.WTS_SESSION_INFO));
                for (int index = 0; index < count; index++)
                {
                    var session = (Native.WTS_SESSION_INFO)Marshal.PtrToStructure(new IntPtr(sessions.ToInt64() + index * size), typeof(Native.WTS_SESSION_INFO));
                    IntPtr token;
                    if (!Native.WTSQueryUserToken(session.SessionId, out token)) continue;
                    if (string.Equals(TokenUserSid(token), sid, StringComparison.OrdinalIgnoreCase)) return token;
                    Native.CloseHandle(token);
                }
                return IntPtr.Zero;
            }
            finally { Native.WTSFreeMemory(sessions); }
        }

        static string TokenUserSid(IntPtr token)
        {
            IntPtr buffer = TokenInformation(token, Native.TokenUser);
            try
            {
                string sid;
                Native.ConvertSidToStringSid(Marshal.ReadIntPtr(buffer), out sid);
                return sid;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        static IntPtr TokenInformation(IntPtr token, int informationClass)
        {
            int length;
            Native.GetTokenInformation(token, informationClass, IntPtr.Zero, 0, out length);
            IntPtr buffer = Marshal.AllocHGlobal(Math.Max(length, IntPtr.Size));
            if (!Native.GetTokenInformation(token, informationClass, buffer, length, out length))
            {
                Marshal.FreeHGlobal(buffer);
                throw new Win32Exception();
            }
            return buffer;
        }

        /// <remarks>With UAC the session token is the filtered one; wsl --mount needs the linked, elevated token.</remarks>
        static IntPtr FullToken(IntPtr userToken)
        {
            IntPtr source = userToken;
            IntPtr elevation = TokenInformation(userToken, Native.TokenElevationType);
            bool isLimited = Marshal.ReadInt32(elevation) == Native.TokenElevationTypeLimited;
            Marshal.FreeHGlobal(elevation);
            if (isLimited)
            {
                IntPtr linked = TokenInformation(userToken, Native.TokenLinkedToken);
                source = Marshal.ReadIntPtr(linked);
                Marshal.FreeHGlobal(linked);
            }
            IntPtr primary;
            if (!Native.DuplicateTokenEx(source, Native.MAXIMUM_ALLOWED, IntPtr.Zero, Native.SecurityImpersonation, Native.TokenPrimary, out primary)) throw new Win32Exception();
            if (source != userToken) Native.CloseHandle(source);
            return primary;
        }

        static int RunWithToken(IntPtr token, RelayRequest request)
        {
            IntPtr environment = IntPtr.Zero;
            try
            {
                environment = EnvironmentBlock(token, request.Environment);
                SafeFileHandle outputRead, outputWrite;
                var security = new Native.SECURITY_ATTRIBUTES { Length = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES)), InheritHandle = true };
                if (!Native.CreatePipe(out outputRead, out outputWrite, ref security, 0)) throw new Win32Exception();
                Native.SetHandleInformation(outputRead, Native.HANDLE_FLAG_INHERIT, 0);
                var startup = new Native.STARTUPINFO();
                startup.Size = Marshal.SizeOf(typeof(Native.STARTUPINFO));
                startup.Desktop = "winsta0\\default";
                startup.Flags = Native.STARTF_USESTDHANDLES;
                startup.StdOutput = outputWrite.DangerousGetHandle();
                startup.StdError = outputWrite.DangerousGetHandle();
                Native.PROCESS_INFORMATION process;
                var commandLine = new StringBuilder(CommandLine.Join(request.Command));
                bool started = Native.CreateProcessAsUser(token, null, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                    Native.CREATE_NO_WINDOW | Native.CREATE_UNICODE_ENVIRONMENT, environment,
                    Environment.GetFolderPath(Environment.SpecialFolder.System), ref startup, out process);
                outputWrite.Dispose();
                if (!started) throw new Win32Exception();
                return RelayUntilExit(process, outputRead, request.TimeoutMilliseconds);
            }
            finally
            {
                if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
                Native.CloseHandle(token);
            }
        }

        static int RelayUntilExit(Native.PROCESS_INFORMATION process, SafeFileHandle outputRead, int timeoutMilliseconds)
        {
            var output = new FileStream(outputRead, FileAccess.Read);
            var standardOutput = Console.OpenStandardOutput();
            var reader = new Thread(() => { try { output.CopyTo(standardOutput); } catch (Exception) { } });
            reader.IsBackground = true;
            reader.Start();
            try
            {
                if (Native.WaitForSingleObject(process.Process, (uint)timeoutMilliseconds) != 0)
                {
                    Native.TerminateProcess(process.Process, TimedOut);
                    Console.Error.WriteLine("storage-compose-agent: the program did not finish within " + timeoutMilliseconds / 1000 + " s");
                    return TimedOut;
                }
                reader.Join(5000);
                standardOutput.Flush();
                uint exitCode;
                Native.GetExitCodeProcess(process.Process, out exitCode);
                return unchecked((int)exitCode);
            }
            finally
            {
                Native.CloseHandle(process.Process);
                Native.CloseHandle(process.Thread);
            }
        }

        static IntPtr EnvironmentBlock(IntPtr token, IDictionary<string, string> extra)
        {
            IntPtr userBlock;
            if (!Native.CreateEnvironmentBlock(out userBlock, token, false)) throw new Win32Exception();
            var variables = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                int offset = 0;
                while (true)
                {
                    string entry = Marshal.PtrToStringUni(new IntPtr(userBlock.ToInt64() + offset));
                    if (string.IsNullOrEmpty(entry)) break;
                    int separator = entry.IndexOf('=', 1);
                    if (separator > 0) variables[entry.Substring(0, separator)] = entry.Substring(separator + 1);
                    offset += (entry.Length + 1) * 2;
                }
            }
            finally { Native.DestroyEnvironmentBlock(userBlock); }
            foreach (var pair in extra) variables[pair.Key] = pair.Value;
            var block = new StringBuilder();
            foreach (var pair in variables) block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
            block.Append('\0');
            return Marshal.StringToHGlobalUni(block.ToString());
        }
    }

    public class RelayRequest
    {
        public string Sid;
        public int TimeoutMilliseconds;
        public Dictionary<string, string> Environment = new Dictionary<string, string>();
        public List<string> Command = new List<string>();

        public static RelayRequest Parse(string[] arguments)
        {
            if (arguments.Length < 5) throw new ArgumentException("usage: run-as-user <sid> <timeout seconds> [--env NAME=VALUE]... -- <program> [arguments]");
            var request = new RelayRequest { Sid = arguments[1], TimeoutMilliseconds = int.Parse(arguments[2]) * 1000 };
            int index = 3;
            for (; index < arguments.Length && arguments[index] != "--"; index++)
            {
                if (arguments[index] != "--env" || index + 1 >= arguments.Length) throw new ArgumentException("unknown option " + arguments[index]);
                string assignment = arguments[++index];
                int separator = assignment.IndexOf('=');
                if (separator < 1) throw new ArgumentException("--env needs NAME=VALUE, not " + assignment);
                request.Environment[assignment.Substring(0, separator)] = assignment.Substring(separator + 1);
            }
            for (index++; index < arguments.Length; index++) request.Command.Add(arguments[index]);
            if (request.Command.Count == 0) throw new ArgumentException("no program after --");
            return request;
        }
    }

    static class Native
    {
        public const uint TOKEN_ADJUST_PRIVILEGES = 0x20;
        public const uint TOKEN_QUERY = 0x8;
        public const uint SE_PRIVILEGE_ENABLED = 0x2;
        public const uint MAXIMUM_ALLOWED = 0x02000000;
        public const int SecurityImpersonation = 2;
        public const int TokenPrimary = 1;
        public const int TokenUser = 1;
        public const int TokenElevationType = 18;
        public const int TokenLinkedToken = 19;
        public const int TokenElevationTypeLimited = 3;
        public const uint HANDLE_FLAG_INHERIT = 1;
        public const int STARTF_USESTDHANDLES = 0x100;
        public const uint CREATE_NO_WINDOW = 0x08000000;
        public const uint CREATE_UNICODE_ENVIRONMENT = 0x400;

        [StructLayout(LayoutKind.Sequential)]
        public struct LUID { public uint LowPart; public int HighPart; }

        [StructLayout(LayoutKind.Sequential)]
        public struct TOKEN_PRIVILEGES { public uint PrivilegeCount; public LUID Luid; public uint Attributes; }

        [StructLayout(LayoutKind.Sequential)]
        public struct WTS_SESSION_INFO { public uint SessionId; public IntPtr WinStationName; public int State; }

        [StructLayout(LayoutKind.Sequential)]
        public struct SECURITY_ATTRIBUTES { public int Length; public IntPtr SecurityDescriptor; public bool InheritHandle; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO
        {
            public int Size; public string Reserved; public string Desktop; public string Title;
            public int X; public int Y; public int XSize; public int YSize; public int XCountChars; public int YCountChars;
            public int FillAttribute; public int Flags; public short ShowWindow; public short Reserved2; public IntPtr Reserved3;
            public IntPtr StdInput; public IntPtr StdOutput; public IntPtr StdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION { public IntPtr Process; public IntPtr Thread; public int ProcessId; public int ThreadId; }

        [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, ref SECURITY_ATTRIBUTES attributes, int size);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool LookupPrivilegeValue(string system, string name, out LUID luid);
        [DllImport("advapi32.dll", SetLastError = true)] public static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TOKEN_PRIVILEGES state, int length, IntPtr previous, IntPtr returnLength);
        [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr information, int length, out int returnLength);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool ConvertSidToStringSid(IntPtr sid, out string text);
        [DllImport("advapi32.dll", SetLastError = true)] public static extern bool DuplicateTokenEx(IntPtr existing, uint access, IntPtr attributes, int level, int type, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcessAsUser(IntPtr token, string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
            bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION information);
        [DllImport("userenv.dll", SetLastError = true)] public static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);
        [DllImport("userenv.dll", SetLastError = true)] public static extern bool DestroyEnvironmentBlock(IntPtr environment);
        [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr sessions, out int count);
        [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr memory);
        [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);
    }
}
