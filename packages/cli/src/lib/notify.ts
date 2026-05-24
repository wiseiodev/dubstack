import { platform } from 'node:os';
import { execa } from './exec';

export interface DesktopNotification {
  title: string;
  message: string;
}

/**
 * Best-effort desktop notification. Uses the platform's built-in tool —
 * `osascript` on macOS, `notify-send` on Linux, PowerShell `msg`-style toast
 * on Windows — so the CLI does not pull in a native-binding dependency.
 *
 * Returns `true` when the underlying tool exited cleanly. Any failure (tool
 * missing, no DBus session, etc.) is swallowed and returns `false`; the
 * watcher should keep running rather than crash on a notification failure.
 */
export async function notify(
  notification: DesktopNotification,
  options: { platform?: NodeJS.Platform } = {},
): Promise<boolean> {
  const os = options.platform ?? platform();
  try {
    if (os === 'darwin') {
      const escapedTitle = escapeAppleScript(notification.title);
      const escapedMessage = escapeAppleScript(notification.message);
      await execa('osascript', [
        '-e',
        `display notification "${escapedMessage}" with title "${escapedTitle}"`,
      ]);
      return true;
    }
    if (os === 'linux') {
      await execa('notify-send', [notification.title, notification.message]);
      return true;
    }
    if (os === 'win32') {
      // PowerShell BurntToast is not guaranteed; fall back to balloon-tip via
      // System.Windows.Forms. Best-effort only.
      //
      // Title/message can contain `$`, backticks, or `$(...)` that PowerShell
      // would otherwise interpret as expressions. We base64-encode the whole
      // script via `-EncodedCommand`, with the strings hex-escaped inside a
      // PowerShell `[char]`-built literal, so no user content reaches the
      // PowerShell parser as code.
      const script =
        'Add-Type -AssemblyName System.Windows.Forms; ' +
        '$n = New-Object System.Windows.Forms.NotifyIcon; ' +
        '$n.Icon = [System.Drawing.SystemIcons]::Information; ' +
        '$n.Visible = $true; ' +
        `$n.ShowBalloonTip(5000, ${toPowerShellLiteral(notification.title)}, ` +
        `${toPowerShellLiteral(notification.message)}, ` +
        '[System.Windows.Forms.ToolTipIcon]::Info);';
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      await execa('powershell', ['-NoProfile', '-EncodedCommand', encoded]);
      return true;
    }
  } catch {
    // Notification failure is non-fatal — watch keeps running.
    return false;
  }
  return false;
}

function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Renders a string as a PowerShell expression that evaluates to the literal
 * text, regardless of what characters the input contains. Each character is
 * emitted as `[char]<codepoint>` and concatenated with `+`. Empty input
 * collapses to an empty string literal so PowerShell doesn't see a bare `+`.
 */
function toPowerShellLiteral(text: string): string {
  if (!text) return "''";
  const parts: string[] = [];
  for (const ch of text) {
    // Iterating with `for..of` yields full code points; PowerShell's
    // `[char]` only handles the BMP. For supplementary planes fall back
    // to a surrogate pair so the script remains parseable.
    const cp = ch.codePointAt(0) ?? 0;
    if (cp > 0xffff) {
      const high = 0xd800 + ((cp - 0x10000) >> 10);
      const low = 0xdc00 + ((cp - 0x10000) & 0x3ff);
      parts.push(`[char]${high}+[char]${low}`);
    } else {
      parts.push(`[char]${cp}`);
    }
  }
  return parts.join('+');
}
